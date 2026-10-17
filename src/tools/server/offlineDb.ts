import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function offlineDbTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_offline_db',
    title: 'Get Offline Databases',
    description:
      'Offline databases: databases that are not ONLINE (OFFLINE, RESTORING, RECOVERING, SUSPECT, EMERGENCY). Any row needs attention.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  [name]          AS [Database],
  state_desc      AS [State],
  user_access_desc AS [User Access]
FROM sys.databases
WHERE state_desc <> 'ONLINE';`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'All databases are ONLINE.';
      return toMarkdownTable(result);
    },
  };
}
