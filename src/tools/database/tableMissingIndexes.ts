import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName, validateSqlIdentifiers } from '../../sql/identifiers.js';
import { runInDatabaseSql, escapeSqlLiteral } from '../../sql/versionGuards.js';

export function tableMissingIndexesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_table_missing_indexes',
    title: 'Get Tables Missing Indexes',
    description:
      'Missing indexes for the given tables, ranked by improvement score.',
    inputSchema: {
      tableNames: z.array(z.string()).describe('List of table names to check.'),
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({
      tableNames,
      databaseName,
    }: {
      tableNames: string[];
      databaseName?: string;
    }) => {
      if (!tableNames || tableNames.length === 0) return 'No table names provided.';
      if (databaseName) validateDatabaseName(databaseName);
      validateSqlIdentifiers(tableNames, 'tableNames');

      const dbName = databaseName || db.name;
      const inList = tableNames.map((n) => `'${escapeSqlLiteral(n)}'`).join(', ');

      const inner = `
WITH
  TableWorkload AS (
    SELECT
      t.object_id, t.name AS tableName, p.rows AS [rowCount],
      ISNULL(SUM(us.user_seeks+us.user_scans+us.user_lookups),0) AS totalReads,
      ISNULL(SUM(us.user_updates),0) AS totalWrites,
      CASE WHEN ISNULL(SUM(us.user_updates),0)=0 THEN 999999
        ELSE CAST(ISNULL(SUM(us.user_seeks+us.user_scans+us.user_lookups),0) AS FLOAT)
             /NULLIF(SUM(us.user_updates),0) END AS readWriteRatio
    FROM sys.tables t
    INNER JOIN sys.partitions p ON t.object_id=p.object_id AND p.index_id IN (0,1)
    LEFT JOIN sys.dm_db_index_usage_stats us ON t.object_id=us.object_id AND us.database_id=DB_ID()
    WHERE t.is_ms_shipped=0
    GROUP BY t.object_id, t.name, p.rows
  ),
  MissingIndexDetails AS (
    SELECT
      mid.object_id, mid.equality_columns, mid.inequality_columns, mid.included_columns,
      migs.user_seeks, migs.user_scans, migs.avg_user_impact,
      migs.avg_total_user_cost*(migs.avg_user_impact/100.0)*(migs.user_seeks+migs.user_scans) AS improvement_measure,
      migs.last_user_seek
    FROM sys.dm_db_missing_index_groups mig
    INNER JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle=mig.index_group_handle
    INNER JOIN sys.dm_db_missing_index_details mid ON mig.index_handle=mid.index_handle
    WHERE mid.database_id=DB_ID()
  ),
  Recommendations AS (
    SELECT
      tw.tableName AS [Table],
      CASE
        WHEN mid.improvement_measure>10000 THEN 'CRITICAL'
        WHEN mid.improvement_measure>1000  THEN 'HIGH'
        WHEN mid.improvement_measure>100   THEN 'MEDIUM'
        WHEN mid.improvement_measure>10    THEN 'LOW'
        ELSE 'MINIMAL'
      END AS [Urgency],
      mid.avg_user_impact AS [Improvement %],
      mid.user_seeks+mid.user_scans AS [Query Uses],
      mid.last_user_seek AS [Last Needed],
      CASE WHEN tw.[rowCount]<1000 THEN 100 WHEN tw.readWriteRatio>=100 THEN 95
           WHEN tw.readWriteRatio>=10 THEN 90 WHEN tw.readWriteRatio>=1 THEN 85
           WHEN tw.readWriteRatio>=0.1 THEN 80 ELSE 70 END AS [Fill Factor],
      CASE WHEN tw.[rowCount]<10000 OR tw.readWriteRatio>=100 THEN 'OFF' ELSE 'ON' END AS [Pad Index],
      ISNULL(mid.equality_columns,'')   AS [Equality Columns],
      ISNULL(mid.inequality_columns,'') AS [Inequality Columns],
      ISNULL(mid.included_columns,'')   AS [Included Columns],
      mid.improvement_measure, tw.[rowCount], tw.totalReads
    FROM MissingIndexDetails mid
    INNER JOIN TableWorkload tw ON mid.object_id=tw.object_id
    WHERE tw.tableName IN (${inList})
  )
SELECT [Table], [Urgency], [Improvement %], [Query Uses], [Last Needed],
       [Fill Factor], [Pad Index], [Equality Columns], [Inequality Columns], [Included Columns]
FROM Recommendations
WHERE [rowCount]>=1000 AND improvement_measure>=10 AND totalReads>=100
ORDER BY improvement_measure DESC;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'No missing index recommendations found for specified tables.';
      return toMarkdownTable(result);
    },
  };
}
