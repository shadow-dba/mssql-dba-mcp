/**
 * SQL Server version/edition guard fragments.
 *
 * Tools in src/tools build raw T-SQL that targets a range of engines. This
 * module centralizes the feature-detection building blocks (mirroring the
 * approach used by sp_Blitz) so that a single batch "compiles & runs on all
 * versions" instead of breaking on a specific build or edition.
 *
 * Supported target matrix:
 *   - SQL Server 2016+ (EngineEdition 2/3/4: Standard/Enterprise/Express)
 *   - Azure SQL Database          (EngineEdition 5)
 *   - Azure SQL Managed Instance  (EngineEdition 8)
 *
 * Compatibility reference (the basis for the static review; no live instances):
 *   - EngineEdition values: 1 Personal, 2 Standard, 3 Enterprise, 4 Express,
 *     5 Azure SQL DB, 6 Synapse, 8 Managed Instance, 9 Azure SQL Edge,
 *     11 Synapse serverless.
 *   - USE <db> is NOT supported on Azure SQL DB (single-database connections);
 *     it works on box product and Managed Instance. See runInDatabaseSql().
 *   - msdb / SQL Server Agent / dbo.backupset are absent on Azure SQL DB; they
 *     exist on box product and Managed Instance.
 *   - sys.dm_os_volume_stats, DBCC DBINFO are unsupported on Azure SQL DB.
 *   - STRING_AGG requires SQL Server 2017+ (compat 140). Prefer a universally
 *     compatible construct (FOR XML PATH/STUFF) instead of version gating.
 *   - sys.dm_os_performance_counters object_name carries an instance prefix
 *     ('SQLServer:' on a default instance, 'MSSQL$<name>:' on a named one);
 *     match by suffix, never by a hard-coded full object_name.
 */

import { validateDatabaseName } from './identifiers.js';

const IDENTIFIER_PART = /^[A-Za-z_@#][A-Za-z0-9_@#$]*$/;

function assertSafeSqlObjectName(name: string, kind: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error(`${kind} must be a non-empty string`);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error(`${kind} cannot be empty or whitespace`);
  }
  const parts = trimmed.split('.');
  for (const part of parts) {
    if (!IDENTIFIER_PART.test(part)) {
      throw new Error(`${kind} contains an invalid identifier part: "${name}"`);
    }
  }
}

/** Escapes a string literal for embedding inside a single-quoted T-SQL literal. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** CAST(SERVERPROPERTY('EngineEdition') AS INT) */
export const ENGINE_EDITION_EXPR =
  "CAST(SERVERPROPERTY('EngineEdition') AS INT)";

/** Boolean SQL expression: true on Azure SQL Database (EngineEdition 5). */
export const IS_AZURE_SQL_DB_EXPR = `${ENGINE_EDITION_EXPR} = 5`;

/** Boolean SQL expression: true on Azure SQL Managed Instance (EngineEdition 8). */
export const IS_MANAGED_INSTANCE_EXPR = `${ENGINE_EDITION_EXPR} = 8`;

/**
 * Boolean SQL expression: true when msdb / SQL Agent / backup history are
 * available (box product and Managed Instance, i.e. NOT Azure SQL DB).
 */
export const HAS_MSDB_EXPR = `${ENGINE_EDITION_EXPR} <> 5`;

/**
 * Returns a boolean SQL expression that is true only when the given column
 * exists on the given object, e.g.
 *   columnExistsExpr('msdb.dbo.backupset', 'compressed_backup_size')
 * Safe across versions: references sys.all_columns, which always exists.
 */
export function columnExistsExpr(
  objectName: string,
  columnName: string
): string {
  assertSafeSqlObjectName(objectName, 'objectName');
  assertSafeSqlObjectName(columnName, 'columnName');
  return (
    `EXISTS (SELECT 1 FROM sys.all_columns ` +
    `WHERE object_id = OBJECT_ID('${escapeSqlLiteral(objectName)}') ` +
    `AND name = '${escapeSqlLiteral(columnName)}')`
  );
}

/**
 * Returns a boolean SQL expression that is true only when the given object
 * (table, view, DMV, function) exists, e.g.
 *   objectExistsExpr('sys.dm_os_volume_stats')
 */
export function objectExistsExpr(objectName: string): string {
  assertSafeSqlObjectName(objectName, 'objectName');
  return `OBJECT_ID('${escapeSqlLiteral(objectName)}') IS NOT NULL`;
}

/**
 * Wraps an inner T-SQL statement so it executes in the context of `dbName`
 * without a USE statement (which is illegal on Azure SQL DB).
 *
 * - On Azure SQL DB (single-db): runs the statement in the current database.
 *   Cross-database is unsupported there, so if `dbName` differs from the
 *   connected database the batch THROWs a clear error instead of silently
 *   returning results for the wrong database.
 * - Elsewhere (box product / Managed Instance): runs it in the target database
 *   via a three-part sp_executesql call, preserving cross-database context.
 *
 * The name is passed as an escaped N'' literal into a SYSNAME variable and
 * bracketed with QUOTENAME, so it is never concatenated raw into the executed
 * batch. That is why any real database name is allowed ("888Sales", "my-db").
 */
export function runInDatabaseSql(dbName: string, innerSql: string): string {
  const cleanDb = dbName.trim().replace(/^\[|\]$/g, '');
  validateDatabaseName(cleanDb, 'dbName');
  return `
DECLARE @ctxDb SYSNAME = N'${escapeSqlLiteral(cleanDb)}';
DECLARE @inner NVARCHAR(MAX) = N'${escapeSqlLiteral(innerSql)}';
IF ${IS_AZURE_SQL_DB_EXPR}
BEGIN
  IF DB_NAME() <> @ctxDb
    THROW 50000, N'Cross-database queries are not supported on Azure SQL Database. Connect directly to the target database instead of passing a different databaseName.', 1;
  EXEC sys.sp_executesql @inner;
END
ELSE
BEGIN
  DECLARE @proc NVARCHAR(400) = QUOTENAME(@ctxDb) + N'.sys.sp_executesql';
  EXEC @proc @inner;
END;`;
}
