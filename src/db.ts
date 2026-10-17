import sql from 'mssql';

export type DbConfig = sql.config;

type Rows = Record<string, any>[];

export interface QueryOptions {
  query: string;
  parameters?: Record<string, unknown>;
}

/**
 * One connection pool to one SQL Server. `verify` runs once on the first connection
 * (the read-only login check); if it throws, the pool is closed and every later call
 * fails with the same error.
 */
export class Db {
  public readonly name: string;
  private pool: Promise<sql.ConnectionPool> | null = null;

  constructor(
    private readonly config: DbConfig,
    private readonly verify?: (db: Db) => Promise<void>
  ) {
    this.name = config.database || '';
  }

  async executeQuery<T = Record<string, any>>({ query, parameters }: QueryOptions): Promise<T[]> {
    const request = (await this.connect()).request();
    for (const [key, value] of Object.entries(parameters ?? {})) request.input(key, value);
    const result = await request.query(query);
    return result.recordset as T[];
  }

  /**
   * Streams the first result set and cancels the query once `maxRows` rows have
   * arrived, so a large result is never loaded into memory. `more` is true when the
   * query had rows past the cap.
   */
  async queryCapped({ query, maxRows }: { query: string; maxRows: number }): Promise<{
    rows: Rows;
    more: boolean;
  }> {
    const request = (await this.connect()).request();
    request.stream = true;
    return new Promise((resolve, reject) => {
      const rows: Rows = [];
      let recordsets = 0;
      let more = false;
      let cancelled = false;
      request.on('recordset', () => {
        recordsets += 1;
      });
      request.on('row', (row: Record<string, any>) => {
        if (recordsets > 1 || cancelled) return;
        if (rows.length < maxRows) {
          rows.push(row);
          return;
        }
        more = true;
        cancelled = true;
        request.cancel();
      });
      request.on('error', (err: Error & { code?: string }) => {
        if (cancelled && err.code === 'ECANCEL') return;
        reject(err);
      });
      request.on('done', () => resolve({ rows, more }));
      request.query(query);
    });
  }

  /** Opens the pool once; parallel callers share the same promise. */
  connect(): Promise<sql.ConnectionPool> {
    if (!this.pool) {
      this.pool = this.open();
      // A failed connection (server down, wrong password) can be retried on the next call.
      // A failed `verify` is kept, so a privileged login never gets a second chance.
      this.pool.catch((err) => {
        if (!(err instanceof LoginCheckError)) this.pool = null;
      });
    }
    return this.pool;
  }

  private async open(): Promise<sql.ConnectionPool> {
    const pool = await new sql.ConnectionPool(this.config).connect();
    if (this.verify) {
      try {
        await this.verify(new Db(this.config, undefined).usePool(pool));
      } catch (err) {
        await pool.close().catch(() => undefined);
        throw err;
      }
    }
    return pool;
  }

  private usePool(pool: sql.ConnectionPool): Db {
    this.pool = Promise.resolve(pool);
    return this;
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await (await pool.catch(() => null))?.close();
  }
}

/** Thrown by the login check; never retried. */
export class LoginCheckError extends Error {}
