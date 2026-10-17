import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function recentBackupsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_recent_backups',
    title: 'Get Most Recent Backups',
    description:
      'Backups: the most recent Full, Differential and Log backup per database in the last 30 days. Databases with no backup show NULL dates. For one database\'s history use mssql_db_backup_history. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'Backup history is not available on Azure SQL Database. Backups are managed automatically by the platform; review them via the Azure portal or sys.dm_database_backups.';
      }
      const query = `
SELECT
  d.name AS [Database],
  CASE b.type
    WHEN 'D' THEN 'Full'
    WHEN 'I' THEN 'Differential'
    WHEN 'L' THEN 'Log'
    ELSE 'No Backup'
  END AS [Backup Type],
  ISNULL(COUNT(b.backup_set_id), 0)                              AS [Backup Count],
  MAX(b.backup_start_date)                                       AS [Most Recent Backup],
  DATEDIFF(DAY, MIN(b.backup_start_date), MAX(b.backup_start_date)) AS [Days Covered]
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset b
  ON d.name = b.database_name
  AND b.backup_start_date >= DATEADD(DAY, -30, GETDATE())
  AND d.state_desc = 'ONLINE'
GROUP BY d.name, b.type
ORDER BY d.name, [Backup Type];`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No backup data found.';
      return toMarkdownTable(result);
    },
  };
}
