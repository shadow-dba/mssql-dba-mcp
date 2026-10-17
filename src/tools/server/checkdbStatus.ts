import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function checkdbStatusTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_checkdb_status',
    title: 'Get DBCC CHECKDB Status',
    description:
      'CHECKDB and corruption: the last known good DBCC CHECKDB date per online database (flags never, or more than 7 days ago) and the rows in msdb.dbo.suspect_pages (corruption already found). Never runs CHECKDB. Databases the login cannot read show UNKNOWN. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'DBCC DBINFO header inspection and msdb..suspect_pages are not available on Azure SQL Database. Integrity checks are managed by the platform; run DBCC CHECKDB manually against the single database if needed.';
      }
      const checkdbQuery = `
SET NOCOUNT ON;
DECLARE @results TABLE ([Database] sysname, LastKnownGood DATETIME NULL, ReadError BIT NOT NULL DEFAULT 0);
DECLARE @dbinfo TABLE (ParentObject VARCHAR(255), [Object] VARCHAR(255), Field VARCHAR(255), [Value] VARCHAR(255));
DECLARE @db sysname, @sql NVARCHAR(MAX), @lkg VARCHAR(255), @lkgDt DATETIME;

DECLARE db_cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT name FROM sys.databases
  WHERE state = 0 AND database_id <> 2; -- ONLINE, skip tempdb

OPEN db_cur;
FETCH NEXT FROM db_cur INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
  -- SQL Server 2016 SP2+ / 2017 CU9+: no special permission needed.
  SET @lkgDt = TRY_CONVERT(DATETIME, DATABASEPROPERTYEX(@db, 'LastGoodCheckDbTime'));
  IF @lkgDt IS NOT NULL
    INSERT INTO @results ([Database], LastKnownGood, ReadError) VALUES (@db, @lkgDt, 0);
  ELSE
  BEGIN
    -- Older builds: read the database header (needs sysadmin / db_owner).
    BEGIN TRY
      DELETE FROM @dbinfo;
      SET @sql = N'DBCC DBINFO(' + QUOTENAME(@db, '''') + N') WITH TABLERESULTS, NO_INFOMSGS';
      INSERT INTO @dbinfo EXEC (@sql);
      SET @lkg = NULL;
      SELECT @lkg = [Value] FROM @dbinfo WHERE Field = 'dbi_dbccLastKnownGood';
      INSERT INTO @results ([Database], LastKnownGood, ReadError)
        VALUES (@db, TRY_CONVERT(DATETIME, @lkg), 0);
    END TRY
    BEGIN CATCH
      INSERT INTO @results ([Database], LastKnownGood, ReadError) VALUES (@db, NULL, 1);
    END CATCH
  END
  FETCH NEXT FROM db_cur INTO @db;
END
CLOSE db_cur;
DEALLOCATE db_cur;

SELECT
  [Database],
  CASE
    WHEN ReadError = 1 THEN 'UNKNOWN (could not read header)'
    WHEN LastKnownGood IS NULL OR LastKnownGood <= '1900-01-01' THEN 'NEVER'
    ELSE CONVERT(VARCHAR(19), LastKnownGood, 120)
  END AS [Last Known Good CHECKDB],
  CASE
    WHEN ReadError = 1 OR LastKnownGood IS NULL OR LastKnownGood <= '1900-01-01' THEN NULL
    ELSE DATEDIFF(DAY, LastKnownGood, GETDATE())
  END AS [Days Since],
  CASE
    WHEN ReadError = 1 THEN 'UNKNOWN: insufficient permission or header unreadable'
    WHEN LastKnownGood IS NULL OR LastKnownGood <= '1900-01-01' THEN 'RISK: no record of a clean CHECKDB'
    WHEN DATEDIFF(DAY, LastKnownGood, GETDATE()) > 7 THEN 'WARN: last clean CHECKDB over 7 days ago'
    ELSE 'OK'
  END AS [Status]
FROM @results
ORDER BY
  CASE WHEN ReadError = 1 THEN 1 WHEN LastKnownGood IS NULL OR LastKnownGood <= '1900-01-01' THEN 0 ELSE 2 END,
  LastKnownGood;`;

      const suspectQuery = `
SELECT
  DB_NAME(database_id) AS [Database],
  file_id              AS [File Id],
  page_id              AS [Page Id],
  CASE event_type
    WHEN 1 THEN '823/824 error or bad checksum'
    WHEN 2 THEN 'bad checksum'
    WHEN 3 THEN 'torn page'
    WHEN 4 THEN 'restored'
    WHEN 5 THEN 'repaired (DBCC)'
    WHEN 7 THEN 'deallocated (DBCC)'
    ELSE CAST(event_type AS VARCHAR(10))
  END                  AS [Event],
  error_count          AS [Error Count],
  CONVERT(VARCHAR(19), last_update_date, 120) AS [Last Update]
FROM msdb.dbo.suspect_pages
ORDER BY last_update_date DESC;`;

      const [checkdb, suspect] = await Promise.all([
        db.executeQuery<Record<string, any>>({ query: checkdbQuery }),
        db.executeQuery<Record<string, any>>({ query: suspectQuery }),
      ]);

      const sections: string[] = [];
      sections.push(
        `## Last known good CHECKDB\n\n${
          checkdb.length ? toMarkdownTable(checkdb) : '_No online databases found._'
        }`
      );
      sections.push(
        `## Suspect pages (msdb)\n\n${
          suspect.length
            ? '⚠️ Corruption has been recorded — investigate immediately.\n\n' +
              toMarkdownTable(suspect)
            : '_No suspect pages recorded._'
        }`
      );

      return sections.join('\n\n');
    },
  };
}
