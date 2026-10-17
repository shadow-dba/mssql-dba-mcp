import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSqlIdentifier,
  validateSqlIdentifiers,
  sanitizeSqlIdentifier,
  validateDatabaseName,
} from './identifiers.js';

describe('validateSqlIdentifier', () => {
  describe('accepts valid identifiers', () => {
    const valid = [
      'StackOverflow',
      'dbo.Users',
      '[Post History]',
      'lab.[Run History]',
      '_temp',
      '#tmp',
    ];
    for (const id of valid) {
      it(`passes: ${id}`, () =>
        assert.doesNotThrow(() => validateSqlIdentifier(id)));
    }
  });

  describe('rejects injection attempts', () => {
    const invalid = [
      'Users; DROP TABLE dbo.Posts --',
      '1 OR 1=1',
      "x' OR 'a'='a",
      'Posts UNION SELECT name FROM sys.sql_logins',
      'xp_cmdshell',
      'name; EXEC sp_who',
      'a/* comment */b',
      '0x4142',
      'col INTO OUTFILE',
    ];
    for (const id of invalid) {
      it(`blocks: ${id}`, () => assert.throws(() => validateSqlIdentifier(id)));
    }
  });

  it('rejects empty / non-string', () => {
    assert.throws(() => validateSqlIdentifier(''));
    // @ts-expect-error testing runtime guard
    assert.throws(() => validateSqlIdentifier(undefined));
  });

  it('rejects reserved keywords', () =>
    assert.throws(() => validateSqlIdentifier('SELECT')));

  it('rejects too many qualified parts', () =>
    assert.throws(() => validateSqlIdentifier('a.b.c.d')));

  it('rejects bracketed identifier containing a closing bracket', () =>
    assert.throws(() => validateSqlIdentifier('[bad]name]')));
});

describe('validateSqlIdentifiers', () => {
  it('passes an array of valid identifiers', () =>
    assert.doesNotThrow(() => validateSqlIdentifiers(['Posts', 'dbo.Votes'])));
  it('throws on empty array', () =>
    assert.throws(() => validateSqlIdentifiers([])));
  it('throws when any element is invalid', () =>
    assert.throws(() => validateSqlIdentifiers(['Posts', 'DROP TABLE dbo.Votes'])));
  // @ts-expect-error testing runtime guard
  it('throws on non-array', () =>
    assert.throws(() => validateSqlIdentifiers('a')));
});

describe('sanitizeSqlIdentifier', () => {
  it('wraps a plain identifier in brackets', () =>
    assert.equal(sanitizeSqlIdentifier('Users'), '[Users]'));
  it('leaves an already-bracketed identifier unchanged', () =>
    assert.equal(sanitizeSqlIdentifier('[Post History]'), '[Post History]'));
  it('brackets each part of a qualified name', () =>
    assert.equal(sanitizeSqlIdentifier('dbo.Users'), '[dbo].[Users]'));
  it('preserves already-bracketed parts in a qualified name', () =>
    assert.equal(sanitizeSqlIdentifier('lab.[Run History]'), '[lab].[Run History]'));
});

describe('validateDatabaseName', () => {
  for (const name of ['StackOverflow', '888Sales', 'Stack Overflow', 'stack-overflow-2024', '[StackOverflow]', "O'Brien"]) {
    it(`passes: ${name}`, () => assert.doesNotThrow(() => validateDatabaseName(name)));
  }
  it('rejects empty and whitespace', () => {
    assert.throws(() => validateDatabaseName(''));
    assert.throws(() => validateDatabaseName('   '));
    assert.throws(() => validateDatabaseName('[]'));
  });
  it('rejects names over 128 characters', () => assert.throws(() => validateDatabaseName('a'.repeat(129))));
  it('rejects control characters', () => assert.throws(() => validateDatabaseName('Stack\u0000Overflow')));
});
