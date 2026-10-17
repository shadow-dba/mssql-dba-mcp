import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName, validateSqlIdentifiers } from '../../sql/identifiers.js';
import { runInDatabaseSql, escapeSqlLiteral } from '../../sql/versionGuards.js';

export function tableInfoTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_table_info',
    title: 'Get Tables Info',
    description:
      'Table details for the given tables: row count, size, primary key type, index counts, read/write workload, access pattern and volatility.',
    inputSchema: {
      tableNames: z.array(z.string()).describe('List of table names to analyze.'),
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
  PrimaryKeyInfo AS (
    SELECT
      t.object_id, t.name AS tableName, i.name AS primaryKeyName,
      i.type_desc AS indexType, i.fill_factor,
      STUFF((
        SELECT ',' + c.name + ' (' + CASE WHEN ic.is_descending_key=1 THEN 'DESC' ELSE 'ASC' END + ')'
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
        ORDER BY ic.key_ordinal FOR XML PATH('')
      ), 1, 1, '') AS keyColumns,
      (SELECT COUNT(*) FROM sys.index_columns ic
       WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=0) AS keyColumnCount,
      CASE WHEN EXISTS (
        SELECT 1 FROM sys.index_columns ic INNER JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND c.is_identity=1
      ) THEN 1 ELSE 0 END AS hasIdentityKey,
      (SELECT TOP 1 ty.name FROM sys.index_columns ic
       INNER JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
       INNER JOIN sys.types ty ON c.user_type_id=ty.user_type_id
       WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id ORDER BY ic.key_ordinal) AS firstKeyDataType,
      ps.used_page_count*8.0/1024 AS indexSizeMB
    FROM sys.tables t
    LEFT JOIN sys.indexes i ON t.object_id=i.object_id AND i.is_primary_key=1
    LEFT JOIN sys.dm_db_partition_stats ps ON i.object_id=ps.object_id AND i.index_id=ps.index_id
    WHERE t.is_ms_shipped=0
  ),
  IndexMetrics AS (
    SELECT t.object_id,
      COUNT(DISTINCT i.index_id)-1 AS totalIndexCount,
      COUNT(DISTINCT CASE WHEN i.is_disabled=0 AND i.index_id>0 THEN i.index_id END) AS activeIndexCount,
      COUNT(DISTINCT CASE WHEN (us.user_seeks+us.user_scans+us.user_lookups>0 AND i.index_id>0) THEN i.index_id END) AS usedIndexCount,
      COUNT(DISTINCT CASE WHEN ((us.user_seeks+us.user_scans+us.user_lookups=0 OR us.user_seeks IS NULL) AND i.index_id>0) THEN i.index_id END) AS unusedIndexCount,
      COUNT(DISTINCT CASE WHEN ps.avg_fragmentation_in_percent>30 AND ps.page_count>1000 AND i.index_id>0 THEN i.index_id END) AS fragmentedIndexCount
    FROM sys.tables t
    LEFT JOIN sys.indexes i ON t.object_id=i.object_id
    LEFT JOIN sys.dm_db_index_usage_stats us ON i.object_id=us.object_id AND i.index_id=us.index_id AND us.database_id=DB_ID()
    OUTER APPLY sys.dm_db_index_physical_stats(DB_ID(), i.object_id, i.index_id, NULL, 'LIMITED') ps
    WHERE t.is_ms_shipped=0
    GROUP BY t.object_id
  ),
  TableWorkload AS (
    SELECT
      t.object_id, t.name AS tableName, p.row_count AS [rowCount],
      CAST(p.reserved_page_count*8.0/1024 AS DECIMAL(10,2)) AS tableSizeMB,
      ISNULL(SUM(us.user_seeks),0) AS userSeeks, ISNULL(SUM(us.user_scans),0) AS userScans,
      ISNULL(SUM(us.user_lookups),0) AS userLookups,
      ISNULL(SUM(us.user_seeks+us.user_scans+us.user_lookups),0) AS totalReads,
      ISNULL(SUM(us.user_updates),0) AS totalWrites,
      CASE WHEN ISNULL(SUM(us.user_updates),0)=0 THEN 999999
        ELSE CAST(ISNULL(SUM(us.user_seeks+us.user_scans+us.user_lookups),0) AS FLOAT)/NULLIF(SUM(us.user_updates),0)
      END AS readWriteRatio,
      DATEDIFF(DAY, MAX(us.last_user_update), GETDATE()) AS daysSinceLastWrite,
      DATEDIFF(DAY, COALESCE(MAX(us.last_user_seek),MAX(us.last_user_scan),MAX(us.last_user_lookup)), GETDATE()) AS daysSinceLastRead
    FROM sys.tables t
    INNER JOIN (
      SELECT object_id, SUM(row_count) AS row_count, SUM(reserved_page_count) AS reserved_page_count
      FROM sys.dm_db_partition_stats WHERE index_id IN (0,1) GROUP BY object_id
    ) p ON t.object_id=p.object_id
    LEFT JOIN sys.dm_db_index_usage_stats us ON t.object_id=us.object_id AND us.database_id=DB_ID()
    WHERE t.is_ms_shipped=0
    GROUP BY t.object_id, t.name, p.row_count, p.reserved_page_count
  )
SELECT
  tw.tableName AS [Table],
  ISNULL(pk.primaryKeyName,'NONE') AS [PK Name],
  ISNULL(pk.keyColumns,'N/A')      AS [PK Columns],
  CASE
    WHEN pk.primaryKeyName IS NULL THEN 'No PK'
    WHEN pk.hasIdentityKey=1 AND pk.keyColumnCount=1 THEN 'Identity'
    WHEN pk.keyColumnCount=1 AND pk.firstKeyDataType IN ('int','bigint','smallint') THEN 'Numeric'
    WHEN pk.keyColumnCount=1 AND pk.firstKeyDataType='uniqueidentifier' THEN 'GUID'
    WHEN pk.keyColumnCount=1 AND pk.firstKeyDataType IN ('varchar','nvarchar') THEN 'String'
    WHEN pk.keyColumnCount>1 THEN 'Composite'
    ELSE 'Other'
  END AS [PK Type],
  FORMAT(tw.[rowCount],'N0') AS [Row Count],
  CASE WHEN tw.tableSizeMB>=1024 THEN FORMAT(tw.tableSizeMB/1024.0,'N2')+' GB'
       ELSE FORMAT(tw.tableSizeMB,'N2')+' MB' END AS [Table Size],
  ISNULL(im.totalIndexCount,0)     AS [Total Indexes],
  ISNULL(im.usedIndexCount,0)      AS [Used Indexes],
  ISNULL(im.unusedIndexCount,0)    AS [Unused Indexes],
  ISNULL(im.fragmentedIndexCount,0) AS [Fragmented Indexes],
  CASE
    WHEN tw.readWriteRatio=999999 THEN 'Read-Only'
    WHEN tw.readWriteRatio>=100   THEN 'Read-Intensive'
    WHEN tw.readWriteRatio>=10    THEN 'Read-Heavy'
    WHEN tw.readWriteRatio>=1     THEN 'Balanced'
    WHEN tw.readWriteRatio>=0.1   THEN 'Write-Heavy'
    ELSE 'Write-Intensive'
  END AS [Workload],
  CASE
    WHEN tw.userSeeks>0 AND tw.userScans=0 THEN 'Seek Only'
    WHEN tw.userScans>0 AND tw.userSeeks=0 THEN 'Scan Only'
    WHEN tw.userSeeks>(tw.userScans*5)     THEN 'Seek Dominant'
    WHEN tw.userScans>(tw.userSeeks*5)     THEN 'Scan Dominant'
    WHEN tw.userSeeks>0 AND tw.userScans>0 THEN 'Mixed'
    ELSE 'No Access'
  END AS [Access Pattern],
  CASE
    WHEN tw.totalWrites=0 OR tw.[rowCount]=0 THEN 'Static'
    WHEN CAST(tw.totalWrites AS FLOAT)/NULLIF(tw.[rowCount],0)>10 THEN 'Highly Volatile'
    WHEN CAST(tw.totalWrites AS FLOAT)/NULLIF(tw.[rowCount],0)>1  THEN 'Volatile'
    WHEN CAST(tw.totalWrites AS FLOAT)/NULLIF(tw.[rowCount],0)>0.1 THEN 'Moderate'
    ELSE 'Stable'
  END AS [Volatility]
FROM TableWorkload tw
LEFT JOIN PrimaryKeyInfo pk ON tw.object_id=pk.object_id
LEFT JOIN IndexMetrics im   ON tw.object_id=im.object_id
WHERE tw.tableName IN (${inList})
ORDER BY tw.tableSizeMB DESC;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No tables found with specified names.';
      return toMarkdownTable(result);
    },
  };
}
