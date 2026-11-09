# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (0.x: tool names may still change).

## [Unreleased]

### Changed
- Setup script no longer grants any access to rows in user tables: `SELECT ALL USER SECURABLES`
  (`db_datareader` on Azure SQL Database) is removed from the default scripts. The login is
  metadata-only again; `mssql_run_select` reads system views and DMVs. The `DENY SELECT` on
  `msdb.dbo.sysjobsteps` stays as defense in depth.
- README: the "Business data" section is now an optional, opt-in guide. It explains what
  leaves SQL Server when the AI can read rows, the privacy, security and legal checks to make
  first (data processing agreements, GDPR/HIPAA/PCI DSS, prompt injection), and how to grant
  the smallest possible access for one task and revoke it after.

## [0.1.1] - 2026-11-03

### Changed
- Setup script: on SQL Server 2016-2019 it grants `EXECUTE` on `xp_readerrorlog` (master) so
  `mssql_error_log` works without `securityadmin`. The tool's permission hint says the same.
- Setup script: can run again over an existing login or user (`IF SUSER_ID(...) IS NULL`), and
  grants `EXECUTE` on `msdb.dbo.agent_datetime` so one login serves the MCP and the agent.
- README: new "Optional grants" section (`SELECT ALL USER SECURABLES`, `VIEW SERVER SECURITY AUDIT`,
  per-database `SELECT` on the `cdc` schema) for investigations that need business data.

## [0.1.0] - 2026-10-17

First public release.

### Added
- 42 read-only tools for SQL Server DBA work: health checks, wait stats, top queries and plans,
  blocking, memory, I/O, tempdb, configuration, error log, backups, CHECKDB, VLFs, autogrowth,
  SQL Agent jobs and alerts, privileged logins, and schema design (keys, foreign keys,
  identity headroom, column types, collation, indexes, missing indexes).
- Login check at startup: the server refuses to run with a `sysadmin`, `CONTROL SERVER` or
  `db_owner` login unless `MSSQL_ALLOW_PRIVILEGED_LOGIN=true`.
- `mssql_run_select` checks the AI's SQL with a lexer and an allowlist: one statement that
  starts with `SELECT` or `WITH`, no word that writes, runs code or changes the session.
  New optional `databaseName` argument.
- The server reads `./.env` from its working directory.
- Output caps on every tool (200 rows per table, 40,000 characters per reply, 500 rows for
  `mssql_run_select`) with a "Showing N of M" note.
- Tool annotations (`readOnlyHint`, `destructiveHint: false`, `idempotentHint`,
  `openWorldHint: false`), server instructions, and 4 tools marked always-loaded.
- `server.json` for the official MCP Registry.
