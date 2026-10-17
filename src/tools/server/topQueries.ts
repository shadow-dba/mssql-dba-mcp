import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

type ResourceSortColumn =
  | 'cpu'
  | 'logical_reads'
  | 'memory_grants'
  | 'spills'
  | 'duration'
  | 'executions';

const SORT_COLUMN_MAP: Record<ResourceSortColumn, string> = {
  cpu: 'total_worker_time',
  logical_reads: 'total_logical_reads',
  memory_grants: 'max_used_grant_kb',
  spills: 'total_spills',
  duration: 'total_elapsed_time',
  executions: 'execution_count',
};

export function topQueriesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_top_queries',
    title: 'Get Top Resource Queries',
    description:
      'Top queries by CPU, logical reads, memory grant, spills, duration or executions, from the plan cache (sys.dm_exec_query_stats), with statement text and the Plan Handle for mssql_execution_plan. topN default 25, max 100.',
    alwaysLoad: true,
    inputSchema: {
      sortBy: z
        .enum(['cpu', 'logical_reads', 'memory_grants', 'spills', 'duration', 'executions'])
        .default('cpu')
        .describe('Resource dimension to sort by.'),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Number of queries to return (1–100).'),
    },
    handler: async ({
      sortBy = 'cpu',
      topN = 25,
    }: {
      sortBy?: ResourceSortColumn;
      topN?: number;
    }) => {
      const sortColumn = SORT_COLUMN_MAP[sortBy] ?? SORT_COLUMN_MAP.cpu;

      const query = `
SELECT TOP (${topN})
  qs.execution_count                                                          AS [Executions],
  qs.total_worker_time / 1000                                                 AS [Total CPU ms],
  qs.total_worker_time / qs.execution_count / 1000                           AS [Avg CPU ms],
  qs.total_logical_reads                                                      AS [Total Logical Reads],
  qs.total_logical_reads / qs.execution_count                                AS [Avg Logical Reads],
  qs.total_elapsed_time / 1000                                               AS [Total Elapsed ms],
  qs.total_elapsed_time / qs.execution_count / 1000                         AS [Avg Elapsed ms],
  qs.total_spills                                                             AS [Total Spills],
  qs.max_used_grant_kb                                                        AS [Max Grant KB],
  CONVERT(VARCHAR(max), qs.plan_handle, 1)                                   AS [Plan Handle],
  SUBSTRING(st.text,
    (qs.statement_start_offset / 2) + 1,
    ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
      ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1
  )                                                                           AS [Statement],
  DB_NAME(st.dbid)                                                            AS [Database],
  OBJECT_NAME(st.objectid, st.dbid)                                          AS [Object]
FROM sys.dm_exec_query_stats AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
WHERE st.dbid IS NOT NULL
ORDER BY qs.${sortColumn} DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'No query stats found. DMV may be empty after a recent server restart.';
      return toMarkdownTable(result);
    },
  };
}
