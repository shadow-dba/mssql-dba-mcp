import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function serverVersionTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_server_version',
    title: 'Get Server Version',
    description:
      'Server version, edition, patch level (CU), collation, clustering/HADR and licensing. Call first in any health check.',
    alwaysLoad: true,
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  SERVERPROPERTY('ProductVersion')      AS [Product Version],
  SERVERPROPERTY('ProductLevel')        AS [Product Level],
  SERVERPROPERTY('ProductUpdateLevel')  AS [Product Update Level],
  SERVERPROPERTY('ProductUpdateReference') AS [Product Update Reference],
  SERVERPROPERTY('Edition') AS [Edition],
  CASE WHEN SERVERPROPERTY('EngineEdition') = 3 THEN 'Yes' ELSE 'No' END AS [Is Enterprise],
  SERVERPROPERTY('ServerName')    AS [Server Name],
  SERVERPROPERTY('Collation')     AS [Server Collation],
  SERVERPROPERTY('IsClustered')   AS [Is Clustered],
  SERVERPROPERTY('IsHadrEnabled') AS [Is HADR Enabled],
  SERVERPROPERTY('LicenseType')   AS [License Type],
  SERVERPROPERTY('NumLicenses')   AS [Num Licenses];`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No server information found.';
      return toMarkdownTable(result);
    },
  };
}
