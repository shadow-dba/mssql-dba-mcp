import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Db, LoginCheckError, MAX_OUTPUT_CHARS, capText, checkLogin, createTools } from './lib.js';

describe('library entry point', () => {
  it('exports the connection, the login check and the registry', () => {
    assert.equal(typeof Db, 'function');
    assert.equal(typeof LoginCheckError, 'function');
    assert.equal(typeof checkLogin, 'function');
    assert.equal(typeof capText, 'function');
    assert.equal(MAX_OUTPUT_CHARS, 40_000);
  });

  it('createTools gives 42 descriptors with unique mssql_ names and a handler', () => {
    const tools = createTools({} as unknown as Db);
    assert.equal(tools.length, 42);
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of tools) {
      assert.match(t.name, /^mssql_[a-z0-9_]+$/);
      assert.equal(typeof t.handler, 'function');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.inputSchema, 'object');
    }
  });
});
