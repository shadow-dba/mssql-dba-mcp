import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyQueryError, tokenize, validateReadOnlyQuery } from './validateReadOnly.js';
import payloads from '../../scripts/bypass-payloads.json' with { type: 'json' };

const blocked = (q: string) =>
  assert.throws(() => validateReadOnlyQuery(q), ReadOnlyQueryError, `should be blocked: ${q}`);

describe('validateReadOnlyQuery', () => {
  describe('allows read-only queries', () => {
    const valid = [
      'SELECT 1',
      'SELECT 1;',
      'SELECT 1 ;  ; -- trailing semicolons and a comment',
      'SELECT * FROM sys.databases',
      "select name from sys.tables where name like '%Post%'",
      'WITH cte AS (SELECT 1 AS n) SELECT n FROM cte',
      "SELECT 'DROP TABLE dbo.Posts' AS literal", // keyword only inside a string
      "SELECT N'DELETE FROM dbo.Users; EXEC x' AS literal",
      "SELECT 'it''s; UPDATE dbo.Votes' AS escaped_quote",
      'SELECT 1 -- DELETE FROM dbo.Posts',
      'SELECT 1 /* TRUNCATE TABLE dbo.Votes */',
      'SELECT 1 /* outer /* nested; DROP TABLE dbo.Tags */ still comment */',
      'SELECT TOP (10) Id, Title FROM dbo.Posts ORDER BY Score DESC',
      'SELECT [Update], [Delete], "Insert" FROM dbo.PostHistory', // quoted names
      'SELECT [a]]b; DROP] FROM dbo.Tags', // ]] inside a [name]
      'SELECT Id FROM dbo.Posts ORDER BY Id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY',
      'SELECT u.DisplayName FROM dbo.Users u INNER MERGE JOIN dbo.Badges b ON b.UserId = u.Id',
      'SELECT p.Id FROM dbo.Posts p JOIN dbo.Votes v ON v.PostId = p.Id OPTION (MERGE JOIN)',
      "WITH XMLNAMESPACES ('urn:x' AS x) SELECT 1",
      'SELECT COUNT(*) FROM lab.Run r JOIN lab.History h ON h.RunId = r.Id',
      'SELECT 0x1F, 1.5e3, .5, $1.00',
      'SELECT u.Reputation FROM dbo.Users AS u WHERE u.Location = @@SERVERNAME',
    ];
    for (const q of valid) {
      it(`passes: ${q}`, () => assert.doesNotThrow(() => validateReadOnlyQuery(q)));
    }
  });

  // The 31 payloads from the pre-launch review: every one passed the old regex validator.
  // They live in scripts/bypass-payloads.json, so the smoke test can also send them to a real server.
  describe('blocks the 31 bypass payloads from the review', () => {
    it('has all 31', () => assert.equal(Object.keys(payloads).length, 31));
    for (const [name, q] of Object.entries(payloads)) {
      it(`blocks ${name}`, () => blocked(q));
    }
  });

  describe('blocks the same statements without a semicolon', () => {
    const invalid = [
      'SELECT 1 UPDATE dbo.Posts SET Score = 1',
      'SELECT 1 DELETE dbo.Votes',
      'SELECT 1 EXEC sp_who',
      'SELECT 1 DBCC FREEPROCCACHE',
      'SELECT 1 USE msdb',
      'SELECT 1 WHILE 1=1 SELECT 1',
      'SELECT 1UPDATE dbo.Posts SET Score = 1', // number glued to a keyword
      'SELECT 0x1FUPDATE dbo.Posts SET Score = 1',
      "SELECT N'x'UPDATE dbo.Posts SET Score = 1",
      'SELECT [x]UPDATE dbo.Posts SET Score = 1',
      'SELECT 1/**/UPDATE/**/dbo.Posts SET Score = 1',
    ];
    for (const q of invalid) it(`blocks: ${q}`, () => blocked(q));
  });

  describe('blocks writes and dangerous statements', () => {
    const invalid = [
      'INSERT INTO dbo.Tags VALUES (1)',
      'UPDATE dbo.Users SET Reputation = 1',
      'DELETE FROM dbo.Comments',
      'MERGE INTO dbo.Tags t USING dbo.Posts s ON t.Id = s.Id WHEN MATCHED THEN DELETE',
      'WITH c AS (SELECT * FROM dbo.Posts) MERGE c USING dbo.Votes v ON 1=1 WHEN MATCHED THEN DELETE;',
      'WITH c AS (SELECT * FROM dbo.Posts) DELETE FROM c',
      'WITH c AS (SELECT * FROM dbo.Users) UPDATE c SET Reputation = 0',
      'TRUNCATE TABLE dbo.Votes',
      'DROP TABLE dbo.Badges',
      'CREATE TABLE dbo.Evil (Id INT)',
      'ALTER TABLE dbo.Posts ADD Evil INT',
      'GRANT SELECT ON dbo.Users TO evil',
      'EXEC sp_who',
      "EXEC xp_cmdshell 'dir'",
      "EXEC sp_executesql N'SELECT 1'",
      'BEGIN TRANSACTION',
      'SELECT * INTO dbo.PostsCopy FROM dbo.Posts',
      'select Id, Title into #tmp from dbo.Posts',
      "SELECT 1; WAITFOR DELAY '00:00:30'",
      "WAITFOR TIME '23:59'; SELECT 1",
      "EXEC('DROP TABLE dbo.Users')",
      "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=evil;', 'SELECT 1')",
      "SELECT * FROM OPENQUERY(evil, 'SELECT 1')",
      "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=evil').master.sys.objects",
      'SELECT 1 OPTION (USE HINT (\'DISABLE_OPTIMIZED_NESTED_LOOP\'))', // USE is blocked; rare false positive
      'SELECT 1; SELECT 2',
      '(SELECT 1)',
      'PRINT 1',
    ];
    for (const q of invalid) it(`blocks: ${q}`, () => blocked(q));
  });

  describe('input validation', () => {
    it('throws on empty string', () => blocked(''));
    it('throws on whitespace only', () => blocked('   '));
    it('throws on comments only', () => blocked('-- SELECT 1\n/* SELECT 2 */'));
    it('throws on an unclosed string', () => blocked("SELECT 'abc; DROP TABLE dbo.Posts"));
    it('throws on an unclosed [name]', () => blocked('SELECT [abc; DROP TABLE dbo.Posts'));
    it('throws on an unclosed nested comment', () =>
      blocked('SELECT 1 /* /* */ DROP TABLE dbo.Posts'));
    // @ts-expect-error testing runtime guard against non-string input
    it('throws on non-string', () => blocked(null));
  });
});

describe('tokenize', () => {
  const kinds = (sql: string) => tokenize(sql).map((t) => `${t.kind}:${t.text}`);

  it('keeps a quote inside [..] as part of the name', () => {
    assert.deepEqual(kinds("[it's]"), ["quoted:[it's]"]);
  });

  it('treats -- inside a block comment as comment text', () => {
    assert.deepEqual(kinds('/* -- */ x'), ['comment:/* -- */', 'word:x']);
  });

  it('treats a quote inside a line comment as comment text', () => {
    assert.deepEqual(kinds("-- it's\nx"), ["comment:-- it's", 'word:x']);
  });

  it('reads N strings with doubled quotes', () => {
    assert.deepEqual(kinds("N'a''b' y"), ["string:N'a''b'", 'word:y']);
  });
});
