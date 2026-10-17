import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';
import { isAzureSqlDb } from '../../sql/edition.js';

function isBuiltIn(name: string, isSa: boolean): boolean {
  const upper = name.toUpperCase();
  return (
    isSa ||
    upper.startsWith('NT SERVICE\\') ||
    upper === 'NT AUTHORITY\\SYSTEM' ||
    upper.startsWith('##')
  );
}

export function privilegedLoginsTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_privileged_logins',
    title: 'Get Privileged Logins',
    description:
      'Security: members of the sysadmin and securityadmin server roles, each marked Expected (in expectedAccounts), Built-in (sa, NT SERVICE\\*, NT AUTHORITY\\SYSTEM, ##...##) or REVIEW. Needs VIEW ANY DEFINITION to see all members. Not available on Azure SQL Database.',
    inputSchema: {
      expectedAccounts: z
        .array(z.string())
        .optional()
        .describe(
          'Logins expected to hold these roles (e.g. service or DBA accounts). Case-insensitive. They are marked Expected instead of REVIEW.'
        ),
    },
    handler: async ({ expectedAccounts }: { expectedAccounts?: string[] }) => {
      if (await isAzureSqlDb(db)) {
        return 'Server roles sysadmin / securityadmin do not exist on Azure SQL Database. Review the server admin, the Microsoft Entra admin, and members of the ##MS_...## server roles in the master database instead.';
      }

      const membersQuery = `
SELECT
  r.name                                   AS [Role],
  m.name                                   AS [Member],
  m.type_desc                              AS [Member Type],
  m.is_disabled                            AS [Disabled],
  CONVERT(VARCHAR(19), m.create_date, 120) AS [Created],
  CASE WHEN m.sid = 0x01 THEN 1 ELSE 0 END AS isSa
FROM sys.server_role_members rm
JOIN sys.server_principals r ON rm.role_principal_id = r.principal_id
JOIN sys.server_principals m ON rm.member_principal_id = m.principal_id
WHERE r.name IN ('sysadmin', 'securityadmin')
ORDER BY r.name, m.name;`;

      const permQuery = `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW ANY DEFINITION') AS canView;`;

      const [members, perm] = await Promise.all([
        db.executeQuery<Record<string, any>>({ query: membersQuery }),
        db.executeQuery<{ canView: number }>({ query: permQuery }),
      ]);

      const expected = new Set(
        (expectedAccounts ?? []).map((a) => a.trim().toUpperCase())
      );
      const rows = members.map(({ isSa, ...row }) => {
        const name = String(row['Member']);
        let flag = 'REVIEW: not an expected account';
        if (expected.has(name.toUpperCase())) flag = 'Expected';
        else if (isBuiltIn(name, isSa === 1)) flag = 'Built-in';
        return { ...row, Flag: flag };
      });
      rows.sort(
        (a, b) =>
          Number(b.Flag.startsWith('REVIEW')) -
          Number(a.Flag.startsWith('REVIEW'))
      );

      const notes: string[] = [];
      if (perm?.[0]?.canView !== 1)
        notes.push(
          '⚠️ The login lacks VIEW ANY DEFINITION, so only some role members are visible. This list is incomplete.'
        );
      const reviewCount = rows.filter((r) => r.Flag.startsWith('REVIEW')).length;
      notes.push(`**${reviewCount} member(s) need review.**`);

      if (rows.length === 0)
        return `${notes.join('\n\n')}\n\n_No members found._`;
      return `${notes.join('\n\n')}\n\n${toMarkdownTable(rows)}`;
    },
  };
}
