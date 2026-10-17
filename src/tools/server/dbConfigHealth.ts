import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function dbConfigHealthTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_db_config_health',
    title: 'Get Databases Config Health',
    description:
      'Database settings health for every online user database: compatibility level, recovery model, page verify, auto close, auto shrink, auto statistics, target recovery time and Query Store, with Flags for risky values. onlyFlagged=true (default) returns only flagged databases.',
    inputSchema: {
      onlyFlagged: z
        .boolean()
        .default(true)
        .describe('Return only databases with at least one flag. Set false to return all.'),
    },
    handler: async ({ onlyFlagged = true }: { onlyFlagged?: boolean }) => {
      // ProductMajorVersion reports 12 on Azure SQL DB / Managed Instance, so
      // there the native level is taken from master, which always runs at it.
      const query = `
DECLARE @native INT =
  CASE WHEN CAST(SERVERPROPERTY('EngineEdition') AS INT) IN (5, 8)
       THEN (SELECT compatibility_level FROM sys.databases WHERE name = 'master')
       ELSE CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) * 10 END;
SELECT
  name                            AS [Database],
  compatibility_level             AS [Compat Level],
  @native                         AS [Native Compat],
  recovery_model_desc             AS [Recovery Model],
  page_verify_option_desc         AS [Page Verify],
  is_auto_close_on                AS [Auto Close],
  is_auto_shrink_on               AS [Auto Shrink],
  is_auto_create_stats_on         AS [Auto Create Stats],
  is_auto_update_stats_on         AS [Auto Update Stats],
  target_recovery_time_in_seconds AS [Target Recovery Sec],
  is_query_store_on               AS [Query Store]
FROM sys.databases
WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
  AND state_desc = 'ONLINE'
ORDER BY name;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No online user databases found.';

      const rows = result.map((r) => {
        const flags: string[] = [];
        if (r['Auto Close']) flags.push('auto close ON');
        if (r['Auto Shrink']) flags.push('auto shrink ON');
        if (r['Page Verify'] !== 'CHECKSUM') flags.push('page verify not CHECKSUM');
        if (!r['Auto Create Stats']) flags.push('auto create stats OFF');
        if (!r['Auto Update Stats']) flags.push('auto update stats OFF');
        if (r['Target Recovery Sec'] === 0) flags.push('indirect checkpoint OFF');
        if (!r['Query Store']) flags.push('Query Store OFF');
        if (r['Native Compat'] && r['Compat Level'] < r['Native Compat'])
          flags.push('compat level below native');
        return { ...r, Flags: flags.join('; ') };
      });

      const shown = onlyFlagged ? rows.filter((r) => r.Flags) : rows;
      if (shown.length === 0) return 'No flagged database settings.';
      return toMarkdownTable(shown);
    },
  };
}
