import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName, validateSqlIdentifiers } from '../../sql/identifiers.js';
import { runInDatabaseSql, escapeSqlLiteral } from '../../sql/versionGuards.js';

export function tableIndexHealthTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_table_index_health',
    title: 'Get Tables Index Health',
    description:
      'Index health for the given tables: fragmentation, usage, fill factor advice and a suggested maintenance script.',
    inputSchema: {
      tableNames: z.array(z.string()).describe('List of table names to assess.'),
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
  IndexUsageAnalysis AS (
    SELECT
      t.name AS tableName, i.name AS indexName, i.index_id, i.type_desc AS indexType,
      i.is_primary_key, i.is_unique, i.is_unique_constraint,
      CASE WHEN i.fill_factor=0 THEN 100 ELSE i.fill_factor END AS actualFillFactor,
      s.user_seeks, s.user_scans, s.user_lookups, s.user_updates,
      s.user_seeks + s.user_scans + s.user_lookups AS totalReads,
      s.last_user_seek, s.last_user_scan, s.last_user_update,
      ps.avg_fragmentation_in_percent AS fragmentationPercent,
      ps.page_count, ps.avg_page_space_used_in_percent AS avgPageSpaceUsed,
      CASE WHEN s.user_updates=0 THEN 999999
        ELSE CAST(s.user_seeks+s.user_scans+s.user_lookups AS FLOAT)/s.user_updates
      END AS readWriteRatio,
      t.object_id, ps.page_count*8*1024 AS indexSizeBytes
    FROM sys.indexes i
    INNER JOIN sys.tables t ON i.object_id=t.object_id
    LEFT JOIN sys.dm_db_index_usage_stats s
      ON i.object_id=s.object_id AND i.index_id=s.index_id AND s.database_id=DB_ID()
    OUTER APPLY sys.dm_db_index_physical_stats(DB_ID(), i.object_id, i.index_id, NULL, 'LIMITED') ps
    WHERE i.index_id>0 AND i.is_primary_key=0 AND t.is_ms_shipped=0
  ),
  KeyColumns AS (
    SELECT i.object_id, i.index_id,
      STUFF((
        SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE '' END
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS keyColumns
    FROM sys.indexes i
    WHERE i.index_id>0
  ),
  IncludedColumns AS (
    SELECT i.object_id, i.index_id,
      STUFF((
        SELECT ', ' + QUOTENAME(c.name)
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=1
        ORDER BY ic.index_column_id
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS includedColumns
    FROM sys.indexes i
    WHERE i.index_id>0
  ),
  Assessed AS (
    SELECT iua.*, kc.keyColumns, ic.includedColumns,
      CASE
        WHEN iua.totalReads=0 AND iua.user_updates=0 THEN 'Never Used'
        WHEN iua.totalReads=0 AND iua.user_updates>0 THEN 'Write-Only Overhead'
        WHEN iua.readWriteRatio<0.01 THEN 'Write-Heavy'
        ELSE 'Active'
      END AS usageStatus,
      CASE
        WHEN iua.totalReads=0 AND iua.is_unique_constraint=0 AND iua.is_unique=0 THEN 'Drop Candidate'
        WHEN iua.fragmentationPercent>30 THEN 'Needs Rebuild'
        WHEN iua.fragmentationPercent>10 THEN 'Needs Reorganize'
        ELSE 'Healthy'
      END AS healthStatus,
      CASE
        WHEN iua.readWriteRatio>=1000 THEN 100
        WHEN iua.readWriteRatio>=100  THEN 95
        WHEN iua.readWriteRatio>=10   THEN 90
        WHEN iua.readWriteRatio>=1    THEN 85
        WHEN iua.readWriteRatio>=0.1  THEN 80
        ELSE 70
      END AS optimalFillFactor
    FROM IndexUsageAnalysis iua
    LEFT JOIN KeyColumns kc ON iua.object_id=kc.object_id AND iua.index_id=kc.index_id
    LEFT JOIN IncludedColumns ic ON iua.object_id=ic.object_id AND iua.index_id=ic.index_id
  )
SELECT
  tableName AS [Table], indexName AS [Index], indexType AS [Type],
  CASE WHEN is_unique_constraint=1 THEN 'Yes (Constraint)' WHEN is_unique=1 THEN 'Yes' ELSE 'No' END AS [Unique],
  keyColumns AS [Key Columns], ISNULL(includedColumns,'None') AS [Included],
  usageStatus AS [Usage], healthStatus AS [Health],
  CASE WHEN fragmentationPercent>30 THEN 'Critical' WHEN fragmentationPercent>10 THEN 'Warning'
       WHEN fragmentationPercent>0 THEN 'Good' ELSE 'N/A' END AS [Frag Status],
  FORMAT(fragmentationPercent,'N1') AS [Frag %],
  CAST(actualFillFactor AS VARCHAR) AS [Fill Factor %],
  CAST(optimalFillFactor AS VARCHAR) AS [Recommended FF %],
  CASE
    WHEN totalReads=0 AND is_unique=0
      THEN 'DROP INDEX ['+indexName+'] ON [dbo].['+tableName+'];'
    WHEN fragmentationPercent>30
      THEN 'ALTER INDEX ['+indexName+'] ON [dbo].['+tableName+'] REBUILD WITH (FILLFACTOR='+CAST(optimalFillFactor AS VARCHAR)+', ONLINE=ON);'
    WHEN fragmentationPercent>10
      THEN 'ALTER INDEX ['+indexName+'] ON [dbo].['+tableName+'] REORGANIZE;'
    ELSE ''
  END AS [Maintenance Script]
FROM Assessed
WHERE tableName IN (${inList});`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No indexes found for specified tables.';
      return toMarkdownTable(result);
    },
  };
}
