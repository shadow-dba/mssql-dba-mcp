import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

const DEFAULT_MAX_ROWS = 100;
const MAX_ROWS_CEILING = 1000;

export function errorLogTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_error_log',
    title: 'Read SQL Server Error Log',
    description:
      'Error log: read the SQL Server ERRORLOG (or SQL Server Agent log) via sp_readerrorlog. ' +
      'Optionally filter to lines containing one or two search strings (e.g. "Backup", "3013") and ' +
      'select an archived log file. Returns newest entries first. ' +
      'Needs VIEW ANY ERROR LOG (SQL Server 2022+ / Managed Instance) or securityadmin. ' +
      'Not available on Azure SQL Database.',
    inputSchema: {
      logNumber: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Which log file: 0 = current ERRORLOG, 1 = most recent archive, 2 = next older, etc. Defaults to 0.'
        ),
      logType: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe(
          '1 = SQL Server error log (default), 2 = SQL Server Agent error log.'
        ),
      search1: z
        .string()
        .optional()
        .describe('Only return lines containing this string (e.g. "Backup").'),
      search2: z
        .string()
        .optional()
        .describe(
          'Further narrow to lines that also contain this string (e.g. "3013"). Applied in addition to search1.'
        ),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS_CEILING)
        .optional()
        .describe(
          `Cap on rows returned, newest first (default ${DEFAULT_MAX_ROWS}, max ${MAX_ROWS_CEILING}).`
        ),
    },
    handler: async ({
      logNumber,
      logType,
      search1,
      search2,
      maxRows,
    }: {
      logNumber?: number;
      logType?: number;
      search1?: string;
      search2?: string;
      maxRows?: number;
    }) => {
      if (await isAzureSqlDb(db)) {
        return 'The SQL Server error log (sp_readerrorlog) is not available on Azure SQL Database. Inspect diagnostics via the Azure portal, sys.event_log, or Log Analytics instead.';
      }

      const rowCap = maxRows ?? DEFAULT_MAX_ROWS;

      // Capture sp_readerrorlog into a temp table so we can cap rows, order
      // newest-first, and report how many entries actually matched. Values are
      // bound as parameters (safe); no identifiers are interpolated.
      const query = `
SET NOCOUNT ON;
-- A failed earlier call can leave #errlog on the pooled connection.
IF OBJECT_ID('tempdb..#errlog') IS NOT NULL DROP TABLE #errlog;
CREATE TABLE #errlog (
  LogDate     DATETIME,
  ProcessInfo NVARCHAR(100),
  LogText     NVARCHAR(MAX)
);
INSERT INTO #errlog (LogDate, ProcessInfo, LogText)
EXEC sys.sp_readerrorlog @logNumber, @logType, @search1, @search2;
SELECT TOP (@maxRows)
  LogDate          AS [Log Date],
  ProcessInfo      AS [Source],
  LogText          AS [Message],
  COUNT(*) OVER () AS [_total]
FROM #errlog
ORDER BY LogDate DESC;
DROP TABLE #errlog;`;

      let rows: Record<string, any>[];
      try {
        rows = await db.executeQuery<Record<string, any>>({
          query,
          parameters: {
            logNumber: logNumber ?? 0,
            logType: logType ?? 1,
            search1: search1 ?? null,
            search2: search2 ?? null,
            maxRows: rowCap,
          },
        });
      } catch (err) {
        // 15003 = "Only members of the securityadmin role can execute this
        // stored procedure."; 229 = EXECUTE permission denied.
        const number = (err as { number?: number }).number;
        if (number === 15003 || number === 229) {
          return (
            'This login is not allowed to read the error log. ' +
            'On SQL Server 2022+ / Managed Instance run: GRANT VIEW ANY ERROR LOG TO [<login>]; (in master). ' +
            'On SQL Server 2016-2019 it needs the securityadmin server role, which is not read-only and is not recommended.'
          );
        }
        throw err;
      }

      if (!rows || rows.length === 0) {
        return 'No matching entries in the error log.';
      }

      const total = Number(rows[0]['_total']) || rows.length;
      const display = rows.map((r) => ({
        'Log Date': r['Log Date'],
        Source: r['Source'],
        Message: r['Message'],
      }));
      const table = toMarkdownTable(display);

      if (total > rows.length) {
        return `${table}\n\n_Showing newest ${rows.length} of ${total} matching entries. Add a filter (search1/search2) or raise maxRows to see more._`;
      }
      return table;
    },
  };
}
