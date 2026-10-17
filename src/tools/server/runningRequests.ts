import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function runningRequestsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_running_requests',
    title: 'Get Running Requests',
    description:
      'Running requests now: active user sessions with status, command, CPU, reads, elapsed time, wait type, blocking session, open transactions and the current statement. includeSleeping=true also lists idle sessions that hold an open transaction. For blocked sessions only, use mssql_blocking.',
    inputSchema: {
      includeSleeping: z
        .boolean()
        .default(false)
        .describe(
          'Also include sleeping/idle user sessions that have an open transaction, not just actively running requests.'
        ),
    },
    handler: async ({
      includeSleeping = false,
    }: {
      includeSleeping?: boolean;
    }) => {
      const activityFilter = includeSleeping
        ? '(r.session_id IS NOT NULL OR s.open_transaction_count > 0)'
        : 'r.session_id IS NOT NULL';

      const query = `
SELECT
  s.session_id                                            AS [Session],
  r.blocking_session_id                                   AS [Blocked By],
  COALESCE(r.status, s.status)                            AS [Status],
  r.command                                               AS [Command],
  r.wait_type                                             AS [Wait Type],
  r.wait_resource                                         AS [Wait Resource],
  COALESCE(r.cpu_time, s.cpu_time)                        AS [CPU ms],
  COALESCE(r.logical_reads, s.logical_reads)              AS [Logical Reads],
  r.total_elapsed_time                                    AS [Elapsed ms],
  r.percent_complete                                      AS [Pct Complete],
  s.open_transaction_count                                AS [Open Tran],
  s.login_name                                            AS [Login],
  s.host_name                                             AS [Host],
  s.program_name                                          AS [Program],
  DB_NAME(COALESCE(r.database_id, s.database_id))         AS [Database],
  SUBSTRING(st.text,
    (r.statement_start_offset / 2) + 1,
    ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
      ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1
  )                                                        AS [Statement]
FROM sys.dm_exec_sessions AS s
LEFT JOIN sys.dm_exec_requests AS r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
WHERE s.is_user_process = 1
  AND s.session_id <> @@SPID
  AND ${activityFilter}
ORDER BY r.cpu_time DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return includeSleeping
          ? 'No active requests or open transactions from user sessions.'
          : 'No active user requests running.';
      return toMarkdownTable(result);
    },
  };
}
