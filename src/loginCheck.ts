import { LoginCheckError, type Db } from './db.js';

export const ALLOW_PRIVILEGED_ENV = 'MSSQL_ALLOW_PRIVILEGED_LOGIN';

export interface LoginRights {
  login: string;
  database: string;
  isSysadmin: boolean;
  hasControlServer: boolean;
  isDbOwner: boolean;
}

// Azure SQL Database (EngineEdition 5) has no server roles, so only db_owner is checked there.
// Its server admin and Entra admin map to dbo, so they are caught by IS_ROLEMEMBER too.
const RIGHTS_QUERY = `
DECLARE @azureDb BIT = CASE WHEN CAST(SERVERPROPERTY('EngineEdition') AS INT) = 5 THEN 1 ELSE 0 END;
SELECT
  SUSER_SNAME()                                                   AS login,
  DB_NAME()                                                       AS [database],
  CASE WHEN @azureDb = 0 AND IS_SRVROLEMEMBER('sysadmin') = 1 THEN 1 ELSE 0 END AS isSysadmin,
  CASE WHEN @azureDb = 0 AND HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') = 1 THEN 1 ELSE 0 END AS hasControlServer,
  CASE WHEN IS_ROLEMEMBER('db_owner') = 1 THEN 1 ELSE 0 END        AS isDbOwner;`;

/** The rights that make a login able to change the server, as plain words. Empty = read-only enough. */
export function privilegedRights(r: LoginRights): string[] {
  const found: string[] = [];
  if (r.isSysadmin) found.push('member of sysadmin');
  if (r.hasControlServer) found.push('has CONTROL SERVER');
  if (r.isDbOwner) found.push(`db_owner in ${r.database}`);
  return found;
}

/**
 * Refuses a login that can change the server. The read-only login is the real guarantee
 * behind "AI can never modify your database"; the SELECT check is only the second layer.
 */
export async function checkLogin(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [row] = await db.executeQuery<Record<string, unknown>>({ query: RIGHTS_QUERY });
  const rights: LoginRights = {
    login: String(row.login),
    database: String(row.database),
    isSysadmin: row.isSysadmin === 1,
    hasControlServer: row.hasControlServer === 1,
    isDbOwner: row.isDbOwner === 1,
  };
  const found = privilegedRights(rights);
  if (found.length === 0) return;

  const what = `Login "${rights.login}" is not read-only (${found.join(', ')}).`;
  if (env[ALLOW_PRIVILEGED_ENV] === 'true') {
    console.error(
      [
        '',
        '!!! WARNING !!!',
        `${what}`,
        `${ALLOW_PRIVILEGED_ENV}=true, so the server runs anyway.`,
        'The AI can now change or destroy data if the SELECT check is ever bypassed.',
        'Use a read-only login: see "Permissions" in the README.',
        '',
      ].join('\n')
    );
    return;
  }
  throw new LoginCheckError(
    `${what} mssql-dba-mcp refuses to run with it. ` +
      'Create the read-only login from the README ("Permissions") and put it in DB_USER. ' +
      `To run anyway (not recommended), set ${ALLOW_PRIVILEGED_ENV}=true.`
  );
}
