/**
 * The check on SQL that the AI writes itself (mssql_run_select).
 *
 * This is the second safety layer. The first, and the real guarantee, is the read-only
 * login (see loginCheck.ts). This check still has to be strict: tool output carries text
 * that other people control (plan-cache query text, error-log lines, object names), so a
 * prompt injection can make the AI send a crafted query.
 *
 * How it works:
 * 1. A lexer splits the text the way SQL Server does: strings ('..', N'..' with ''),
 *    quoted names ("..", [..] with ]]), line comments (--) and nested block comments.
 *    Keywords hidden inside strings, names or comments are never seen as keywords, and
 *    quotes inside comments or names cannot hide code that follows.
 * 2. An allowlist on the tokens: one statement, it starts with SELECT or WITH, and no
 *    bare word that starts or changes another statement appears anywhere.
 */

export type TokenKind = 'word' | 'string' | 'quoted' | 'comment' | 'number' | 'symbol';

export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * Bare words that start a statement other than SELECT, or that write, change session
 * state, call code or wait. Any of these anywhere in the query rejects it.
 */
export const FORBIDDEN_WORDS = new Set([
  // Writes and DDL
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP',
  'WRITETEXT', 'UPDATETEXT', 'READTEXT', 'BULK',
  // Security
  'GRANT', 'REVOKE', 'DENY', 'SETUSER', 'REVERT',
  // Server and database operations
  'BACKUP', 'RESTORE', 'DUMP', 'LOAD', 'DBCC', 'KILL', 'SHUTDOWN', 'RECONFIGURE',
  'CHECKPOINT', 'ENABLE', 'DISABLE',
  // Running other code
  'EXEC', 'EXECUTE', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE',
  // Session state and control flow
  'USE', 'SET', 'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'OPEN', 'CLOSE',
  'DEALLOCATE', 'WHILE', 'IF', 'GOTO', 'RETURN', 'BREAK', 'CONTINUE', 'THROW',
  'RAISERROR', 'PRINT',
  // Waiting and Service Broker
  'WAITFOR', 'RECEIVE', 'SEND', 'GET', 'MOVE',
  // Sequences: NEXT VALUE FOR moves the sequence forward (FETCH NEXT is fine, see below)
  'NEXT',
]);

export class ReadOnlyQueryError extends Error {}

function fail(reason: string): never {
  throw new ReadOnlyQueryError(
    `${reason} Only one read-only SELECT (or WITH ... SELECT) statement is allowed.`
  );
}

const isWordStart = (c: string) => /[A-Za-z_@#]/.test(c);
// ASCII only on purpose: a character this lexer does not know splits a word, so a
// keyword is never hidden by gluing it to an unusual character.
const isWordChar = (c: string) => /[A-Za-z0-9_@#$]/.test(c);

/** Splits T-SQL into tokens. Throws on an unclosed string, name or comment. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  const readQuoted = (open: number, close: string, what: string): number => {
    // Returns the index after the closing char. A doubled close char is an escape.
    let j = open + 1;
    for (;;) {
      if (j >= n) fail(`Unclosed ${what}.`);
      if (sql[j] === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
  };

  while (i < n) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j += 1;
      tokens.push({ kind: 'comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      // Block comments nest in T-SQL.
      let depth = 1;
      let j = i + 2;
      while (depth > 0) {
        if (j >= n) fail('Unclosed /* comment.');
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      tokens.push({ kind: 'comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if ((c === 'N' || c === 'n') && sql[i + 1] === "'") {
      const end = readQuoted(i + 1, "'", 'string');
      tokens.push({ kind: 'string', text: sql.slice(i, end) });
      i = end;
      continue;
    }

    if (c === "'") {
      const end = readQuoted(i, "'", 'string');
      tokens.push({ kind: 'string', text: sql.slice(i, end) });
      i = end;
      continue;
    }

    if (c === '"') {
      const end = readQuoted(i, '"', 'quoted name');
      tokens.push({ kind: 'quoted', text: sql.slice(i, end) });
      i = end;
      continue;
    }

    if (c === '[') {
      const end = readQuoted(i, ']', '[name]');
      tokens.push({ kind: 'quoted', text: sql.slice(i, end) });
      i = end;
      continue;
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j += 1;
      tokens.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(sql[j])) j += 1;
      } else {
        while (j < n && /[0-9.]/.test(sql[j])) j += 1;
        if ((sql[j] === 'e' || sql[j] === 'E') && /[0-9+-]/.test(sql[j + 1] ?? '')) {
          j += 2;
          while (j < n && /[0-9]/.test(sql[j])) j += 1;
        }
      }
      tokens.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ kind: 'symbol', text: c });
    i += 1;
  }
  return tokens;
}

/**
 * Throws ReadOnlyQueryError unless `query` is exactly one SELECT statement
 * (optionally starting with WITH) that cannot write or change the session.
 */
export function validateReadOnlyQuery(query: string): void {
  if (typeof query !== 'string' || query.trim().length === 0) {
    fail('The query is empty.');
  }

  const tokens = tokenize(query).filter((t) => t.kind !== 'comment');
  if (tokens.length === 0) fail('The query has only comments.');

  // One statement: a `;` may only end the query.
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].kind === 'symbol' && tokens[end - 1].text === ';') end -= 1;
  const body = tokens.slice(0, end);
  if (body.some((t) => t.kind === 'symbol' && t.text === ';')) {
    fail('More than one statement (a ";" in the middle).');
  }

  const first = body[0];
  const firstWord = first?.kind === 'word' ? first.text.toUpperCase() : '';
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    fail(`The query must start with SELECT or WITH, not "${first?.text ?? ''}".`);
  }

  for (let k = 0; k < body.length; k += 1) {
    const t = body[k];
    if (t.kind !== 'word') continue;
    const word = t.text.toUpperCase();
    const next = body[k + 1]?.kind === 'word' ? body[k + 1].text.toUpperCase() : '';

    // Join hints (INNER MERGE JOIN, OPTION (MERGE JOIN | MERGE UNION)) are not the MERGE
    // statement: a bare JOIN or UNION cannot be a table name.
    if (word === 'MERGE' && (next === 'JOIN' || next === 'UNION')) continue;
    // OFFSET ... FETCH NEXT n ROWS is paging, not a sequence.
    if (word === 'NEXT' && next !== 'VALUE') continue;

    if (FORBIDDEN_WORDS.has(word)) {
      fail(`"${t.text}" is not allowed.`);
    }
  }
}
