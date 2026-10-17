import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function blockingTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_blocking',
    title: 'Get Current Blocking and Locking',
    description:
      'Blocking and locking now: blocked sessions with the blocking session, wait type, wait time and query text. An empty result means no blocking.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  r.session_id,
  r.status,
  r.blocking_session_id,
  r.wait_type,
  r.wait_time                AS [Wait Time ms],
  r.wait_resource,
  r.total_elapsed_time       AS [Elapsed Time ms],
  st.text                    AS [Query Text]
FROM sys.dm_exec_requests AS r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
WHERE r.blocking_session_id <> 0;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No blocking or locking detected.';
      return toMarkdownTable(result);
    },
  };
}
