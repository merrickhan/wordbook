// In-process Postgres (PGlite) for tests: real SQL semantics without a database server.
import { after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable, Row, TransactionMode } from '../../server/db';
import { createLibraryStore } from '../../server/store';

export type TestDatabase = Database & {
  /** Modes of every transaction started, in order. */
  modes: TransactionMode[];
  /** Makes the next statement matching `pattern` fail with `error` instead of running. */
  failOn(pattern: RegExp, error?: unknown): void;
  close(): Promise<void>;
};

const open: TestDatabase[] = [];
after(() => Promise.all(open.splice(0).map(db => db.close())));

export function injectedFailure(): Error {
  return Object.assign(new Error('Injected failure'), { code: 'XX000' });
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.waitReady;
  const modes: TransactionMode[] = [];
  const failures: { pattern: RegExp; error: unknown }[] = [];
  const wrap = (run: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>): Queryable => ({
    async query<T extends Row>(text: string, params: readonly unknown[] = []) {
      const failure = failures.findIndex(({ pattern }) => pattern.test(text));
      if (failure >= 0) throw failures.splice(failure, 1)[0].error;
      return { rows: (await run(text, [...params])).rows as T[] };
    },
  });
  let closed = false;
  const db: TestDatabase = {
    modes,
    ...wrap((text, params) => pg.query(text, params)),
    transaction(mode, work) {
      modes.push(mode);
      return pg.transaction(async tx => {
        await tx.query(mode === 'read'
          ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        return work(wrap((text, params) => tx.query(text, params)));
      });
    },
    failOn(pattern, error = injectedFailure()) {
      failures.push({ pattern, error });
    },
    async close() {
      if (closed) return;
      closed = true;
      await pg.close();
    },
  };
  open.push(db);
  return db;
}

/**
 * A library store over a test database. `close()` is a no-op so tests written for the former
 * browser store can "reopen" by creating another store over the same database.
 */
export async function createTestStore(options: { db?: TestDatabase; now?: () => Date } = {}) {
  const db = options.db ?? await createTestDatabase();
  return { ...createLibraryStore(db, { now: options.now }), db, close: async () => {} };
}

/** Raw table contents in primary-key order, for asserting exactly what was persisted. */
export async function dumpTables(db: Database) {
  const words = (await db.query('SELECT * FROM words ORDER BY id')).rows;
  const categories = (await db.query('SELECT * FROM categories ORDER BY id')).rows;
  const links = (await db.query('SELECT * FROM word_categories ORDER BY word_id, category_id')).rows;
  return { words, categories, links };
}
