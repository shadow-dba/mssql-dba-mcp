import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function storageCapacityTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_storage_capacity',
    title: 'Get Storage Capacity',
    description:
      'Disk space: drives with less than 10% free space. Any row is a warning. Include in every health check. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'Volume/drive statistics (sys.dm_os_volume_stats) are not available on Azure SQL Database; storage is managed by the platform. Use sys.dm_db_file_space_usage / database size limits instead.';
      }
      const query = `
SELECT DISTINCT
  vs.volume_mount_point                                                              AS [Drive],
  CAST(vs.available_bytes / 1024.0 / 1024 / 1024 AS DECIMAL(10,2))                 AS [Free GB],
  CAST(vs.total_bytes     / 1024.0 / 1024 / 1024 AS DECIMAL(10,2))                 AS [Total GB],
  CAST((vs.available_bytes * 1.0 / vs.total_bytes) * 100 AS DECIMAL(5,2))           AS [% Free]
FROM sys.master_files mf
CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs
WHERE (vs.available_bytes * 1.0 / vs.total_bytes) < 0.10;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'All drives have more than 10% free space.';
      return toMarkdownTable(result);
    },
  };
}
