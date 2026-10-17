<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img alt="shadow-dba" src=".github/assets/logo-light.svg" width="360">
  </picture>
</p>

<h3 align="center">Read-only SQL Server DBA tools for AI agents.<br>AI can never modify your database.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@shadow-dba/mssql-dba-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@shadow-dba/mssql-dba-mcp"></a>
  <a href="https://github.com/shadow-dba/mssql-dba-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/shadow-dba/mssql-dba-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

`mssql-dba-mcp` is an [MCP](https://modelcontextprotocol.io) server. It gives Claude Code, Claude Desktop, Cursor, VS Code and other MCP clients 42 tools to look at a SQL Server the way a DBA does: health checks, wait stats, slow queries and their plans, blocking, indexes, backups, CHECKDB, Agent jobs, the error log, configuration, security and schema design.

It only looks. The AI can suggest a fix (an index, a setting, a script), but you decide whether to run it.

## Quick start

You need Node.js 20.12 or later and a SQL Server 2016+, Azure SQL Managed Instance or Azure SQL Database.

**1. Create a read-only login.** Run the [setup script](#permissions) as a sysadmin. The server refuses to start with `sa` or any other admin login.

**2. Add the server to your MCP client.** Claude Code:

```bash
claude mcp add mssql-dba \
  -e DB_AUTH_TYPE=sql -e DB_HOST=localhost -e DB_NAME=master \
  -e DB_USER=shadow-dba -e DB_PASSWORD='YourStrongPasswordHere' \
  -- npx -y @shadow-dba/mssql-dba-mcp
```

Other clients (Claude Desktop, Cursor, VS Code) use the same command in their JSON config:

```json
{
  "mcpServers": {
    "mssql-dba": {
      "command": "npx",
      "args": ["-y", "@shadow-dba/mssql-dba-mcp"],
      "env": {
        "DB_AUTH_TYPE": "sql",
        "DB_HOST": "localhost",
        "DB_NAME": "master",
        "DB_USER": "shadow-dba",
        "DB_PASSWORD": "YourStrongPasswordHere"
      }
    }
  }
}
```

To keep the password out of the client config, leave out `env` and put the same values in a `.env` file in the folder the client starts the server from (see [.env.example](.env.example)). The server reads `./.env` itself.

**3. Ask.** For example: *"Run a health check on this server"*, *"Why is the server slow right now?"* or *"Which indexes on dbo.Posts in StackOverflow are never used?"*

Want ready-made DBA skills (health check, plan analysis, index review) on top of these tools? Use the [shadow-dba CLI](https://github.com/shadow-dba/shadow-dba-cli): `npx shadow-dba workspace init` sets up a Claude Code workspace with this server and the skills.

## Safety: read-only in three layers

1. **A read-only login, checked at startup.** The [setup script](#permissions) grants only `VIEW` permissions and `SELECT` on a few msdb tables. At startup the server checks the login and **refuses to run** if it is a member of `sysadmin`, has `CONTROL SERVER`, or is `db_owner` in `DB_NAME`. This is the real guarantee: SQL Server itself blocks every change, whatever the AI sends.
2. **Tools that only read.** 41 of the 42 tools run fixed SQL written in this repo. They read system views and DMVs. They never run DBCC CHECKDB, never run the query behind a plan, and never change a setting.
3. **A strict check on the AI's own SQL.** `mssql_run_select` runs a query the AI writes. A lexer checks it first: exactly one statement, it must start with `SELECT` or `WITH`, and any word that writes, runs code or changes the session (`INSERT`, `UPDATE`, `EXEC`, `SET`, `USE`, `SELECT INTO`, `DBCC`, `BACKUP`, ...) rejects it. Strings, quoted names and comments cannot hide code. This matters because tool output contains text other people control (query text from the plan cache, error-log lines, object names), and a prompt injection in that text could ask the AI to send a crafted query.

Layer 3 is a second line of defense, not the guarantee. If you run with a privileged login (`MSSQL_ALLOW_PRIVILEGED_LOGIN=true`), a bypass of layer 3 could change your data. Found a bypass? See [SECURITY.md](SECURITY.md).

What the AI **can** see: metadata (names of databases, tables, columns, indexes, logins, jobs), server settings, query text in the plan cache and running requests (it can contain literal values), error-log lines and Agent job messages. By default it **cannot** read rows from your own tables.

## Tools

Every tool is read-only. Output is Markdown, capped at 200 rows per table and 40,000 characters per reply, with a "Showing N of M" note when something was cut. Database tools take an optional `databaseName` (default: `DB_NAME`).

**Start here**

| Tool | What it returns |
|---|---|
| `mssql_server_version` | Version, edition, patch level, collation, HADR, licensing. First call in a health check. |
| `mssql_wait_stats` | Top wait types. `sampleSeconds=5` shows what the server waits on right now. |
| `mssql_top_queries` | Top queries by CPU, reads, memory grant, spills, duration or executions, with plan handles. |
| `mssql_run_select` | One read-only `SELECT` the AI writes (system views, DMVs). Max 500 rows. |

**Performance, now**

| Tool | What it returns |
|---|---|
| `mssql_execution_plan` | Cached plan XML for a plan handle (never runs the query). |
| `mssql_running_requests` | Active requests: CPU, reads, waits, blocking, statement. |
| `mssql_blocking` | Blocked sessions and who blocks them. |
| `mssql_memory_pressure` | Page Life Expectancy. |
| `mssql_buffer_hit_ratio` | Buffer cache hit ratio. |
| `mssql_disk_io_latency` | Read/write latency per database file, rated. |
| `mssql_tempdb_health` | TempDB files, space use, top sessions. |

**Instance health**

| Tool | What it returns |
|---|---|
| `mssql_server_timezone` | Server time, UTC offset. |
| `mssql_storage_capacity` | Drives with less than 10% free space. |
| `mssql_server_config` | `sp_configure` settings with risky values flagged. |
| `mssql_error_log` | SQL Server or Agent error log, filtered, newest first. |
| `mssql_all_db_info` | Every database: state, recovery model, compatibility, size. |
| `mssql_offline_db` | Databases that are not ONLINE. |
| `mssql_db_config_health` | Risky database settings (auto shrink, page verify, Query Store, ...). |
| `mssql_db_owners` | Databases not owned by `sa`, orphaned owners. |
| `mssql_recent_backups` | Latest Full, Diff and Log backup per database. |
| `mssql_checkdb_status` | Last good CHECKDB per database, suspect pages. |
| `mssql_vlf_counts` | Databases with too many virtual log files. |
| `mssql_autogrowth_issues` | Files with percent, tiny or disabled autogrowth. |
| `mssql_agent_jobs` | SQL Agent jobs, schedules, last run. |
| `mssql_agent_failed_jobs` | Agent jobs that failed in the last 7 days. |
| `mssql_agent_alerts` | Alerts for errors 823/824/825 and severities 19-25, operators. |
| `mssql_privileged_logins` | Members of `sysadmin` and `securityadmin`. |

**One database**

| Tool | What it returns |
|---|---|
| `mssql_db_info` | State, recovery model, compatibility, size. |
| `mssql_db_collation` | Default collation. |
| `mssql_db_collation_mismatches` | Columns with a different collation. |
| `mssql_db_tables` | Every table: rows, size, keys, index health, workload. |
| `mssql_db_index_health` | Every index: usage, fragmentation, fill factor, maintenance script. |
| `mssql_db_missing_indexes` | Missing-index suggestions, ranked. |
| `mssql_db_backup_history` | Backups of the last 7 days. |
| `mssql_db_table_keys` | Heaps, tables without a primary key. |
| `mssql_db_foreign_keys` | Untrusted, disabled or unindexed foreign keys, likely missing ones. |
| `mssql_db_check_constraints` | Untrusted or disabled check constraints, with the fix. |
| `mssql_db_identity_headroom` | Identity columns close to their type limit. |
| `mssql_db_column_design_issues` | Deprecated and risky column types, too-wide rows. |
| `mssql_table_info` | Details for the given tables (`tableNames`). |
| `mssql_table_index_health` | Index health for the given tables. |
| `mssql_table_missing_indexes` | Missing indexes for the given tables. |

## Permissions

Run **one** of these scripts as a sysadmin. Each creates the login and grants what the tools need. Permissions are server-wide: database tools can look at any database, including ones created later.

### SQL Server login (`DB_AUTH_TYPE=sql`)

```sql
USE [master];
GO
CREATE LOGIN [shadow-dba] WITH PASSWORD = 'YourStrongPasswordHere';
GO
GRANT VIEW SERVER STATE    TO [shadow-dba];
GRANT VIEW ANY DEFINITION  TO [shadow-dba];
GRANT CONNECT ANY DATABASE TO [shadow-dba];
-- Error log access: this permission exists only on SQL Server 2022+ and Managed Instance.
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) >= 16
   OR SERVERPROPERTY('EngineEdition') = 8
  EXEC (N'GRANT VIEW ANY ERROR LOG TO [shadow-dba];');
GO

-- msdb: SELECT on exactly the tables the tools read. No Agent roles: SQLAgentReaderRole
-- can create and change jobs, and sysjobsteps (not granted) can hold passwords.
USE [msdb];
GO
CREATE USER [shadow-dba] FOR LOGIN [shadow-dba];
GRANT SELECT ON dbo.backupset         TO [shadow-dba];
GRANT SELECT ON dbo.backupmediafamily TO [shadow-dba];
GRANT SELECT ON dbo.suspect_pages     TO [shadow-dba];
GRANT SELECT ON dbo.sysjobs           TO [shadow-dba];
GRANT SELECT ON dbo.sysjobhistory     TO [shadow-dba];
GRANT SELECT ON dbo.sysjobschedules   TO [shadow-dba];
GRANT SELECT ON dbo.sysschedules      TO [shadow-dba];
GRANT SELECT ON dbo.sysalerts         TO [shadow-dba];
GRANT SELECT ON dbo.sysoperators      TO [shadow-dba];
GO
```

Then set `DB_USER=shadow-dba` and `DB_PASSWORD=YourStrongPasswordHere`.

### Windows login (`DB_AUTH_TYPE=windows`)

Same script with `CREATE LOGIN [DOMAIN\shadow-dba] FROM WINDOWS;` instead of the `CREATE LOGIN` line, and `[DOMAIN\shadow-dba]` instead of `[shadow-dba]` everywhere (`MACHINE\shadow-dba` for a local account). Set `DB_USER` and `DB_PASSWORD` to that account's name and password (NTLM cannot reuse your logged-in session), and `DB_DOMAIN` for a domain account.

### Azure SQL Database

There are no server permissions and no msdb. Run this in the database you set as `DB_NAME` (a contained user, so use `DB_AUTH_TYPE=sql`):

```sql
CREATE USER [shadow-dba] WITH PASSWORD = 'YourStrongPasswordHere';
GRANT VIEW DATABASE STATE TO [shadow-dba];
GRANT VIEW DEFINITION     TO [shadow-dba];
```

### What each permission is for

| Permission | Used for |
|---|---|
| `VIEW SERVER STATE` | Instance DMVs: waits, requests, memory, blocking, I/O, plan cache, VLFs. |
| `VIEW ANY DEFINITION` | Schema and index metadata in every database; the full member list for `mssql_privileged_logins`. |
| `CONNECT ANY DATABASE` | Enter every database (current and future) without a user in each one. |
| `VIEW ANY ERROR LOG` | `mssql_error_log` (SQL Server 2022+ and Managed Instance). |
| msdb `SELECT` on 9 tables | Backups and suspect pages (`backupset`, `backupmediafamily`, `suspect_pages`), Agent jobs (`sysjobs`, `sysjobhistory`, `sysjobschedules`, `sysschedules`), alerts (`sysalerts`, `sysoperators`). |

None of these can change data, schema or settings.

### Limits (on purpose)

Lifting these would need permissions that are not read-only, so the scripts do not grant them.

- **`mssql_error_log` on SQL Server 2016-2019** needs the `securityadmin` role, which can create logins and grant permissions. Without it the tool says "not allowed"; nothing else is affected.
- **`mssql_checkdb_status` on builds older than SQL Server 2016 SP2 / 2017 CU9** can only read the date from the database header (`DBCC DBINFO`, needs `sysadmin` or `db_owner`). Those databases show `UNKNOWN`.
- **`mssql_run_select` cannot read rows from your tables.** System views and DMVs are enough for DBA work, and this keeps business data away from the AI. To allow it anyway: `GRANT SELECT ALL USER SECURABLES TO [shadow-dba];` in master.
- **Azure SQL Database** sees only the database in `DB_NAME`. Instance tools (Agent, backups, error log, CHECKDB, logins) say they are not available there.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DB_AUTH_TYPE` | (required) | `sql` or `windows` (NTLM). |
| `DB_HOST` | (required) | Server name or IP. |
| `DB_NAME` | (required) | Database to connect to. Database tools default to it. |
| `DB_USER` | (required) | Login name. |
| `DB_PASSWORD` | (required) | Login password. |
| `DB_PORT` | `1433` | Server port. |
| `DB_DOMAIN` | | Windows auth with a domain account only. |
| `ENCRYPT` | `true` | Encrypt the connection. `false` only if the server has no TLS. |
| `TRUST_SERVER_CERTIFICATE` | `false` | `true` accepts a self-signed certificate. Only on a trusted network. |
| `REQUEST_TIMEOUT` | `30000` | Query timeout in ms. |
| `MAX_POOL` / `MIN_POOL` / `IDLE` | `10` / `0` / `30000` | Connection pool size and idle timeout (ms). |
| `MSSQL_ALLOW_PRIVILEGED_LOGIN` | `false` | `true` lets the server run with a sysadmin, `CONTROL SERVER` or `db_owner` login, with a warning. Not recommended. |

Values come from the MCP client's `env` block, or from `./.env` in the server's working directory. The client's values win.

## Development

```bash
npm install
npm test          # unit tests, no database needed
npm run build     # compiles to build/
npm run smoke     # calls every tool once against the server in .env (after build)
                  # and checks the bypass payloads are rejected
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © shadow-dba
