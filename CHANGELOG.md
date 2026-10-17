# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (0.x: tool names may still change).

## [Unreleased]

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
