# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

An MCP server, published on npm as `@shadow-dba/mssql-dba-mcp`, that gives an AI read-only SQL Server DBA tools over stdio. It connects to one SQL Server (settings from env vars or `./.env`) and registers 42 tools named `mssql_*`. The brand promise is "AI can never modify your database"; every change must keep it true.

## Commands

```bash
npm test               # all src/**/*.test.ts (node --test + tsx); no database needed
npm run typecheck      # tsc --noEmit
npm run build          # deletes build/, compiles, makes build/index.js executable
node build/index.js    # run the server (needs DB_* settings; talks MCP over stdio)
```

Run one suite: `node --import tsx --test src/sql/validateReadOnly.test.ts`. Formatting: Prettier (`.prettierrc`: single quotes, 2 spaces, semicolons). No lint script.

## Layout

```
src/
  index.ts        bin: reads ./.env, checks the login, connects stdio, shutdown
  server.ts       McpServer: instructions, registration loop, annotations, output cap
  db.ts           Db: one mssql ConnectionPool; executeQuery, queryCapped (streams, cancels)
  config.ts       env -> mssql config; loadDotEnv()
  loginCheck.ts   refuses sysadmin / CONTROL SERVER / db_owner logins
  tools/
    index.ts      createTools(db): the single registry, in tools/list order
    types.ts      ToolDescriptor
    server/       instance-wide tools
    database/     one database (databaseName) and the given tables (tableNames)
    query/        runSelect.ts: mssql_run_select, the AI's own SELECT
  sql/            validateReadOnly, identifiers, versionGuards, markdown, edition (+ *.test.ts)
```

## Tool pattern

Each tool is a factory `xxxTool(db: Db): ToolDescriptor` returning `{ name, title, description, inputSchema (ZodRawShape), alwaysLoad?, handler }`. The handler returns Markdown and may throw; `server.ts` turns a throw into an `isError` result, sets the annotations (`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`) for every tool, adds `_meta["anthropic/alwaysLoad"]` when `alwaysLoad` is set, and cuts any reply over `MAX_OUTPUT_CHARS`.

Adding a tool: create the file under `tools/server` or `tools/database`, add it to `createTools` in `tools/index.ts`, add it to the README tool list and `CHANGELOG.md`.

- **Names:** `mssql_` + snake_case, `db` (never database/databases), no `get_` prefix. Renaming breaks users.
- **Descriptions:** search keywords first (clients that defer tools match only the start), then what it returns, then limits ("Not available on Azure SQL Database"). Keep `alwaysLoad` to 3-5 tools.
- **Output:** use `toMarkdownTable(rows, { maxRows, total, hint })` from `sql/markdown.ts`; it caps rows (default 200) and adds "Showing N of M". Never return unbounded text; the plan XML has its own cap.
- **Examples** in code, tests and docs use only the StackOverflow sample database: `dbo.Badges, Comments, LinkTypes, PostHistory, PostHistoryTypes, PostLinks, Posts, PostTypes, Tags, Users, Votes, VoteTypes` (plus `lab.History`, `lab.Run`). Never names or data from a real company.

## Security model (core invariant)

Read-only in three layers; keep all three.

1. **The login** (`loginCheck.ts`). On the first connection the server reads `IS_SRVROLEMEMBER('sysadmin')`, `HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER')` and `IS_ROLEMEMBER('db_owner')` and throws `LoginCheckError` (never retried) unless `MSSQL_ALLOW_PRIVILEGED_LOGIN=true`. This is the real guarantee.
2. **Tool SQL is fixed.** Values go through `parameters` (bound). Identifiers that must be interpolated (`databaseName`, `tableNames`) pass `validateSqlIdentifier(s)` from `sql/identifiers.ts` first, and are then embedded as escaped N'' literals or via `QUOTENAME`.
3. **The AI's own SQL** (`mssql_run_select`) passes `validateReadOnlyQuery` (`sql/validateReadOnly.ts`): a lexer (strings, N-strings, `".."`, `[..]`, `--`, nested `/* */`) and an allowlist on the tokens (one statement, starts with SELECT or WITH, no word from `FORBIDDEN_WORDS`). Only make it stricter, and add a test for every case. Tool SQL does not go through it, so `sp_executesql` inside a tool is fine.

No session state may leak between calls on the pooled connection: never `USE` (use three-part names like `msdb.dbo.sysjobs`, or `runInDatabaseSql`), never leave a `SET` option changed, and drop any `#temp` table at the start of the batch if it might exist.

## Version and edition compatibility

Targets SQL Server 2016+, Azure SQL Database (EngineEdition 5) and Managed Instance (8). Guards: `sql/versionGuards.ts` (SQL fragments, unit-tested) and `sql/edition.ts` (`isAzureSqlDb` and friends at runtime).

1. Run SQL in another database with `runInDatabaseSql(dbName, innerSql)` (cross-database `sp_executesql`; on Azure SQL DB only the current database).
2. Prefer syntax that works everywhere: `FOR XML PATH('')` + `STUFF`, not `STRING_AGG` (2017+).
3. msdb, SQL Agent, backup history, `sys.dm_os_volume_stats` and `DBCC DBINFO` do not exist on Azure SQL DB: check `isAzureSqlDb(db)` and return a clear "not available" message.
4. Feature-detect with `columnExistsExpr` / `objectExistsExpr`, not version numbers.

## Permission model

Tools must work with the README login: `VIEW SERVER STATE`, `VIEW ANY DEFINITION`, `CONNECT ANY DATABASE`, `VIEW ANY ERROR LOG` (2022+ / MI), and in msdb `SELECT` on `backupset, backupmediafamily, suspect_pages, sysjobs, sysjobhistory, sysjobschedules, sysschedules, sysalerts, sysoperators` (no Agent roles, no `db_datareader`: job steps can hold passwords).

1. Never require a permission that can change something (`sysadmin`, `securityadmin`, `db_owner`, `ALTER`, `CONTROL`, Agent roles). Find a read-only source first.
2. If none exists, fail clearly: catch the permission error (229, 15003, ...) and name the missing permission, or show the row as `UNKNOWN`.
3. A tool that reads a new msdb table or needs a new grant must update the README script, the permission table and the "Limits" list.
4. Database tools default to `DB_NAME` when `databaseName` is omitted (`databaseName || db.name`).

## TypeScript / ESM

`type: module` with Node16 resolution: relative imports end in `.js` even in `.ts` files. `strict` is on; target ES2022. Tests are excluded from the build.

## Configuration

Required: `DB_AUTH_TYPE` (`sql` | `windows`), `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Optional: `DB_PORT`, `DB_DOMAIN`, `ENCRYPT`, `TRUST_SERVER_CERTIFICATE`, `REQUEST_TIMEOUT`, `MAX_POOL`, `MIN_POOL`, `IDLE`, `MSSQL_ALLOW_PRIVILEGED_LOGIN`. `loadDotEnv()` reads `./.env`; variables already set win.
