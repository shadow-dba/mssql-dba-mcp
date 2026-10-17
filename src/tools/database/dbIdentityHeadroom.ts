import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbIdentityHeadroomTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_identity_headroom',
    title: 'Get DB Identity Headroom',
    description:
      'Identity headroom: identity columns with the % of their type range already used (tinyint to bigint, decimal), most used first. WARN at 50%, RISK at 80%: when an identity runs out, every insert fails.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
      minPercentUsed: z
        .number()
        .min(0)
        .max(100)
        .default(0)
        .describe('Only return columns that used at least this percent of their range. Defaults to 0 (all).'),
      topN: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(50)
        .describe('Maximum number of columns to return. Defaults to 50.'),
    },
    handler: async ({
      databaseName,
      minPercentUsed = 0,
      topN = 50,
    }: {
      databaseName?: string;
      minPercentUsed?: number;
      topN?: number;
    }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      // Range math is done in FLOAT: decimal(38) limits do not fit in DECIMAL(38,0).
      const inner = `
SELECT
  OBJECT_SCHEMA_NAME(ic.object_id) AS [Schema],
  OBJECT_NAME(ic.object_id)        AS [Table],
  ic.name                          AS [Column],
  TYPE_NAME(ic.system_type_id)
    + CASE WHEN TYPE_NAME(ic.system_type_id) IN ('decimal', 'numeric')
           THEN '(' + CAST(ic.precision AS VARCHAR(3)) + ')' ELSE '' END AS [Type],
  CONVERT(VARCHAR(50), ic.seed_value)      AS [Seed],
  CONVERT(VARCHAR(50), ic.increment_value) AS [Increment],
  CONVERT(VARCHAR(50), ic.last_value)      AS [Last Value],
  CAST(ISNULL(CASE
    WHEN v.inc > 0 THEN (v.last - v.seed) / NULLIF(v.maxv - v.seed, 0)
    ELSE (v.seed - v.last) / NULLIF(v.seed - v.minv, 0)
  END, 0) * 100 AS DECIMAL(9,2)) AS [Pct Used]
FROM sys.identity_columns ic
JOIN sys.tables t ON t.object_id = ic.object_id
CROSS APPLY (SELECT
  CAST(ic.seed_value AS FLOAT)      AS seed,
  CAST(ic.increment_value AS FLOAT) AS inc,
  CAST(ic.last_value AS FLOAT)      AS last,
  CASE TYPE_NAME(ic.system_type_id)
    WHEN 'tinyint'  THEN 255E0
    WHEN 'smallint' THEN 32767E0
    WHEN 'int'      THEN 2147483647E0
    WHEN 'bigint'   THEN 9223372036854775807E0
    ELSE POWER(10E0, ic.precision) - 1 END AS maxv,
  CASE TYPE_NAME(ic.system_type_id)
    WHEN 'tinyint'  THEN 0E0
    WHEN 'smallint' THEN -32768E0
    WHEN 'int'      THEN -2147483648E0
    WHEN 'bigint'   THEN -9223372036854775808E0
    ELSE 1 - POWER(10E0, ic.precision) END AS minv
) v
WHERE t.is_ms_shipped = 0
ORDER BY [Pct Used] DESC;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No identity columns found.';

      const rows = result
        .filter((r) => Number(r['Pct Used']) >= minPercentUsed)
        .slice(0, topN)
        .map((r) => {
          const pct = Number(r['Pct Used']);
          const status = pct >= 80 ? 'RISK' : pct >= 50 ? 'WARN' : 'OK';
          return { ...r, Status: status };
        });
      if (rows.length === 0)
        return `No identity columns at or above ${minPercentUsed}% used.`;
      return toMarkdownTable(rows);
    },
  };
}
