import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbCheckConstraintsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_check_constraints',
    title: 'Get DB Check Constraint Health',
    description:
      'Check constraints that are untrusted or disabled, with the ALTER TABLE ... WITH CHECK CHECK CONSTRAINT fix. The optimizer ignores untrusted constraints, and they may hide invalid rows. For foreign keys use mssql_db_foreign_keys.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      // NOT FOR REPLICATION constraints always report is_not_trusted = 1 and
      // cannot be re-trusted, so they are only listed when disabled.
      const inner = `
SELECT
  OBJECT_SCHEMA_NAME(cc.parent_object_id) AS [Schema],
  OBJECT_NAME(cc.parent_object_id)        AS [Table],
  cc.name                                 AS [Constraint],
  cc.definition                           AS [Definition],
  cc.is_not_trusted                       AS [Not Trusted],
  cc.is_disabled                          AS [Disabled],
  'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(cc.parent_object_id)) + '.' + QUOTENAME(OBJECT_NAME(cc.parent_object_id))
    + ' WITH CHECK CHECK CONSTRAINT ' + QUOTENAME(cc.name) + ';' AS [Fix]
FROM sys.check_constraints cc
WHERE cc.is_ms_shipped = 0
  AND (cc.is_disabled = 1 OR (cc.is_not_trusted = 1 AND cc.is_not_for_replication = 0))
ORDER BY [Schema], [Table], [Constraint];`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'No untrusted or disabled check constraints.';
      return toMarkdownTable(result);
    },
  };
}
