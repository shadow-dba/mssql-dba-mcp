# Security policy

The promise of this project is that the AI can never modify your database. A way around it is
the most important bug we can get. Thank you for looking.

## What counts

- **A bypass of the SELECT check:** any text that `validateReadOnlyQuery` accepts and that
  makes SQL Server write data, change schema, settings or permissions, run code, or change the
  session (`USE`, `SET`, open transactions) for later calls. See `src/sql/validateReadOnly.ts`.
- **A tool that writes:** any built-in tool whose SQL can change something, for any input.
- **A login check bypass:** a way to make the server run with a `sysadmin`, `CONTROL SERVER` or
  `db_owner` login without `MSSQL_ALLOW_PRIVILEGED_LOGIN=true`.
- **A setup script that grants too much:** a permission in the README scripts that lets the
  login change something.
- SQL injection through tool arguments (`databaseName`, `tableNames`, ...), credential leaks,
  and the usual npm package problems.

Not in scope: what the read-only login can **read** by design (metadata, plan-cache query
text, error-log lines; see "Safety" in the README), and attacks that need a login you set up
with more rights than the README scripts give.

## How to report

Please report privately, not in a public issue: open the **Security** tab of this repository
and click **Report a vulnerability** (GitHub private vulnerability reporting).

Include the query or input, the SQL Server version and edition, and what happened. A failing
test case for `src/sql/validateReadOnly.test.ts` is the best possible report.

We answer within 3 working days. We fix SELECT check bypasses first, publish a patch release,
and credit you in the release notes unless you ask us not to.

## Supported versions

Only the latest `0.x` release gets security fixes.
