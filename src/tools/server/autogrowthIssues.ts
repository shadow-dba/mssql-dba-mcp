import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function autogrowthIssuesTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_autogrowth_issues',
    title: 'Get File Autogrowth Issues',
    description:
      'Autogrowth issues: data and log files with percent growth, tiny growth (1 MB or less) or autogrowth off, largest files first. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'File autogrowth is managed by the platform on Azure SQL Database. Check the database max size instead.';
      }
      const query = `
SELECT
  DB_NAME(database_id) AS [Database],
  name                 AS [Logical Name],
  type_desc            AS [Type],
  CASE WHEN is_percent_growth = 1
       THEN CAST(growth AS VARCHAR(10)) + ' %'
       ELSE CAST(CAST(growth * 8.0 / 1024 AS DECIMAL(18,1)) AS VARCHAR(32)) + ' MB' END AS [Autogrowth],
  CAST(CAST(size AS BIGINT) * 8 / 1024.0 AS DECIMAL(18,1)) AS [Size MB],
  CASE
    WHEN is_percent_growth = 1 THEN 'WARN: percent growth, each growth gets bigger and slower'
    WHEN growth = 0           THEN 'WARN: autogrowth off, the file fails when full'
    ELSE 'WARN: tiny fixed growth (1 MB or less), causes many growth events'
  END AS [Issue]
FROM sys.master_files
WHERE type IN (0, 1)
  AND (is_percent_growth = 1 OR growth <= 128) -- 128 pages = 1 MB
ORDER BY size DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0)
        return 'No files with percent, tiny, or disabled autogrowth.';
      return toMarkdownTable(result);
    },
  };
}
