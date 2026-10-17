#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConnectionConfig, loadDotEnv } from './config.js';
import { Db, LoginCheckError } from './db.js';
import { checkLogin } from './loginCheck.js';
import { createServer } from './server.js';

async function main() {
  const envFile = loadDotEnv();
  if (envFile) console.error(`Read settings from ${envFile}`);

  const db = new Db(loadConnectionConfig(), (conn) => checkLogin(conn));

  // Check the login before serving tools. If the server cannot be reached now, start
  // anyway: the check runs again on the first tool call, before any query.
  try {
    await db.connect();
  } catch (error) {
    if (error instanceof LoginCheckError) throw error;
    console.error(`Could not connect yet: ${error instanceof Error ? error.message : error}`);
  }

  const server = createServer(db);
  await server.connect(new StdioServerTransport());
  console.error('mssql-dba-mcp running on stdio');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}, closing the connection pool...`);
    await db.disconnect().catch((error) => console.error('Error closing pool:', error));
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
