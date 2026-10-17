import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function dbOwnersTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_owners',
    title: 'Get Database Owners',
    description:
      'Database owners: user databases not owned by sa (SID 0x01, so a renamed sa still counts), including orphaned owners whose login no longer exists. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'Database ownership by sa does not apply on Azure SQL Database: the database owner (dbo) is always the server admin login.';
      }
      const query = `
SELECT
  d.name       AS [Database],
  ISNULL(SUSER_SNAME(d.owner_sid), '(orphaned: owner login not found)') AS [Owner],
  d.state_desc AS [State]
FROM sys.databases d
WHERE d.database_id > 4
  AND d.owner_sid <> 0x01
ORDER BY d.name;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'All user databases are owned by sa.';
      return toMarkdownTable(result);
    },
  };
}
