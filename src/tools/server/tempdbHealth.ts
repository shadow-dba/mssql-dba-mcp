import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function tempdbHealthTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_tempdb_health',
    title: 'Get TempDB Health',
    description:
      'TempDB health: file layout (count, equal sizes, autogrowth), space use (user objects, internal objects, version store, free space) and the top 10 sessions using tempdb. Flags too few data files, unequal sizes and percent autogrowth.',
    inputSchema: {},
    handler: async () => {
      const fileQuery = `
SELECT
  mf.file_id                                                AS [File Id],
  mf.name                                                   AS [Logical Name],
  mf.type_desc                                              AS [Type],
  CAST(mf.size * 8.0 / 1024 AS DECIMAL(18,1))               AS [Size MB],
  CASE WHEN mf.max_size IN (-1, 268435456) THEN 'Unlimited'
       ELSE CAST(CAST(mf.max_size * 8.0 / 1024 AS DECIMAL(18,1)) AS VARCHAR(32)) END AS [Max Size MB],
  CASE WHEN mf.is_percent_growth = 1
       THEN CAST(mf.growth AS VARCHAR(10)) + ' %'
       ELSE CAST(CAST(mf.growth * 8.0 / 1024 AS DECIMAL(18,1)) AS VARCHAR(32)) + ' MB' END AS [Autogrowth],
  mf.physical_name                                          AS [Path]
FROM sys.master_files AS mf
WHERE mf.database_id = DB_ID('tempdb')
ORDER BY mf.type, mf.file_id;`;

      const usageQuery = `
SELECT
  CAST(SUM(unallocated_extent_page_count) * 8.0 / 1024 AS DECIMAL(18,1))       AS [Free MB],
  CAST(SUM(user_object_reserved_page_count) * 8.0 / 1024 AS DECIMAL(18,1))     AS [User Objects MB],
  CAST(SUM(internal_object_reserved_page_count) * 8.0 / 1024 AS DECIMAL(18,1)) AS [Internal Objects MB],
  CAST(SUM(version_store_reserved_page_count) * 8.0 / 1024 AS DECIMAL(18,1))   AS [Version Store MB]
FROM tempdb.sys.dm_db_file_space_usage;`;

      const sessionQuery = `
SELECT TOP (10)
  ssu.session_id                                                              AS [Session],
  s.login_name                                                                AS [Login],
  s.host_name                                                                 AS [Host],
  s.program_name                                                              AS [Program],
  CAST(ssu.user_objects_alloc_page_count * 8.0 / 1024 AS DECIMAL(18,1))       AS [User Obj Alloc MB],
  CAST(ssu.internal_objects_alloc_page_count * 8.0 / 1024 AS DECIMAL(18,1))   AS [Internal Obj Alloc MB],
  st.text                                                                     AS [Last Statement]
FROM sys.dm_db_session_space_usage AS ssu
JOIN sys.dm_exec_sessions AS s ON s.session_id = ssu.session_id
LEFT JOIN sys.dm_exec_requests AS r ON r.session_id = ssu.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
WHERE ssu.session_id > 50
  AND (ssu.user_objects_alloc_page_count + ssu.internal_objects_alloc_page_count) > 0
ORDER BY (ssu.user_objects_alloc_page_count + ssu.internal_objects_alloc_page_count) DESC;`;

      const [files, usage, sessions] = await Promise.all([
        db.executeQuery<Record<string, any>>({ query: fileQuery }),
        db.executeQuery<Record<string, any>>({ query: usageQuery }),
        db.executeQuery<Record<string, any>>({ query: sessionQuery }),
      ]);

      const dataFiles = files.filter((f) => f['Type'] === 'ROWS');
      const notes: string[] = [];
      if (dataFiles.length > 0 && dataFiles.length < 4)
        notes.push(
          `- ⚠️ Only ${dataFiles.length} tempdb data file(s) — multi-core servers usually want 4–8 equally-sized files to reduce allocation-page contention.`
        );
      const sizes = new Set(dataFiles.map((f) => String(f['Size MB'])));
      if (dataFiles.length > 1 && sizes.size > 1)
        notes.push(
          '- ⚠️ Tempdb data files are not equally sized — uneven sizes defeat proportional-fill and concentrate contention.'
        );
      if (dataFiles.some((f) => String(f['Autogrowth']).includes('%')))
        notes.push(
          '- ⚠️ Percentage-based autogrowth on a tempdb data file — use a fixed MB growth increment instead.'
        );

      const sections: string[] = [];
      sections.push(
        `## TempDB file configuration\n\n${notes.length ? notes.join('\n') + '\n\n' : ''}${toMarkdownTable(files)}`
      );
      sections.push(`## TempDB space usage\n\n${toMarkdownTable(usage)}`);
      sections.push(
        `## Top tempdb space-consuming sessions\n\n${
          sessions.length
            ? toMarkdownTable(sessions)
            : '_No user session is currently holding tempdb space._'
        }`
      );

      return sections.join('\n\n');
    },
  };
}
