import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';

export function dbCollationTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_collation',
    title: 'Get Database Collation',
    description:
      'Database collation: the default collation of one database. Use with mssql_db_collation_mismatches for collation conflict errors.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      const query = `SELECT DATABASEPROPERTYEX(@dbName, 'Collation') AS [Database Collation];`;

      const result = await db.executeQuery<Record<string, any>>({ query, parameters: { dbName } });
      if (!result || result.length === 0) return `No collation found for "${dbName}".`;
      return toMarkdownTable(result);
    },
  };
}
