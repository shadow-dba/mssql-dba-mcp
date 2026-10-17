import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbCollationMismatchesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_collation_mismatches',
    title: 'Get Collation Mismatches',
    description:
      'Collation mismatches: columns (dbo schema) whose collation differs from the database default. A common cause of collation conflict errors in joins with temp tables.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      const inner = `
SELECT
  t.name  AS [Table],
  c.name  AS [Column],
  c.collation_name AS [Column Collation],
  ty.name AS [Data Type],
  c.max_length AS [Max Length]
FROM sys.columns c
INNER JOIN sys.tables  t  ON c.object_id = t.object_id
INNER JOIN sys.schemas s  ON t.schema_id = s.schema_id
INNER JOIN sys.types   ty ON c.user_type_id = ty.user_type_id
WHERE c.collation_name IS NOT NULL
  AND c.collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS VARCHAR(100))
  AND s.name = 'dbo'
ORDER BY t.name, c.name;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No collation mismatches found.';
      return toMarkdownTable(result);
    },
  };
}
