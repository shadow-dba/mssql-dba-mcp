import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function serverConfigTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_server_config',
    title: 'Get Server Configuration',
    description:
      'Server configuration (sp_configure, sys.configurations) with a Flag for risky values: max server memory not capped, cost threshold for parallelism at 5, MAXDOP 0, priority boost, optimize for ad hoc workloads off, xp_cmdshell on, and more. onlyFlagged=true (default) returns only flagged settings.',
    inputSchema: {
      onlyFlagged: z
        .boolean()
        .default(true)
        .describe(
          'Return only settings that triggered a risk/review Flag. Set false to return every configuration option.'
        ),
    },
    handler: async ({ onlyFlagged = true }: { onlyFlagged?: boolean }) => {
      const flagFilter = onlyFlagged ? "WHERE Flag <> ''" : '';

      const query = `
WITH cfg AS (
  SELECT
    name,
    CAST(value AS BIGINT)        AS configured_value,
    CAST(value_in_use AS BIGINT) AS running_value,
    is_dynamic,
    CASE
      WHEN name = 'max server memory (MB)' AND CAST(value_in_use AS BIGINT) = 2147483647
        THEN 'RISK: max server memory is uncapped — set below physical RAM'
      WHEN name = 'cost threshold for parallelism' AND CAST(value_in_use AS BIGINT) <= 5
        THEN 'RISK: cost threshold at default (5) — typically raise to 25–50'
      WHEN name = 'max degree of parallelism' AND CAST(value_in_use AS BIGINT) = 0
        THEN 'REVIEW: MAXDOP = 0 (unbounded) — set per core/NUMA guidance'
      WHEN name = 'priority boost' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'RISK: priority boost enabled — can starve the OS, leave off'
      WHEN name = 'lightweight pooling' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'RISK: lightweight pooling (fiber mode) enabled — leave off'
      WHEN name = 'optimize for ad hoc workloads' AND CAST(value_in_use AS BIGINT) = 0
        THEN 'REVIEW: optimize for ad hoc workloads off — enable to cut single-use plan bloat'
      WHEN name = 'max worker threads' AND CAST(value_in_use AS BIGINT) <> 0
        THEN 'REVIEW: max worker threads overridden from default (0 = auto)'
      WHEN name = 'remote admin connections' AND CAST(value_in_use AS BIGINT) = 0
        THEN 'REVIEW: remote DAC disabled — enable for emergency access'
      WHEN name = 'Ad Hoc Distributed Queries' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'RISK: Ad Hoc Distributed Queries enabled (OPENROWSET/OPENDATASOURCE)'
      WHEN name = 'xp_cmdshell' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'RISK: xp_cmdshell enabled'
      WHEN name = 'clr enabled' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'REVIEW: CLR enabled'
      WHEN name = 'contained database authentication' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'REVIEW: contained database authentication enabled'
      WHEN name = 'Database Mail XPs' AND CAST(value_in_use AS BIGINT) = 1
        THEN 'INFO: Database Mail enabled'
      WHEN CAST(value AS BIGINT) <> CAST(value_in_use AS BIGINT)
        THEN 'REVIEW: configured value not yet running (RECONFIGURE pending or restart required)'
      ELSE ''
    END AS Flag
  FROM sys.configurations
)
SELECT
  name              AS [Setting],
  configured_value  AS [Configured],
  running_value     AS [Running],
  is_dynamic        AS [Dynamic],
  Flag              AS [Flag]
FROM cfg
${flagFilter}
ORDER BY CASE WHEN Flag <> '' THEN 0 ELSE 1 END, name;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return onlyFlagged
          ? 'No flagged configuration settings — instance config looks clean against the checked rules.'
          : 'No configuration settings returned.';
      return toMarkdownTable(result);
    },
  };
}
