#!/usr/bin/env node
// Calls every tool once against a real SQL Server, over stdio, like an MCP client does.
// Then sends the review's bypass payloads to mssql_run_select and checks nothing changed.
// Usage: npm run build && node scripts/smoke-test.mjs [databaseName]
// Connection settings come from the environment or ./.env (the server reads it itself).
// With CI=true a skipped tool counts as a failure.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const database = process.argv[2] ?? 'StackOverflow';
const strict = process.env.CI === 'true';
const ARGS = {
  mssql_wait_stats: { topN: 5 },
  mssql_top_queries: { topN: 10, sortBy: 'logical_reads' },
  mssql_error_log: { maxRows: 5 },
  mssql_table_info: { tableNames: ['Posts', 'Votes'] },
  mssql_table_index_health: { tableNames: ['Posts', 'Users'] },
  mssql_table_missing_indexes: { tableNames: ['Votes', 'Posts'] },
  mssql_run_select: { selectQuery: 'SELECT TOP (3) name, create_date FROM sys.tables ORDER BY name' },
};

const client = new Client({ name: 'smoke-test', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../build/index.js', import.meta.url))], env: process.env, stderr: 'inherit' })
);

const { tools } = await client.listTools();
const call = (name, args, planHandle) =>
  client.callTool({ name, arguments: name === 'mssql_execution_plan' ? { ...args, queryPlanHandle: planHandle } : args });
let planHandles = [];
let failed = 0;
for (const tool of tools) {
  const args = { ...(ARGS[tool.name] ?? {}) };
  if ('databaseName' in (tool.inputSchema.properties ?? {}) && tool.name !== 'mssql_run_select') {
    args.databaseName = database;
  }
  if (tool.name === 'mssql_execution_plan') {
    if (!planHandles.length) {
      console.log(`SKIP ${tool.name}: no plan handle from mssql_top_queries`);
      if (strict) failed += 1;
      continue;
    }
  }
  const started = Date.now();
  let result = await call(tool.name, args, planHandles[0]);
  // Some cached plans cannot be returned as XML; try the next handle until one is.
  for (const handle of tool.name === 'mssql_execution_plan' ? planHandles.slice(1) : []) {
    if (result.isError || result.content?.[0]?.text?.startsWith('```xml')) break;
    result = await call(tool.name, args, handle);
  }
  const text = result.content?.[0]?.text ?? '';
  if (tool.name === 'mssql_top_queries') planHandles = text.match(/0x[0-9A-F]{20,}/gi) ?? [];
  const noPlan = tool.name === 'mssql_execution_plan' && !text.startsWith('```xml');
  const status = result.isError || (strict && noPlan) ? 'FAIL' : 'ok  ';
  if (status === 'FAIL') failed += 1;
  const preview = text.replace(/\s+/g, ' ').slice(0, 110);
  console.log(`${status} ${tool.name.padEnd(32)} ${String(Date.now() - started).padStart(5)} ms ${String(text.length).padStart(6)} chars  ${preview}`);
}
console.log(`\n${tools.length} tools, ${failed} failed`);

// Bypass payloads: each must be rejected, and the database must look the same afterwards.
const runSelect = (selectQuery) =>
  client.callTool({ name: 'mssql_run_select', arguments: { selectQuery, databaseName: database } });
// The login cannot read table data (no db_datareader), so read row counts from metadata.
const STATE_QUERY = `SELECT
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.index_id IN (0, 1)) AS TableRows,
  (SELECT STUFF((SELECT ', ' + OBJECT_SCHEMA_NAME(p.object_id) + '.' + OBJECT_NAME(p.object_id) + '=' + CAST(p.rows AS varchar(20))
     FROM sys.partitions p JOIN sys.tables t ON t.object_id = p.object_id WHERE p.index_id IN (0, 1)
     ORDER BY 1 FOR XML PATH('')), 1, 2, '')) AS RowsPerTable,
  (SELECT SUM(s.user_updates) FROM sys.dm_db_index_usage_stats s WHERE s.database_id = DB_ID()) AS UserUpdates,
  (SELECT COUNT(*) FROM sys.objects) AS Objects, (SELECT MAX(modify_date) FROM sys.objects) AS LastObjectChange,
  (SELECT COUNT(*) FROM sys.indexes) AS Indexes, (SELECT COUNT(*) FROM sys.database_principals) AS DbUsers,
  (SELECT COUNT(*) FROM sys.server_principals) AS Logins, (SELECT COUNT(*) FROM sys.databases) AS DatabaseCount,
  (SELECT COUNT(*) FROM msdb.dbo.sysjobs) AS Jobs`;
const stateOf = async () => {
  const result = await runSelect(STATE_QUERY);
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`state query failed: ${text}`);
  return text;
};
const payloads = JSON.parse(readFileSync(new URL('bypass-payloads.json', import.meta.url), 'utf8'));
const before = await stateOf();
let passed = 0;
for (const [name, query] of Object.entries(payloads)) {
  const result = await runSelect(query);
  if (result.isError) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL bypass ${name} was not rejected`);
  }
}
const after = await stateOf();
if (after !== before) {
  failed += 1;
  console.log(`FAIL database changed after the bypass payloads\nbefore:\n${before}\nafter:\n${after}`);
}
console.log(`${passed} of ${Object.keys(payloads).length} bypass payloads rejected, database ${after === before ? 'unchanged' : 'CHANGED'}`);
console.log(`\n${failed} failed in total`);
await client.close();
process.exit(failed ? 1 : 0);
