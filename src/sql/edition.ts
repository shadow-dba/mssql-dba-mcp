import type { Db } from '../db.js';

/**
 * Runtime engine-edition detection for tools that must branch on the kind of
 * SQL Server they are connected to. Values mirror SERVERPROPERTY('EngineEdition').
 *
 * See sqlVersionGuards.ts for the SQL-fragment equivalents used inside a single
 * batch; this module is for handlers that need to decide in TypeScript whether
 * to run a query at all (e.g. msdb / SQL Agent / volume stats are absent on
 * Azure SQL Database).
 */
export const EDITION_AZURE_SQL_DB = 5;
export const EDITION_MANAGED_INSTANCE = 8;

/** Returns SERVERPROPERTY('EngineEdition') as an integer, or 0 if unavailable. */
export async function getEngineEdition(db: Db): Promise<number> {
  const rows = await db.executeQuery<{ edition: number }>({
    query: "SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT) AS edition;",
  });
  return rows?.[0]?.edition ?? 0;
}

/** True on Azure SQL Database (single-database, no msdb / SQL Agent / instance DMVs). */
export async function isAzureSqlDb(db: Db): Promise<boolean> {
  return (await getEngineEdition(db)) === EDITION_AZURE_SQL_DB;
}

/** True on Azure SQL Managed Instance. */
export async function isManagedInstance(db: Db): Promise<boolean> {
  return (await getEngineEdition(db)) === EDITION_MANAGED_INSTANCE;
}
