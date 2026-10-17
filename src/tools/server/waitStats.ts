import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

// Benign/idle background waits to exclude (Brent Ozar's First Responder Kit ignore list).
const IGNORED_WAITS = `
  'BROKER_EVENTHANDLER','BROKER_RECEIVE_WAITFOR','BROKER_TASK_STOP','BROKER_TO_FLUSH',
  'BROKER_TRANSMITTER','CHECKPOINT_QUEUE','CHKPT','CLR_AUTO_EVENT','CLR_MANUAL_EVENT',
  'CLR_SEMAPHORE','DBMIRROR_DBM_EVENT','DBMIRROR_EVENTS_QUEUE','DBMIRROR_WORKER_QUEUE',
  'DBMIRRORING_CMD','DIRTY_PAGE_POLL','DISPATCHER_QUEUE_SEMAPHORE','EXECSYNC',
  'FSAGENT','FT_IFTS_SCHEDULER_IDLE_WAIT','FT_IFTSHC_MUTEX','HADR_CLUSAPI_CALL',
  'HADR_FILESTREAM_IOMGR_IOCOMPLETION','HADR_LOGCAPTURE_WAIT','HADR_NOTIFICATION_DEQUEUE',
  'HADR_TIMER_TASK','HADR_WORK_QUEUE','KSOURCE_WAKEUP','LAZYWRITER_SLEEP','LOGMGR_QUEUE',
  'MEMORY_ALLOCATION_EXT','ONDEMAND_TASK_QUEUE','PARALLEL_REDO_DRAIN_WORKER',
  'PARALLEL_REDO_LOG_CACHE','PARALLEL_REDO_TRAN_LIST','PARALLEL_REDO_WORKER_SYNC',
  'PARALLEL_REDO_WORKER_WAIT_WORK','PREEMPTIVE_XE_GETTARGETSTATE',
  'PWAIT_ALL_COMPONENTS_INITIALIZED','PWAIT_DIRECTLOGCONSUMER_GETNEXT',
  'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE',
  'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP','QDS_SHUTDOWN_QUEUE',
  'REDO_THREAD_PENDING_WORK','REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE',
  'SERVER_IDLE_CHECK','SLEEP_BPOOL_FLUSH','SLEEP_DBSTARTUP','SLEEP_DCOMSTARTUP',
  'SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED','SLEEP_MSDBSTARTUP',
  'SLEEP_SYSTEMTASK','SLEEP_TASK','SLEEP_TEMPDBSTARTUP','SNI_HTTP_ACCEPT',
  'SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
  'SQLTRACE_WAIT_ENTRIES','WAIT_FOR_RESULTS','WAITFOR','WAITFOR_TASKSHUTDOWN',
  'WAIT_XTP_RECOVERY','WAIT_XTP_HOST_WAIT','WAIT_XTP_OFFLINE_CKPT_NEW_LOG',
  'WAIT_XTP_CKPT_CLOSE','XE_DISPATCHER_JOIN','XE_DISPATCHER_WAIT','XE_TIMER_EVENT'`;

// Shared projection over a derived [Waits] CTE (columns: wait_type, wait_time_ms,
// signal_wait_time_ms, waiting_tasks_count).
function selectClause(topN: number, minWaitMs: number): string {
  return `
SELECT TOP (${topN})
  wait_type                                                                          AS [Wait Type],
  CAST(wait_time_ms / 1000.0 AS DECIMAL(18,1))                                       AS [Wait Sec],
  CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER (), 0) AS DECIMAL(5,1))  AS [Pct of Total],
  waiting_tasks_count                                                                AS [Wait Count],
  CAST(wait_time_ms * 1.0 / NULLIF(waiting_tasks_count, 0) AS DECIMAL(18,1))         AS [Avg Wait ms],
  CAST(100.0 * signal_wait_time_ms / NULLIF(wait_time_ms, 0) AS DECIMAL(5,1))        AS [Signal (CPU) Wait Pct]
FROM [Waits]
WHERE waiting_tasks_count > 0
  AND wait_time_ms >= ${minWaitMs}
ORDER BY wait_time_ms DESC;`;
}

export function waitStatsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_wait_stats',
    title: 'Get Wait Statistics',
    description:
      'Wait statistics: the top wait types (what the server waits on: CPU, I/O, locks, memory), each as % of all waits, with average wait and signal (CPU) %. Idle waits are excluded. sampleSeconds=0 (default): since the last restart. sampleSeconds=5: only waits during a 5-second sample, the "what is slow right now" view.',
    alwaysLoad: true,
    inputSchema: {
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Number of wait types to return (1–100).'),
      minWaitMs: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Minimum wait time in milliseconds for a wait type to be included.'),
      sampleSeconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .default(0)
        .describe(
          'Live sampling window in seconds. 0 = cumulative since restart. >0 = blocks for this many seconds and reports only waits accrued during the interval; use 5 for a live "right now" snapshot (matches sp_BlitzFirst). Must be below REQUEST_TIMEOUT (default 30s) or the call times out.'
        ),
    },
    handler: async ({
      topN = 20,
      minWaitMs = 0,
      sampleSeconds = 0,
    }: {
      topN?: number;
      minWaitMs?: number;
      sampleSeconds?: number;
    }) => {
      let query: string;

      if (sampleSeconds > 0) {
        // Snapshot -> WAITFOR DELAY -> re-snapshot -> diff. Local temp table is
        // session-scoped and auto-dropped at batch end; defensive drop guards pool reuse.
        query = `
IF OBJECT_ID('tempdb..#ws_snapshot') IS NOT NULL DROP TABLE #ws_snapshot;
SELECT wait_type, wait_time_ms, signal_wait_time_ms, waiting_tasks_count
INTO #ws_snapshot
FROM sys.dm_os_wait_stats;

DECLARE @delay CHAR(8) = CONVERT(CHAR(8), DATEADD(SECOND, ${sampleSeconds}, 0), 108);
WAITFOR DELAY @delay;

WITH [Waits] AS (
  SELECT
    w2.wait_type,
    w2.wait_time_ms        - ISNULL(w1.wait_time_ms, 0)        AS wait_time_ms,
    w2.signal_wait_time_ms - ISNULL(w1.signal_wait_time_ms, 0) AS signal_wait_time_ms,
    w2.waiting_tasks_count - ISNULL(w1.waiting_tasks_count, 0) AS waiting_tasks_count
  FROM sys.dm_os_wait_stats AS w2
  LEFT JOIN #ws_snapshot AS w1 ON w1.wait_type = w2.wait_type
  WHERE w2.wait_type NOT IN (${IGNORED_WAITS})
)${selectClause(topN, minWaitMs)}`;
      } else {
        query = `
WITH [Waits] AS (
  SELECT wait_type, wait_time_ms, signal_wait_time_ms, waiting_tasks_count
  FROM sys.dm_os_wait_stats
  WHERE wait_type NOT IN (${IGNORED_WAITS})
)${selectClause(topN, minWaitMs)}`;
      }

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return sampleSeconds > 0
          ? `No significant waits accrued during the ${sampleSeconds}s sample — the instance was effectively idle.`
          : 'No significant waits recorded. Wait stats may have been recently reset.';
      return toMarkdownTable(result);
    },
  };
}
