import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from './db.js';
import { createTools } from './tools/index.js';
import { capText } from './sql/markdown.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** Claude Code warns at 10k tokens of tool output; ~4 chars per token. */
export const MAX_OUTPUT_CHARS = 40_000;

export const INSTRUCTIONS = `SQL Server (MSSQL) DBA tools, read-only: health check, performance, wait stats, slow queries, execution plans, blocking, indexes, missing indexes, fragmentation, backups, CHECKDB and corruption, SQL Agent jobs and alerts, error log, tempdb, VLFs, autogrowth, configuration, security (sysadmin logins, database owners), schema design (keys, foreign keys, identity headroom, column types, collation).

How to start:
- Health check: mssql_server_version, then mssql_wait_stats, mssql_top_queries, mssql_storage_capacity, mssql_recent_backups, mssql_checkdb_status, mssql_agent_failed_jobs.
- "Slow right now": mssql_wait_stats with sampleSeconds=5, mssql_running_requests, mssql_blocking.
- Slow query: mssql_top_queries, then mssql_execution_plan with its Plan Handle.
- One database: mssql_db_info, mssql_db_tables, mssql_db_index_health, mssql_db_missing_indexes. Pass databaseName to reach any database on the instance.
- Anything else: mssql_run_select (one SELECT; system views and DMVs).

Every tool only reads. Output is Markdown, capped in rows and characters; narrow with the tool's filters when it says "Showing N of M". Suggest fixes (CREATE INDEX, ALTER ...) as scripts for the user to review and run; this server cannot run them.`;

export function createServer(db: Db): McpServer {
  const server = new McpServer(
    { name: 'mssql-dba-mcp', title: 'SQL Server DBA (read-only)', version },
    { instructions: INSTRUCTIONS }
  );

  for (const tool of createTools(db)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        ...(tool.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
      },
      async (args) => {
        try {
          const text = await tool.handler(args as Record<string, unknown>);
          return { content: [{ type: 'text', text: capText(text, MAX_OUTPUT_CHARS) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
        }
      }
    );
  }
  return server;
}
