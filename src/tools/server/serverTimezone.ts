import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function serverTimezoneTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_server_timezone',
    title: 'Get Server Timezone',
    description:
      'Server time and timezone: local time, UTC time and UTC offset. Use for time-related job, backup or replication problems.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  GETDATE()                                       AS [Server Local Time],
  GETUTCDATE()                                    AS [Server UTC Time],
  SYSDATETIMEOFFSET()                             AS [Time With Offset],
  DATEDIFF(HOUR, GETUTCDATE(), GETDATE())         AS [UTC Offset Hours],
  DATENAME(TzOffset, SYSDATETIMEOFFSET())         AS [OS Timezone Offset];`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No timezone information found.';
      return toMarkdownTable(result);
    },
  };
}
