import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

export function dbForeignKeysTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_foreign_keys',
    title: 'Get DB Foreign Keys',
    description:
      'Foreign keys review for one database: each foreign key with trusted, disabled, indexed (unindexed foreign keys slow joins and deletes) and column type or collation mismatches, plus the WITH CHECK CHECK CONSTRAINT fix; and likely missing foreign keys found by column name (for example Votes.PostId -> Posts.Id). Name matching is a guess, so confirm each one.',
    inputSchema: {
      databaseName: z.string().optional().describe('Target database. Defaults to connected database.'),
      onlyIssues: z
        .boolean()
        .default(false)
        .describe('List only existing foreign keys that have an issue. Defaults to false (all).'),
    },
    handler: async ({
      databaseName,
      onlyIssues = false,
    }: {
      databaseName?: string;
      onlyIssues?: boolean;
    }) => {
      if (databaseName) validateDatabaseName(databaseName);
      const dbName = databaseName || db.name;

      // NOT FOR REPLICATION FKs always report is_not_trusted = 1 and cannot be
      // re-trusted, so they get no fix script.
      const existingInner = `
SELECT
  OBJECT_SCHEMA_NAME(fk.parent_object_id)     AS [Schema],
  OBJECT_NAME(fk.parent_object_id)            AS [Table],
  fk.name                                     AS [Foreign Key],
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.foreign_key_columns x
    JOIN sys.columns c ON c.object_id = x.parent_object_id AND c.column_id = x.parent_column_id
    WHERE x.constraint_object_id = fk.object_id
    ORDER BY x.constraint_column_id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS [Columns],
  OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS [Ref Schema],
  OBJECT_NAME(fk.referenced_object_id)        AS [Ref Table],
  STUFF((
    SELECT ', ' + QUOTENAME(c.name)
    FROM sys.foreign_key_columns x
    JOIN sys.columns c ON c.object_id = x.referenced_object_id AND c.column_id = x.referenced_column_id
    WHERE x.constraint_object_id = fk.object_id
    ORDER BY x.constraint_column_id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS [Ref Columns],
  CASE WHEN fk.is_not_trusted = 0 THEN 'Yes'
       WHEN fk.is_not_for_replication = 1 THEN 'No (NOT FOR REPLICATION)'
       ELSE 'No' END                          AS [Trusted],
  CASE WHEN fk.is_disabled = 1 THEN 'Yes' ELSE 'No' END AS [Disabled],
  CASE WHEN EXISTS (
    SELECT 1 FROM sys.index_columns ic
    WHERE ic.object_id = lead.parent_object_id
      AND ic.column_id = lead.parent_column_id
      AND ic.key_ordinal = 1) THEN 'Yes' ELSE 'No' END AS [Indexed],
  ISNULL(STUFF((
    SELECT '; ' + pc.name + ' ' + pt.name + '(' + CAST(pc.max_length AS VARCHAR(10)) + ISNULL(' ' + pc.collation_name, '') + ')'
         + ' vs ' + rc.name + ' ' + rt.name + '(' + CAST(rc.max_length AS VARCHAR(10)) + ISNULL(' ' + rc.collation_name, '') + ')'
    FROM sys.foreign_key_columns x
    JOIN sys.columns pc ON pc.object_id = x.parent_object_id AND pc.column_id = x.parent_column_id
    JOIN sys.types   pt ON pt.user_type_id = pc.user_type_id
    JOIN sys.columns rc ON rc.object_id = x.referenced_object_id AND rc.column_id = x.referenced_column_id
    JOIN sys.types   rt ON rt.user_type_id = rc.user_type_id
    WHERE x.constraint_object_id = fk.object_id
      AND (pc.user_type_id <> rc.user_type_id
           OR pc.max_length <> rc.max_length
           OR pc.precision <> rc.precision
           OR pc.scale <> rc.scale
           OR ISNULL(pc.collation_name, '') <> ISNULL(rc.collation_name, ''))
    ORDER BY x.constraint_column_id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, ''), '') AS [Mismatches],
  CASE WHEN fk.is_disabled = 1 OR (fk.is_not_trusted = 1 AND fk.is_not_for_replication = 0)
       THEN 'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + '.' + QUOTENAME(OBJECT_NAME(fk.parent_object_id))
            + ' WITH CHECK CHECK CONSTRAINT ' + QUOTENAME(fk.name) + ';'
       ELSE '' END                            AS [Fix]
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns lead
  ON lead.constraint_object_id = fk.object_id AND lead.constraint_column_id = 1
WHERE fk.is_ms_shipped = 0
ORDER BY [Schema], [Table], [Foreign Key];`;

      // tbl_base is a naive singular of the table name (Posts -> Post,
      // Badges -> Badge). A bare "Id" column never matches by itself,
      // because almost every table has one.
      const candidatesInner = `
WITH pk AS (
  SELECT
    i.object_id,
    c.name           AS pk_col,
    c.system_type_id,
    s.name           AS sch,
    t.name           AS tbl,
    NULLIF(CASE WHEN t.name LIKE '%ies' THEN LEFT(t.name, LEN(t.name) - 3) + 'y'
                WHEN t.name LIKE '%s'   THEN LEFT(t.name, LEN(t.name) - 1)
                ELSE t.name END, '') AS tbl_base
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 1
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  JOIN sys.tables  t ON t.object_id = i.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE i.is_primary_key = 1
    AND t.is_ms_shipped = 0
    AND NOT EXISTS (SELECT 1 FROM sys.index_columns x
                    WHERE x.object_id = i.object_id AND x.index_id = i.index_id AND x.key_ordinal > 1)
)
SELECT
  s.name                      AS [Schema],
  t.name                      AS [Table],
  c.name                      AS [Column],
  TYPE_NAME(c.system_type_id) AS [Type],
  pk.sch                      AS [Likely Ref Schema],
  pk.tbl                      AS [Likely Ref Table],
  pk.pk_col                   AS [Ref PK Column]
FROM sys.columns c
JOIN sys.tables  t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN pk ON pk.system_type_id = c.system_type_id
       AND pk.object_id <> c.object_id
       AND (
         (LOWER(c.name) = LOWER(pk.pk_col) AND LOWER(pk.pk_col) <> 'id')
         OR LOWER(c.name) IN (
           LOWER(pk.tbl + pk.pk_col), LOWER(pk.tbl_base + pk.pk_col),
           LOWER(pk.tbl + '_' + pk.pk_col), LOWER(pk.tbl_base + '_' + pk.pk_col))
       )
WHERE t.is_ms_shipped = 0
  AND NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc
                  WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id)
ORDER BY s.name, t.name, c.name;`;

      const [existing, candidates] = await Promise.all([
        db.executeQuery<Record<string, any>>({ query: runInDatabaseSql(dbName, existingInner) }),
        db.executeQuery<Record<string, any>>({ query: runInDatabaseSql(dbName, candidatesInner) }),
      ]);

      const rows = existing.map((r) => {
        const issues: string[] = [];
        if (r['Disabled'] === 'Yes') issues.push('disabled');
        if (r['Trusted'] !== 'Yes') issues.push('not trusted');
        if (r['Indexed'] === 'No') issues.push('no supporting index');
        if (r['Mismatches']) issues.push('column mismatch');
        return { ...r, Issues: issues.join('; ') };
      });
      // Foreign keys with issues first, keeping name order inside each group.
      rows.sort((a, b) => Number(!a.Issues) - Number(!b.Issues));
      const shown = onlyIssues ? rows.filter((r) => r.Issues) : rows;
      const issueCount = rows.filter((r) => r.Issues).length;

      const sections: string[] = [];
      sections.push(
        `## Existing foreign keys\n\n${
          rows.length
            ? `**${rows.length} foreign key(s), ${issueCount} with issues.**\n\n` +
              (shown.length ? toMarkdownTable(shown) : '_No foreign keys with issues._')
            : '_No foreign keys defined._'
        }`
      );
      sections.push(
        `## Likely missing foreign keys\n\n${
          candidates.length ? toMarkdownTable(candidates) : '_None found._'
        }`
      );
      return sections.join('\n\n');
    },
  };
}
