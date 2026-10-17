import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function dbBackupHistoryTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_backup_history',
    title: 'Get DB Backup History',
    description:
      'Backup history of one database in the last 7 days: type, start and finish, duration, size, compressed size and file location. Not available on Azure SQL Database.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      if (await isAzureSqlDb(db)) {
        return 'Backup history (msdb.dbo.backupset) is not available on Azure SQL Database. Backups are managed automatically by the platform.';
      }

      const query = `
SELECT
  d.name                      AS [Database],
  CASE bs.type
    WHEN 'D' THEN 'Full'
    WHEN 'I' THEN 'Differential'
    WHEN 'L' THEN 'Log'
    ELSE 'Other'
  END                         AS [Backup Type],
  bs.backup_start_date        AS [Start Date],
  bs.backup_finish_date       AS [Finish Date],
  DATEDIFF(SECOND, bs.backup_start_date, bs.backup_finish_date) AS [Duration s],
  bs.backup_size / 1024 / 1024             AS [Size MB],
  bs.compressed_backup_size / 1024 / 1024  AS [Compressed MB],
  bmf.physical_device_name    AS [Backup Location],
  bs.recovery_model           AS [Recovery Model]
FROM msdb.dbo.backupset bs
INNER JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
INNER JOIN sys.databases d ON bs.database_name = d.name
WHERE d.name = @dbName
  AND bs.backup_start_date >= DATEADD(DAY, -7, GETDATE())
ORDER BY bs.backup_start_date DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query, parameters: { dbName } });
      if (!result || result.length === 0)
        return `No backup history found for "${dbName}" in the last 7 days.`;
      return toMarkdownTable(result);
    },
  };
}
