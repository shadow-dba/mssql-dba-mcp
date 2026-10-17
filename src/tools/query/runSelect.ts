import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { showingNote, toMarkdownTable } from '../../sql/markdown.js';
import { validateDatabaseName } from '../../sql/identifiers.js';
import { validateReadOnlyQuery } from '../../sql/validateReadOnly.js';
import { runInDatabaseSql } from '../../sql/versionGuards.js';

// Rows sent to the model. The query is cancelled after this many rows, so a
// `SELECT * FROM dbo.Posts` never loads the whole table into memory.
const MAX_ROWS = 500;

export function runSelectTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_run_select',
    title: 'Run SELECT Query',
    description:
      'Run one read-only SELECT (or WITH ... SELECT) query: ad-hoc analysis of system views and DMVs when no other tool fits. ' +
      'One statement only; INSERT, UPDATE, EXEC, SET, USE, SELECT INTO and anything else that writes or changes the session are rejected. ' +
      'Use databaseName instead of USE to run in another database. ' +
      `Returns at most ${MAX_ROWS} rows; add TOP, WHERE or GROUP BY to narrow.`,
    inputSchema: {
      selectQuery: z.string().describe('One read-only SELECT statement, for example: SELECT TOP (10) name, create_date FROM sys.tables ORDER BY create_date DESC'),
      databaseName: z
        .string()
        .optional()
        .describe('Database to run the query in. Defaults to the connected database (DB_NAME).'),
    },
    alwaysLoad: true,
    handler: async ({ selectQuery, databaseName }: { selectQuery: string; databaseName?: string }) => {
      validateReadOnlyQuery(selectQuery);
      let query = selectQuery;
      if (databaseName) {
        validateDatabaseName(databaseName);
        query = runInDatabaseSql(databaseName, selectQuery);
      }

      const { rows, more } = await db.queryCapped({ query, maxRows: MAX_ROWS });
      if (rows.length === 0) return 'Query returned no rows.';
      const table = toMarkdownTable(rows, { maxRows: MAX_ROWS });
      if (!more) return table;
      return `${table}\n\n${showingNote(rows.length, `more than ${rows.length}`, 'Add TOP, WHERE or GROUP BY to narrow the result.')}`;
    },
  };
}
