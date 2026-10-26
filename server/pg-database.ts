import pg from 'pg';
import type { PoolConfig } from 'pg';
import { beginStatement, type Database, type Queryable, type Row } from './db.js';

/** Wraps a node-postgres pool. Neon and other hosted Postgres URLs carry their own SSL settings. */
export function createPgDatabase(connectionString: string, poolOptions: PoolConfig = {}): Database & { end(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    // Serverless instances are short-lived; keep few connections and release idle ones quickly.
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    ...poolOptions,
  });
  pool.on('error', () => {
    // Idle-client errors (for example a server-side disconnect) must not crash the function.
  });

  async function query<T extends Row>(text: string, params?: readonly unknown[]) {
    const result = await pool.query(text, params ? [...params] : undefined);
    return { rows: result.rows as T[] };
  }

  async function transaction<T>(mode: 'read' | 'write', work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(beginStatement(mode));
      const result = await work({
        async query<R extends Row>(text: string, params?: readonly unknown[]) {
          const queried = await client.query(text, params ? [...params] : undefined);
          return { rows: queried.rows as R[] };
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return { query, transaction, end: () => pool.end() };
}
