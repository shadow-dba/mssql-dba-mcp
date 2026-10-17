import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function agentFailedJobsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_agent_failed_jobs',
    title: 'Get Failed SQL Agent Jobs',
    description:
      'SQL Agent failed jobs: jobs that failed in the last 7 days, with date, time and error message. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'SQL Server Agent is not available on Azure SQL Database. Use Azure Automation, Elastic Jobs, or the managed maintenance features instead.';
      }
      const query = `
SELECT
  j.name        AS [Job Name],
  sjh.run_date  AS [Run Date],
  sjh.run_time  AS [Run Time],
  sjh.message   AS [Error Message]
FROM msdb.dbo.sysjobs j
INNER JOIN msdb.dbo.sysjobhistory sjh ON j.job_id = sjh.job_id
WHERE sjh.run_status = 0
  AND sjh.run_date >= CONVERT(INT, CONVERT(VARCHAR(8), DATEADD(DAY, -7, GETDATE()), 112))
  AND sjh.step_id = 0
ORDER BY sjh.run_date DESC, sjh.run_time DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No failed jobs in the last 7 days.';
      return toMarkdownTable(result);
    },
  };
}
