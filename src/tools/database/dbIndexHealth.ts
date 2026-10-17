import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbIndexHealthTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_index_health',
    title: 'Get Index Health',
    description:
      'Index health for one database: every non-PK index with key and included columns, usage (never used, write-only), fragmentation, fill factor advice, size and a suggested DROP, REBUILD or REORGANIZE script to review. Reads index physical stats (LIMITED), which can be slow on very large databases; use mssql_table_index_health for a few tables.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      const inner = `
WITH
  IndexUsageAnalysis AS (
    SELECT
      t.name AS tableName, i.name AS indexName, i.index_id, i.type_desc AS indexType,
      i.is_primary_key, i.is_unique, i.is_unique_constraint,
      CASE WHEN i.fill_factor = 0 THEN 100 ELSE i.fill_factor END AS actualFillFactor,
      s.user_seeks, s.user_scans, s.user_lookups, s.user_updates,
      s.user_seeks + s.user_scans + s.user_lookups AS totalReads,
      s.last_user_seek, s.last_user_scan, s.last_user_update,
      ps.avg_fragmentation_in_percent AS fragmentationPercent,
      ps.page_count, ps.avg_page_space_used_in_percent AS avgPageSpaceUsed,
      CASE WHEN s.user_updates = 0 THEN 999999
        ELSE CAST(s.user_seeks + s.user_scans + s.user_lookups AS FLOAT) / s.user_updates
      END AS readWriteRatio,
      t.object_id, ps.page_count * 8 * 1024 AS indexSizeBytes
    FROM sys.indexes i
    INNER JOIN sys.tables t ON i.object_id = t.object_id
    LEFT JOIN sys.dm_db_index_usage_stats s
      ON i.object_id = s.object_id AND i.index_id = s.index_id AND s.database_id = DB_ID()
    OUTER APPLY sys.dm_db_index_physical_stats(DB_ID(), i.object_id, i.index_id, NULL, 'LIMITED') ps
    WHERE i.index_id > 0 AND i.is_primary_key = 0 AND t.is_ms_shipped = 0
  ),
  KeyColumns AS (
    SELECT i.object_id, i.index_id,
      STUFF((
        SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE '' END
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS keyColumns
    FROM sys.indexes i
    WHERE i.index_id > 0
  ),
  IncludedColumns AS (
    SELECT i.object_id, i.index_id,
      STUFF((
        SELECT ', ' + QUOTENAME(c.name)
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
        ORDER BY ic.index_column_id
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS includedColumns
    FROM sys.indexes i
    WHERE i.index_id > 0
  ),
  Assessed AS (
    SELECT iua.*, kc.keyColumns, ic.includedColumns,
      CASE
        WHEN iua.totalReads = 0 AND iua.user_updates = 0 THEN 'Never Used'
        WHEN iua.totalReads = 0 AND iua.user_updates > 0 THEN 'Write-Only Overhead'
        WHEN iua.readWriteRatio < 0.01                   THEN 'Write-Heavy'
        ELSE 'Active'
      END AS usageStatus,
      CASE
        WHEN iua.totalReads = 0 AND iua.is_unique_constraint = 0 AND iua.is_unique = 0 THEN 'Drop Candidate'
        WHEN iua.fragmentationPercent > 30 THEN 'Needs Rebuild'
        WHEN iua.fragmentationPercent > 10 THEN 'Needs Reorganize'
        ELSE 'Healthy'
      END AS healthStatus,
      CASE
        WHEN iua.readWriteRatio >= 1000 THEN 100
        WHEN iua.readWriteRatio >= 100  THEN 95
        WHEN iua.readWriteRatio >= 10   THEN 90
        WHEN iua.readWriteRatio >= 1    THEN 85
        WHEN iua.readWriteRatio >= 0.1  THEN 80
        ELSE 70
      END AS optimalFillFactor
    FROM IndexUsageAnalysis iua
    LEFT JOIN KeyColumns kc ON iua.object_id = kc.object_id AND iua.index_id = kc.index_id
    LEFT JOIN IncludedColumns ic ON iua.object_id = ic.object_id AND iua.index_id = ic.index_id
  )
SELECT
  tableName AS [Table], indexName AS [Index], indexType AS [Type],
  CASE WHEN is_unique_constraint=1 THEN 'Yes (Constraint)' WHEN is_unique=1 THEN 'Yes' ELSE 'No' END AS [Unique],
  keyColumns AS [Key Columns], ISNULL(includedColumns, 'None') AS [Included],
  usageStatus AS [Usage], healthStatus AS [Health],
  CASE WHEN fragmentationPercent > 30 THEN 'Critical'
       WHEN fragmentationPercent > 10 THEN 'Warning'
       WHEN fragmentationPercent > 0  THEN 'Good'
       ELSE 'N/A' END AS [Frag Status],
  FORMAT(fragmentationPercent, 'N1') AS [Frag %],
  CAST(actualFillFactor AS VARCHAR) AS [Fill Factor %],
  CAST(optimalFillFactor AS VARCHAR) AS [Recommended FF %],
  CASE
    WHEN indexSizeBytes >= 1073741824 THEN FORMAT(indexSizeBytes/1073741824.0, 'N2') + ' GB'
    WHEN indexSizeBytes >= 1048576   THEN FORMAT(indexSizeBytes/1048576.0,   'N2') + ' MB'
    WHEN indexSizeBytes >= 1024      THEN FORMAT(indexSizeBytes/1024.0,      'N2') + ' KB'
    ELSE FORMAT(indexSizeBytes, 'N0') + ' B'
  END AS [Size],
  CASE
    WHEN totalReads = 0 AND is_unique = 0
      THEN 'DROP INDEX [' + indexName + '] ON [dbo].[' + tableName + '];'
    WHEN fragmentationPercent > 30
      THEN 'ALTER INDEX [' + indexName + '] ON [dbo].[' + tableName + '] REBUILD WITH (FILLFACTOR=' + CAST(optimalFillFactor AS VARCHAR) + ', ONLINE=ON);'
    WHEN fragmentationPercent > 10
      THEN 'ALTER INDEX [' + indexName + '] ON [dbo].[' + tableName + '] REORGANIZE;'
    ELSE ''
  END AS [Maintenance Script]
FROM Assessed;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No indexes found.';
      return toMarkdownTable(result);
    },
  };
}
