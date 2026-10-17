import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbColumnDesignIssuesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_column_design_issues',
    title: 'Get DB Column Design Issues',
    description:
      'Column design issues: deprecated types (text, ntext, image), risky types (datetime, float, real, sql_variant) with a suggested type, and tables whose maximum row width is over 6000 bytes (near the 8060-byte row limit).',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
    },
    handler: async ({ databaseName }: { databaseName?: string }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      // TYPE_NAME(system_type_id) resolves alias types to their base type.
      const typesInner = `
SELECT
  s.name                       AS [Schema],
  t.name                       AS [Table],
  c.name                       AS [Column],
  TYPE_NAME(c.system_type_id)  AS [Type],
  c.max_length                 AS [Max Length],
  CASE TYPE_NAME(c.system_type_id)
    WHEN 'text'        THEN 'DEPRECATED: use varchar(max)'
    WHEN 'ntext'       THEN 'DEPRECATED: use nvarchar(max)'
    WHEN 'image'       THEN 'DEPRECATED: use varbinary(max)'
    WHEN 'datetime'    THEN 'REVIEW: datetime2 is more precise and can use less space'
    WHEN 'float'       THEN 'REVIEW: approximate type, use decimal for money or exact values'
    WHEN 'real'        THEN 'REVIEW: approximate type, use decimal for money or exact values'
    WHEN 'sql_variant' THEN 'REVIEW: weak typing, hard to validate and index'
  END AS [Note]
FROM sys.columns c
JOIN sys.tables t  ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
  AND TYPE_NAME(c.system_type_id) IN ('text', 'ntext', 'image', 'datetime', 'float', 'real', 'sql_variant')
ORDER BY CASE WHEN TYPE_NAME(c.system_type_id) IN ('text', 'ntext', 'image') THEN 0 ELSE 1 END,
         s.name, t.name, c.column_id;`;

      // A (max) / LOB column keeps a 24-byte in-row pointer.
      const widthInner = `
SELECT
  s.name AS [Schema],
  t.name AS [Table],
  SUM(CASE WHEN c.max_length = -1 THEN 24 ELSE c.max_length END) AS [Max In-Row Bytes],
  SUM(CASE WHEN c.max_length = -1 THEN 1 ELSE 0 END)             AS [LOB Cols],
  COUNT(*)                                                       AS [Columns],
  CASE WHEN SUM(CASE WHEN c.max_length = -1 THEN 24 ELSE c.max_length END) > 8060
       THEN 'RISK: can exceed the 8060-byte row limit (row-overflow)'
       ELSE 'REVIEW: near the 8060-byte row limit' END           AS [Note]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name
HAVING SUM(CASE WHEN c.max_length = -1 THEN 24 ELSE c.max_length END) > 6000
ORDER BY [Max In-Row Bytes] DESC;`;

      const [types, widths] = await Promise.all([
        db.executeQuery<Record<string, any>>({ query: runInDatabaseSql(dbName, typesInner) }),
        db.executeQuery<Record<string, any>>({ query: runInDatabaseSql(dbName, widthInner) }),
      ]);

      const sections: string[] = [];
      sections.push(
        `## Deprecated and smell column types\n\n${
          types.length ? toMarkdownTable(types) : '_None found._'
        }`
      );
      sections.push(
        `## Wide rows (max in-row width over 6000 bytes)\n\n${
          widths.length ? toMarkdownTable(widths) : '_None found._'
        }`
      );
      return sections.join('\n\n');
    },
  };
}
