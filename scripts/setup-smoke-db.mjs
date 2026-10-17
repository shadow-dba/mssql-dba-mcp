#!/usr/bin/env node
// Builds the smoke-test database on a throwaway SQL Server, as sa:
//   1. scripts/smoke-fixture.sql (a small StackOverflow-shaped database and one Agent job)
//   2. the README "Permissions" script for a SQL Server login, taken from README.md as it is
//   3. one run of the Agent job, so job history has a row
// Usage: SA_PASSWORD=... SMOKE_LOGIN_PASSWORD=... node scripts/setup-smoke-db.mjs [--drop]
// Optional: DB_HOST (localhost), DB_PORT (1433), SMOKE_DB (StackOverflow), SMOKE_LOGIN (shadow-dba).
// --drop removes what an earlier run made (only a database marked by the fixture, and its login).
import sql from 'mssql';
import { readFileSync } from 'node:fs';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};
const dbName = env('SMOKE_DB', 'StackOverflow');
const login = env('SMOKE_LOGIN', 'shadow-dba');
const jobName = `${dbName} smoke check`;
for (const name of [dbName, login]) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unsafe name: ${name}`);
}

const pool = new sql.ConnectionPool({
  server: env('DB_HOST', 'localhost'),
  port: Number(env('DB_PORT', '1433')),
  user: 'sa',
  password: env('SA_PASSWORD'),
  database: 'master',
  options: { encrypt: true, trustServerCertificate: true },
  requestTimeout: 120000,
  pool: { min: 1, max: 1 }, // one connection, so USE in the scripts carries over between batches
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retry(what, seconds, fn) {
  for (let left = seconds; ; left -= 2) {
    try {
      return await fn();
    } catch (err) {
      if (left <= 0) throw err;
      console.log(`waiting for ${what}: ${err.message}`);
      await sleep(2000);
    }
  }
}
const runBatches = async (text) => {
  for (const batch of text.split(/^\s*GO\s*$/im)) {
    if (batch.trim()) await pool.request().batch(batch);
  }
};

await retry('SQL Server', 120, () => pool.connect());

if (process.argv.includes('--drop')) {
  const marked = await pool.request().batch(
    `SELECT CAST(value AS nvarchar(128)) AS login FROM [${dbName}].sys.extended_properties
     WHERE class = 0 AND name = N'smoke_fixture_login'`
  );
  const madeLogin = marked.recordset[0]?.login;
  if (!madeLogin) throw new Error(`${dbName} was not made by this script; not dropping it`);
  await runBatches(`
    USE [master];
    ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE [${dbName}];
    EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = N'${dbName}';
    IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'${jobName}') EXEC msdb.dbo.sp_delete_job @job_name = N'${jobName}';
    GO
    USE [msdb];
    IF USER_ID(N'${madeLogin}') IS NOT NULL DROP USER [${madeLogin}];
    USE [master];
    IF SUSER_ID(N'${madeLogin}') IS NOT NULL DROP LOGIN [${madeLogin}];
  `);
  console.log(`dropped ${dbName}, its job and login ${madeLogin}`);
  await pool.close();
  process.exit(0);
}

// 1. The database.
const fixture = readFileSync(new URL('smoke-fixture.sql', import.meta.url), 'utf8');
await runBatches(fixture.replaceAll('$(DbName)', dbName));
console.log(`created ${dbName}`);

// 2. The login, with the README script itself, so CI tests what users run.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const loginScript = readme.match(/### SQL Server login[\s\S]*?```sql\n([\s\S]*?)```/)?.[1];
if (!loginScript?.includes("'YourStrongPasswordHere'")) throw new Error('README login script not found');
const exists = await pool.request().input('login', login).query('SELECT SUSER_ID(@login) AS id');
if (exists.recordset[0].id !== null) throw new Error(`Login ${login} already exists; set SMOKE_LOGIN to another name`);
const password = env('SMOKE_LOGIN_PASSWORD').replaceAll("'", "''");
await runBatches(
  loginScript.replaceAll("'YourStrongPasswordHere'", `'${password}'`).replaceAll('[shadow-dba]', `[${login}]`)
);
await pool.request().batch(
  `EXEC [${dbName}].sys.sp_addextendedproperty @name = N'smoke_fixture_login', @value = N'${login}'`
);
console.log(`created login ${login} with the README script`);

// 3. One job run. Agent starts a little after SQL Server, so retry.
await retry('SQL Server Agent', 120, () =>
  pool.request().input('job_name', jobName).execute('msdb.dbo.sp_start_job').then(() => undefined)
);
await retry('job history', 60, async () => {
  const history = await pool
    .request()
    .input('job', jobName)
    .query('SELECT COUNT(*) AS n FROM msdb.dbo.sysjobhistory h JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id WHERE j.name = @job AND h.step_id = 0');
  if (history.recordset[0].n === 0) throw new Error('no job history yet');
});
console.log(`ran job "${jobName}"`);
await pool.close();
