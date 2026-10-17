import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { DbConfig } from './db.js';

/**
 * Reads `.env` from the working directory, if there is one. Variables that are already
 * set (for example in the MCP client's `env` block) win. This lets an MCP client start
 * the server directly, without a shell wrapper that breaks on Windows and on passwords
 * with `$`, spaces or quotes.
 */
export function loadDotEnv(cwd: string = process.cwd()): string | null {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return null;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
  return file;
}

const authTypeSchema = z.enum(['sql', 'windows']);
export type AuthType = z.infer<typeof authTypeSchema>;

const DEFAULT_PORT = 1433;
const DEFAULT_REQUEST_TIMEOUT = 30000;
const DEFAULT_MAX_POOL = 10;
const DEFAULT_MIN_POOL = 0;
const DEFAULT_IDLE = 30000;

/**
 * Returns the value of a required environment variable, throwing a clear
 * error when it is missing or empty.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Parses an optional integer environment variable, throwing a clear error
 * when the value is present but not a valid integer.
 */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid value for environment variable ${name}: "${raw}" is not a valid integer.`
    );
  }
  return parsed;
}

function parseAuthType(): AuthType {
  const result = authTypeSchema.safeParse(process.env.DB_AUTH_TYPE);
  if (!result.success) {
    throw new Error(
      `Invalid or missing DB_AUTH_TYPE environment variable. Available options: ${authTypeSchema.options.join(
        ', '
      )}.`
    );
  }
  return result.data;
}

function buildOptions(): DbConfig['options'] {
  return {
    trustServerCertificate: process.env.TRUST_SERVER_CERTIFICATE === 'true',
    // Encrypted by default (matches the tedious driver default); opt out with ENCRYPT=false.
    encrypt: process.env.ENCRYPT !== 'false',
    requestTimeout: parseIntEnv('REQUEST_TIMEOUT', DEFAULT_REQUEST_TIMEOUT),
  };
}

function buildPool(): DbConfig['pool'] {
  return {
    max: parseIntEnv('MAX_POOL', DEFAULT_MAX_POOL),
    min: parseIntEnv('MIN_POOL', DEFAULT_MIN_POOL),
    idleTimeoutMillis: parseIntEnv('IDLE', DEFAULT_IDLE),
  };
}

/**
 * Builds a validated MSSQL connection configuration from environment
 * variables. Throws a descriptive error as soon as a required variable is
 * missing or invalid, rather than deferring to a cryptic connection failure.
 */
export function loadConnectionConfig(): DbConfig {
  const authType = parseAuthType();

  const server = requireEnv('DB_HOST');
  const database = requireEnv('DB_NAME');
  const port = parseIntEnv('DB_PORT', DEFAULT_PORT);
  const user = requireEnv('DB_USER');
  const password = requireEnv('DB_PASSWORD');

  if (authType === 'sql') {
    console.error('Using SQL Authentication for db:', database);
    return {
      server,
      port,
      database,
      user,
      password,
      options: buildOptions(),
      pool: buildPool(),
    };
  }

  // authType === 'windows'
  console.error('Using Windows Authentication (NTLM) for db:', database);
  return {
    server,
    port,
    database,
    options: buildOptions(),
    pool: buildPool(),
    authentication: {
      type: 'ntlm',
      options: {
        // Optional: only relevant for Active Directory / domain accounts.
        // Empty is ignored by SQL Server for local Windows accounts.
        domain: process.env.DB_DOMAIN || '',
        userName: user,
        password,
      },
    },
  };
}
