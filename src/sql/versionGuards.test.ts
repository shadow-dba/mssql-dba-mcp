import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeSqlLiteral,
  columnExistsExpr,
  objectExistsExpr,
  runInDatabaseSql,
  IS_AZURE_SQL_DB_EXPR,
  IS_MANAGED_INSTANCE_EXPR,
  HAS_MSDB_EXPR,
  ENGINE_EDITION_EXPR,
} from './versionGuards.js';

describe('escapeSqlLiteral', () => {
  it('doubles single quotes', () => {
    assert.equal(escapeSqlLiteral("Jon Skeet's"), "Jon Skeet''s");
  });
  it('leaves clean strings untouched', () => {
    assert.equal(escapeSqlLiteral('SELECT 1'), 'SELECT 1');
  });
});

describe('engine edition expressions', () => {
  it('exposes the canonical EngineEdition cast', () => {
    assert.equal(ENGINE_EDITION_EXPR, "CAST(SERVERPROPERTY('EngineEdition') AS INT)");
  });
  it('azure SQL DB checks for edition 5', () => {
    assert.match(IS_AZURE_SQL_DB_EXPR, /= 5$/);
  });
  it('managed instance checks for edition 8', () => {
    assert.match(IS_MANAGED_INSTANCE_EXPR, /= 8$/);
  });
  it('msdb availability excludes edition 5', () => {
    assert.match(HAS_MSDB_EXPR, /<> 5$/);
  });
});

describe('columnExistsExpr', () => {
  it('builds a sys.all_columns probe', () => {
    const sql = columnExistsExpr('msdb.dbo.backupset', 'compressed_backup_size');
    assert.match(sql, /FROM sys\.all_columns/);
    assert.match(sql, /OBJECT_ID\('msdb\.dbo\.backupset'\)/);
    assert.match(sql, /name = 'compressed_backup_size'/);
  });
  it('rejects injection in object name', () => {
    assert.throws(() => columnExistsExpr("x'; DROP TABLE dbo.Posts --", 'c'));
  });
  it('rejects injection in column name', () => {
    assert.throws(() => columnExistsExpr('sys.databases', "c' OR '1'='1"));
  });
});

describe('objectExistsExpr', () => {
  it('builds an OBJECT_ID probe', () => {
    assert.equal(
      objectExistsExpr('sys.dm_os_volume_stats'),
      "OBJECT_ID('sys.dm_os_volume_stats') IS NOT NULL"
    );
  });
  it('rejects malicious object names', () => {
    assert.throws(() => objectExistsExpr('a; DROP TABLE b'));
  });
});

describe('runInDatabaseSql', () => {
  it('branches Azure SQL DB vs cross-db execution', () => {
    const sql = runInDatabaseSql('StackOverflow', 'SELECT 1;');
    assert.match(sql, /IS_AZURE|EngineEdition/);
    assert.match(sql, /sys\.sp_executesql @inner/);
    assert.match(sql, /QUOTENAME\(@ctxDb\) \+ N'\.sys\.sp_executesql'/);
  });
  it('does not emit a USE statement', () => {
    const sql = runInDatabaseSql('StackOverflow', 'SELECT 1;');
    assert.doesNotMatch(sql, /\bUSE \[/);
  });
  it('escapes quotes in the inner statement', () => {
    const sql = runInDatabaseSql('StackOverflow', "SELECT 'a';");
    assert.match(sql, /SELECT ''a'';/);
  });
  it('strips brackets and validates the database name', () => {
    const sql = runInDatabaseSql('[StackOverflow]', 'SELECT 1;');
    assert.match(sql, /@ctxDb SYSNAME = N'StackOverflow'/);
  });
  it('accepts names that start with a digit or have spaces and hyphens', () => {
    assert.match(runInDatabaseSql('888Sales', 'SELECT 1;'), /@ctxDb SYSNAME = N'888Sales'/);
    assert.match(runInDatabaseSql('Stack Overflow-2024', 'SELECT 1;'), /@ctxDb SYSNAME = N'Stack Overflow-2024'/);
  });
  it('keeps a hostile database name inside the escaped literal', () => {
    const sql = runInDatabaseSql("x']; DROP DATABASE y --", 'SELECT 1;');
    assert.match(sql, /@ctxDb SYSNAME = N'x''\]; DROP DATABASE y --';/);
    assert.match(sql, /QUOTENAME\(@ctxDb\)/);
  });
  it('rejects empty, too long and control-character database names', () => {
    assert.throws(() => runInDatabaseSql('', 'SELECT 1;'));
    assert.throws(() => runInDatabaseSql('a'.repeat(129), 'SELECT 1;'));
    assert.throws(() => runInDatabaseSql('Stack\nOverflow', 'SELECT 1;'));
  });
  it('guards the Azure SQL DB branch against a cross-database target', () => {
    const sql = runInDatabaseSql('StackOverflow', 'SELECT 1;');
    // On Azure SQL DB current DB must equal the target; otherwise THROW.
    assert.match(sql, /IF DB_NAME\(\) <> @ctxDb/);
    assert.match(sql, /THROW 50000,[^;]*not supported on Azure SQL Database/i);
    // The throw is inside the Azure branch, before EXEC.
    const azureBranch = sql.slice(
      sql.indexOf(IS_AZURE_SQL_DB_EXPR),
      sql.indexOf('ELSE')
    );
    assert.match(azureBranch, /THROW 50000/);
    assert.ok(
      azureBranch.indexOf('THROW 50000') <
        azureBranch.indexOf('EXEC sys.sp_executesql @inner'),
      'guard must run before EXEC'
    );
  });
});
