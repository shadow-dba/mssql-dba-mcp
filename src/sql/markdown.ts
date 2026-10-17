/** Rows per table before "Showing N of M". */
export const DEFAULT_MAX_ROWS = 200;
/** Characters per cell; long query text and messages are cut. */
export const MAX_CELL_CHARS = 2_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime())
      ? String(value)
      : `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}` +
        ` ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  } else {
    text = String(value);
  }
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS)}… (${text.length} chars)`;
  // A `|` or a line break inside a cell would break the table.
  return text.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

export interface TableOptions {
  /** Rows to show before the "Showing N of M" note. */
  maxRows?: number;
  /** Total row count when `rows` is already cut (for example by TOP). */
  total?: number;
  /** What to tell the model when rows were cut. */
  hint?: string;
}

export function toMarkdownTable(rows: readonly object[], options: TableOptions = {}): string {
  if (!rows.length) return '_No rows returned._';
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const total = Math.max(options.total ?? rows.length, rows.length);
  const shown = rows.slice(0, maxRows);
  const cols = Object.keys(rows[0]);
  const header = `| ${cols.map(formatCell).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = shown
    .map((r) => `| ${cols.map((c) => formatCell((r as Record<string, unknown>)[c])).join(' | ')} |`)
    .join('\n');
  const table = `${header}\n${sep}\n${body}`;
  if (shown.length >= total) return table;
  return `${table}\n\n${showingNote(shown.length, total, options.hint)}`;
}

export function showingNote(shown: number, total: number | string, hint?: string): string {
  return `_Showing ${shown} of ${total} rows.${hint ? ` ${hint}` : ''}_`;
}

/** Cuts text at a line break before `maxChars` and says how much was cut. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n', maxChars);
  const head = text.slice(0, cut > maxChars / 2 ? cut : maxChars);
  return (
    `${head}\n\n_Output cut: showing ${head.length} of ${text.length} characters. ` +
    'Narrow the request (databaseName, tableNames, topN or a filter)._'
  );
}
