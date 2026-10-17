import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

export function agentJobsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_agent_jobs',
    title: 'Get SQL Agent Scheduled Jobs',
    description:
      'SQL Agent jobs: every job with its schedule, frequency, interval and last run status. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'SQL Server Agent is not available on Azure SQL Database. Use Azure Automation, Elastic Jobs, or the managed maintenance features instead.';
      }
      const query = `
SELECT
  j.name            AS [Job Name],
  j.[description]   AS [Description],
  j.enabled         AS [Job Enabled],
  sch.name          AS [Schedule Name],
  sch.enabled       AS [Schedule Enabled],
  CASE sch.freq_type
    WHEN 1   THEN 'Once'
    WHEN 4   THEN 'Daily'
    WHEN 8   THEN 'Weekly'
    WHEN 16  THEN 'Monthly'
    WHEN 32  THEN 'Monthly relative'
    WHEN 64  THEN 'On SQL Agent start'
    WHEN 128 THEN 'On idle'
  END AS [Frequency],
  CASE
    WHEN sch.freq_subday_type = 1 THEN 'At ' + STUFF(STUFF(RIGHT('000000' + CAST(sch.active_start_time AS VARCHAR(6)), 6), 3, 0, ':'), 6, 0, ':')
    WHEN sch.freq_subday_type = 2 THEN 'Every ' + CAST(sch.freq_subday_interval AS VARCHAR) + ' seconds'
    WHEN sch.freq_subday_type = 4 THEN 'Every ' + CAST(sch.freq_subday_interval AS VARCHAR) + ' minutes'
    WHEN sch.freq_subday_type = 8 THEN 'Every ' + CAST(sch.freq_subday_interval AS VARCHAR) + ' hours'
  END AS [Interval],
  sjh.run_status    AS [Last Run Status],
  sjh.run_date      AS [Last Run Date],
  sjh.run_time      AS [Last Run Time]
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.sysjobschedules js ON j.job_id = js.job_id
LEFT JOIN msdb.dbo.sysschedules sch   ON js.schedule_id = sch.schedule_id
LEFT JOIN (
  SELECT job_id, run_status, run_date, run_time,
         ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY run_date DESC, run_time DESC) AS rn
  FROM msdb.dbo.sysjobhistory
  WHERE step_id = 0
) sjh ON j.job_id = sjh.job_id AND sjh.rn = 1
ORDER BY j.name;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No scheduled jobs found.';
      return toMarkdownTable(result);
    },
  };
}
