import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function allDbInfoTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_all_db_info',
    title: 'Get All Databases Info',
    description:
      'All databases on the instance: state, recovery model, compatibility level, data and log size, read-only, auto close, auto shrink, page verify, create date.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  name                      AS [Database],
  state_desc                AS [State],
  recovery_model_desc       AS [Recovery Model],
  compatibility_level       AS [Compat Level],
  is_read_only              AS [Read Only],
  is_auto_close_on          AS [Auto Close],
  is_auto_shrink_on         AS [Auto Shrink],
  is_in_standby             AS [Standby],
  page_verify_option_desc   AS [Page Verify],
  create_date               AS [Created],
  CAST(
    (SELECT SUM(CAST(size AS BIGINT)) * 8 / 1024.0
     FROM sys.master_files WHERE database_id = d.database_id AND type = 0)
    AS DECIMAL(18,2)) AS [Data Size MB],
  CAST(
    (SELECT SUM(CAST(size AS BIGINT)) * 8 / 1024.0
     FROM sys.master_files WHERE database_id = d.database_id AND type = 1)
    AS DECIMAL(18,2)) AS [Log Size MB]
FROM sys.databases d
ORDER BY name;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No databases found.';
      return toMarkdownTable(result);
    },
  };
}
