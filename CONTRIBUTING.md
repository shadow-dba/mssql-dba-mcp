# Contributing

Thanks for helping. Questions go to GitHub Discussions; bugs and ideas to Issues.
Security problems: see [SECURITY.md](SECURITY.md), not a public issue.

## Build and test

Node.js 22 or later for development (the package itself runs on 20.12+).

```bash
npm install
npm test           # unit tests; no database needed
npm run typecheck
npm run build      # cleans and compiles to build/
```

To try it against a SQL Server, create the read-only login from the README, copy
`.env.example` to `.env`, then run `node build/index.js` or point an MCP client at it.
`npx @modelcontextprotocol/inspector node build/index.js` gives a UI to call each tool.

## Rules for changes

- **Read-only stays read-only.** A tool may only read. It must work with the login from the
  README scripts; never require a permission that can change something. See CLAUDE.md
  ("Permission model").
- **The SELECT check only gets stricter.** Any change to `src/sql/validateReadOnly.ts` needs
  tests in `validateReadOnly.test.ts`, including the queries it must still block.
- **Names:** tools are `mssql_` + snake_case. Renaming a tool breaks users, so propose it in an
  issue first.
- **Examples** in code, tests and docs use the StackOverflow sample database
  (`dbo.Posts`, `dbo.Users`, `dbo.Votes`, ...). Never use data or names from a real company.
- Tests sit next to the code as `*.test.ts`; `npm test` finds them.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Pull requests

Keep a PR to one change. CI runs typecheck, tests and build on every PR, and a smoke job that
calls every tool on SQL Server 2022 with the README login (`scripts/setup-smoke-db.mjs` builds
its StackOverflow-shaped database from `scripts/smoke-fixture.sql`). Describe what you
tested, and on which SQL Server version if you changed tool SQL.
