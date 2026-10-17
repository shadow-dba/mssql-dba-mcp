import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';
import { objectExistsExpr } from '../../sql/versionGuards.js';

export function vlfCountsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_vlf_counts',
    title: 'Get VLF Counts',
    description:
      'VLF count: databases whose transaction log has more virtual log files than minVlfCount (default 1000), worst first. Many VLFs slow recovery, restores and log backups. Needs SQL Server 2016 SP2 or later.',
    inputSchema: {
      minVlfCount: z
        .number()
        .int()
        .min(0)
        .default(1000)
        .describe('Only return databases with more VLFs than this. Defaults to 1000.'),
    },
    handler: async ({ minVlfCount = 1000 }: { minVlfCount?: number }) => {
      const [check] = await db.executeQuery<{ ok: number }>({
        query: `SELECT CASE WHEN ${objectExistsExpr('sys.dm_db_log_info')} THEN 1 ELSE 0 END AS ok;`,
      });
      if (check?.ok !== 1) {
        return 'sys.dm_db_log_info is not available on this version (needs SQL Server 2016 SP2 or later). Run DBCC LOGINFO per database instead.';
      }

      const scope = (await isAzureSqlDb(db)) ? 'AND database_id = DB_ID()' : '';
      const query = `
SET NOCOUNT ON;
DECLARE @r TABLE (database_id INT, vlf_count INT NULL, active_vlfs INT NULL, log_mb DECIMAL(18,1) NULL, read_error BIT NOT NULL);
DECLARE @id INT;

DECLARE db_cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT database_id FROM sys.databases
  WHERE state = 0 AND HAS_DBACCESS(name) = 1 ${scope};

OPEN db_cur;
FETCH NEXT FROM db_cur INTO @id;
WHILE @@FETCH_STATUS = 0
BEGIN
  BEGIN TRY
    INSERT INTO @r (database_id, vlf_count, active_vlfs, log_mb, read_error)
    SELECT @id, COUNT(*), SUM(CASE WHEN vlf_active = 1 THEN 1 ELSE 0 END), SUM(vlf_size_mb), 0
    FROM sys.dm_db_log_info(@id);
  END TRY
  BEGIN CATCH
    INSERT INTO @r (database_id, read_error) VALUES (@id, 1);
  END CATCH
  FETCH NEXT FROM db_cur INTO @id;
END
CLOSE db_cur;
DEALLOCATE db_cur;

SELECT
  DB_NAME(database_id) AS [Database],
  vlf_count            AS [VLF Count],
  active_vlfs          AS [Active VLFs],
  log_mb               AS [Log Size MB],
  CASE WHEN read_error = 1 THEN 'UNKNOWN: could not read log info' ELSE 'WARN: high VLF count' END AS [Status]
FROM @r
WHERE read_error = 1 OR vlf_count > @minVlf
ORDER BY read_error, vlf_count DESC;`;

      const result = await db.executeQuery<Record<string, any>>({
        query,
        parameters: { minVlf: minVlfCount },
      });
      if (!result || result.length === 0)
        return `No databases with more than ${minVlfCount} VLFs.`;
      return toMarkdownTable(result);
    },
  };
}
