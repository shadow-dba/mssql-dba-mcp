import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbMissingIndexesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_missing_indexes',
    title: 'Get Missing Indexes',
    description:
      'Missing indexes for one database, from the missing-index DMVs, ranked by improvement score: urgency, improvement %, uses, equality, inequality and included columns. Only tables with 1000+ rows and real query volume.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      const inner = `
WITH
  TableWorkload AS (
    SELECT
      t.object_id,
      t.name AS tableName,
      p.rows AS [rowCount],
      ISNULL(SUM(us.user_seeks + us.user_scans + us.user_lookups), 0) AS totalReads,
      ISNULL(SUM(us.user_updates), 0) AS totalWrites,
      CASE WHEN ISNULL(SUM(us.user_updates), 0) = 0 THEN 999999
        ELSE CAST(ISNULL(SUM(us.user_seeks + us.user_scans + us.user_lookups), 0) AS FLOAT)
             / NULLIF(SUM(us.user_updates), 0)
      END AS readWriteRatio
    FROM sys.tables t
    INNER JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
    LEFT JOIN sys.dm_db_index_usage_stats us
      ON t.object_id = us.object_id AND us.database_id = DB_ID()
    WHERE t.is_ms_shipped = 0
    GROUP BY t.object_id, t.name, p.rows
  ),
  MissingIndexDetails AS (
    SELECT
      mid.object_id,
      mid.equality_columns,
      mid.inequality_columns,
      mid.included_columns,
      migs.user_seeks,
      migs.avg_total_user_cost,
      migs.avg_user_impact,
      migs.avg_total_user_cost * (migs.avg_user_impact / 100.0) * (migs.user_seeks + migs.user_scans) AS improvement_measure,
      migs.last_user_seek
    FROM sys.dm_db_missing_index_groups mig
    INNER JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
    INNER JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
    WHERE mid.database_id = DB_ID()
  ),
  Ranked AS (
    SELECT
      tw.tableName          AS [Table],
      CASE
        WHEN mid.improvement_measure > 10000 THEN 'CRITICAL'
        WHEN mid.improvement_measure > 1000  THEN 'HIGH'
        WHEN mid.improvement_measure > 100   THEN 'MEDIUM'
        WHEN mid.improvement_measure > 10    THEN 'LOW'
        ELSE 'MINIMAL'
      END AS [Urgency],
      mid.avg_user_impact   AS [Improvement %],
      mid.user_seeks        AS [Query Uses],
      mid.last_user_seek    AS [Last Needed],
      CASE
        WHEN tw.[rowCount] < 1000     THEN 100
        WHEN tw.readWriteRatio >= 100 THEN 95
        WHEN tw.readWriteRatio >= 10  THEN 90
        WHEN tw.readWriteRatio >= 1   THEN 85
        WHEN tw.readWriteRatio >= 0.1 THEN 80
        ELSE 70
      END AS [Fill Factor],
      ISNULL(mid.equality_columns,   '') AS [Equality Columns],
      ISNULL(mid.inequality_columns, '') AS [Inequality Columns],
      ISNULL(mid.included_columns,   '') AS [Included Columns],
      mid.improvement_measure,
      tw.[rowCount],
      tw.totalReads
    FROM MissingIndexDetails mid
    INNER JOIN TableWorkload tw ON mid.object_id = tw.object_id
  )
SELECT [Table], [Urgency], [Improvement %], [Query Uses], [Last Needed],
       [Fill Factor], [Equality Columns], [Inequality Columns], [Included Columns]
FROM Ranked
WHERE [rowCount] >= 1000
  AND improvement_measure >= 10
  AND totalReads >= 100
ORDER BY improvement_measure DESC;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No missing index recommendations found.';
      return toMarkdownTable(result);
    },
  };
}
