/**
 * Library entry point: the same read-only tools as the stdio server, for a program that
 * already has a connection (the shadow-dba app embeds them in its AI diagnoses).
 *
 *   import { Db, checkLogin, createTools } from '@shadow-dba/mssql-dba-mcp';
 *   const db = new Db(config, (conn) => checkLogin(conn));
 *   for (const tool of createTools(db)) ... tool.handler(args) -> Markdown
 *
 * Importing this file starts nothing: the stdio server lives in index.ts (the `bin`).
 */
export { Db, LoginCheckError, type DbConfig, type QueryOptions } from './db.js';
export { checkLogin, privilegedRights, ALLOW_PRIVILEGED_ENV, type LoginRights } from './loginCheck.js';
export { createTools } from './tools/index.js';
export type { ToolDescriptor } from './tools/types.js';
export { capText, toMarkdownTable, showingNote, DEFAULT_MAX_ROWS, MAX_CELL_CHARS } from './sql/markdown.js';
export { INSTRUCTIONS, MAX_OUTPUT_CHARS } from './server.js';
