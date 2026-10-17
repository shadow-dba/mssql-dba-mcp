import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoginCheckError, type Db } from './db.js';
import { checkLogin, privilegedRights } from './loginCheck.js';

const rights = { login: 'shadow-dba', database: 'StackOverflow', isSysadmin: false, hasControlServer: false, isDbOwner: false };

function fakeDb(row: Record<string, unknown>): Db {
  return { executeQuery: async () => [row] } as unknown as Db;
}

describe('privilegedRights', () => {
  it('is empty for the read-only login', () => assert.deepEqual(privilegedRights(rights), []));
  it('names every privileged right', () =>
    assert.deepEqual(privilegedRights({ ...rights, isSysadmin: true, hasControlServer: true, isDbOwner: true }), [
      'member of sysadmin',
      'has CONTROL SERVER',
      'db_owner in StackOverflow',
    ]));
});

describe('checkLogin', () => {
  const row = { login: 'sa', database: 'StackOverflow', isSysadmin: 1, hasControlServer: 1, isDbOwner: 1 };

  it('passes a read-only login', async () => {
    await checkLogin(fakeDb({ ...row, login: 'shadow-dba', isSysadmin: 0, hasControlServer: 0, isDbOwner: 0 }), {});
  });

  it('refuses sysadmin', async () => {
    await assert.rejects(checkLogin(fakeDb(row), {}), LoginCheckError);
  });

  it('refuses db_owner alone', async () => {
    await assert.rejects(
      checkLogin(fakeDb({ ...row, login: 'so-owner', isSysadmin: 0, hasControlServer: 0 }), {}),
      /db_owner in StackOverflow/
    );
  });

  it('runs with a warning when MSSQL_ALLOW_PRIVILEGED_LOGIN=true', async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => lines.push(msg);
    try {
      await checkLogin(fakeDb(row), { MSSQL_ALLOW_PRIVILEGED_LOGIN: 'true' });
    } finally {
      console.error = original;
    }
    assert.match(lines.join('\n'), /WARNING/);
  });

  it('ignores other values of MSSQL_ALLOW_PRIVILEGED_LOGIN', async () => {
    await assert.rejects(checkLogin(fakeDb(row), { MSSQL_ALLOW_PRIVILEGED_LOGIN: '1' }), LoginCheckError);
  });
});
