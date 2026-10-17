import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

const CORRUPTION_ERRORS = [823, 824, 825];
const CRITICAL_SEVERITIES = [19, 20, 21, 22, 23, 24, 25];

interface AlertRow {
  Alert: string;
  'Message Id': number;
  Severity: number;
  Enabled: number;
  'Has Notification': number;
  Occurrences: number;
}

export function agentAlertsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_agent_alerts',
    title: 'Get SQL Agent Alerts Health',
    description:
      'SQL Agent alerts: checks alerts for corruption errors 823/824/825 and severities 19-25 and whether an enabled operator gets them, and lists all alerts and operators. Missing corruption alerts become CRITICAL when msdb.dbo.suspect_pages has rows. Not available on Azure SQL Database.',
    inputSchema: {},
    handler: async () => {
      if (await isAzureSqlDb(db)) {
        return 'SQL Server Agent alerts and operators are not available on Azure SQL Database. Use Azure Monitor alerts instead.';
      }

      const alertsQuery = `
SELECT
  a.name             AS [Alert],
  a.message_id       AS [Message Id],
  a.severity         AS [Severity],
  a.enabled          AS [Enabled],
  a.has_notification AS [Has Notification],
  a.occurrence_count AS [Occurrences]
FROM msdb.dbo.sysalerts a
ORDER BY a.message_id, a.severity, a.name;`;

      const operatorsQuery = `
SELECT
  o.name          AS [Operator],
  o.enabled       AS [Enabled],
  o.email_address AS [Email]
FROM msdb.dbo.sysoperators o
ORDER BY o.name;`;

      const suspectQuery = `SELECT COUNT(*) AS cnt FROM msdb.dbo.suspect_pages;`;

      const [alerts, operators, suspect] = await Promise.all([
        db.executeQuery<AlertRow>({ query: alertsQuery }),
        db.executeQuery<Record<string, any>>({ query: operatorsQuery }),
        db.executeQuery<{ cnt: number }>({ query: suspectQuery }),
      ]);

      const hasSuspectPages = (suspect?.[0]?.cnt ?? 0) > 0;

      const coverage = (
        label: string,
        matches: (a: AlertRow) => boolean,
        missingLevel: string
      ) => {
        const found = alerts.filter(matches);
        let status: string;
        if (found.length === 0) status = `${missingLevel}: no alert defined`;
        else if (!found.some((a) => a.Enabled === 1))
          status = `${missingLevel}: alert exists but is disabled`;
        else if (!found.some((a) => a.Enabled === 1 && a['Has Notification'] > 0))
          status = 'WARN: enabled but notifies no operator';
        else status = 'OK';
        return { Check: label, Status: status };
      };

      const corruptionLevel = hasSuspectPages ? '🔴 CRITICAL' : 'WARN';
      const coverageRows = [
        ...CORRUPTION_ERRORS.map((id) =>
          coverage(`Error ${id}`, (a) => a['Message Id'] === id, corruptionLevel)
        ),
        ...CRITICAL_SEVERITIES.map((sev) =>
          coverage(
            `Severity ${sev}`,
            (a) => a['Message Id'] === 0 && a.Severity === sev,
            'WARN'
          )
        ),
        {
          Check: 'Enabled operator',
          Status: operators.some((o) => o['Enabled'] === 1)
            ? 'OK'
            : 'WARN: no enabled operator, alerts have nowhere to go',
        },
      ];

      const sections: string[] = [];
      sections.push(
        `## Alert coverage\n\n${
          hasSuspectPages
            ? '🔴 msdb..suspect_pages has rows: corruption is already recorded on this server.\n\n'
            : ''
        }${toMarkdownTable(coverageRows)}`
      );
      sections.push(
        `## Defined alerts\n\n${
          alerts.length ? toMarkdownTable(alerts) : '_No alerts defined._'
        }`
      );
      sections.push(
        `## Operators\n\n${
          operators.length ? toMarkdownTable(operators) : '_No operators defined._'
        }`
      );
      return sections.join('\n\n');
    },
  };
}
