import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capText, MAX_CELL_CHARS, toMarkdownTable } from './markdown.js';

describe('toMarkdownTable', () => {
  it('returns a sentinel for empty input', () => {
    assert.equal(toMarkdownTable([]), '_No rows returned._');
  });

  it('formats Date cells as compact local ISO (no timezone noise)', () => {
    const d = new Date(2026, 5, 9, 8, 0, 1); // 2026-06-09 08:00:01 local
    const out = toMarkdownTable([{ When: d }]);
    assert.equal(out, '| When |\n| --- |\n| 2026-06-09 08:00:01 |');
  });

  it('zero-pads month, day, and time components', () => {
    const d = new Date(2026, 0, 5, 3, 7, 9); // 2026-01-05 03:07:09 local
    const out = toMarkdownTable([{ When: d }]);
    assert.match(out, /\| 2026-01-05 03:07:09 \|$/);
  });

  it('renders null and undefined as empty cells', () => {
    const out = toMarkdownTable([{ A: null, B: undefined }]);
    assert.equal(out, '| A | B |\n| --- | --- |\n|  |  |');
  });

  it('passes numbers and strings through unchanged', () => {
    const out = toMarkdownTable([{ N: 95.27, S: 'Full' }]);
    assert.equal(out, '| N | S |\n| --- | --- |\n| 95.27 | Full |');
  });

  it('falls back to String() for an Invalid Date', () => {
    const out = toMarkdownTable([{ When: new Date('not-a-date') }]);
    assert.match(out, /Invalid Date/);
  });

  it('escapes | and line breaks so query text cannot break the table', () => {
    const sql = "SELECT p.Title\r\nFROM dbo.Posts p\nWHERE p.Tags LIKE '%|sql-server|%'";
    const out = toMarkdownTable([{ Statement: sql }]);
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(
      lines[2],
      "| SELECT p.Title FROM dbo.Posts p WHERE p.Tags LIKE '%\\|sql-server\\|%' |"
    );
  });

  it('cuts very long cells', () => {
    const out = toMarkdownTable([{ Body: 'x'.repeat(MAX_CELL_CHARS + 500) }]);
    assert.match(out, new RegExp(`… \\(${MAX_CELL_CHARS + 500} chars\\)`));
  });

  it('caps rows and says how many there were', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ Id: i }));
    const out = toMarkdownTable(rows, { maxRows: 10, hint: 'Pass topN.' });
    assert.equal(out.split('\n').filter((l) => l.startsWith('| ')).length, 12); // header + separator + 10
    assert.match(out, /_Showing 10 of 30 rows\. Pass topN\._$/);
  });

  it('uses the total when rows were already cut in SQL', () => {
    const out = toMarkdownTable([{ Id: 1 }], { total: 500 });
    assert.match(out, /_Showing 1 of 500 rows\._$/);
  });
});

describe('capText', () => {
  it('leaves short text alone', () => {
    assert.equal(capText('abc', 10), 'abc');
  });

  it('cuts at a line break and reports the size', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
    const out = capText(text, 100);
    assert.ok(out.startsWith('a'.repeat(60) + '\n\n_Output cut'));
    assert.match(out, /showing 60 of 121 characters/);
  });
});
