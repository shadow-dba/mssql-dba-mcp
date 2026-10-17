import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbTableKeysTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_table_keys',
    title: 'Get DB Table Keys',
    description:
      'Table keys: every user table with row count, heap or clustered index, primary key and other unique indexes. Flags heaps, tables without a primary key, and tables where only the primary key is unique. onlyFlagged=true (default) returns only flagged tables.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
      onlyFlagged: z
        .boolean()
        .default(true)
        .describe('Return only tables with a flag. Set false to return all tables.'),
    },
    handler: async ({
      databaseName,
      onlyFlagged = true,
    }: {
      databaseName?: string;
      onlyFlagged?: boolean;
    }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      const inner = `
SELECT
  s.name AS [Schema],
  t.name AS [Table],
  ISNULL(r.row_count, 0) AS [Rows],
  CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.index_id = 1)
       THEN 1 ELSE 0 END AS [Has Clustered],
  CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1)
       THEN 1 ELSE 0 END AS [Has PK],
  (SELECT COUNT(*) FROM sys.indexes i
   WHERE i.object_id = t.object_id AND i.is_unique = 1 AND i.is_primary_key = 0) AS [Other Unique]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
OUTER APPLY (SELECT SUM(p.rows) AS row_count FROM sys.partitions p
             WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) r
WHERE t.is_ms_shipped = 0
ORDER BY ISNULL(r.row_count, 0) DESC;`;
      const query = runInDatabaseSql(dbName, inner);

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No user tables found.';

      const rows = result.map((r) => {
        const flags: string[] = [];
        if (!r['Has Clustered']) flags.push('RISK: heap (no clustered index)');
        if (!r['Has PK']) flags.push('RISK: no primary key');
        else if (r['Other Unique'] === 0)
          flags.push('REVIEW: only the PK is unique, check for a natural key');
        return { ...r, Flags: flags.join('; ') };
      });
      // RISK rows first, then REVIEW, keeping row-count order inside each group.
      const rank = (f: string) => (f.startsWith('RISK') ? 0 : f ? 1 : 2);
      rows.sort((a, b) => rank(a.Flags) - rank(b.Flags));

      const shown = onlyFlagged ? rows.filter((r) => r.Flags) : rows;
      if (shown.length === 0) return 'No flagged tables.';
      return toMarkdownTable(shown);
    },
  };
}
