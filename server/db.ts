// Minimal database contract shared by the production pg pool and the in-process test database.
// Relative imports in server code and the shared domain modules it uses keep explicit `.js`
// extensions so the Vercel Node.js runtime can load the compiled ES modules without a bundler.

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export type TransactionMode = 'read' | 'write';

export interface Database extends Queryable {
  /**
   * Runs `work` inside one transaction. Read transactions use a read-only REPEATABLE READ snapshot.
   * The callback's result is returned only after COMMIT succeeds; any error rolls back.
   */
  transaction<T>(mode: TransactionMode, work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function beginStatement(mode: TransactionMode): string {
  return mode === 'read'
    ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    : 'BEGIN ISOLATION LEVEL READ COMMITTED';
}

/** Postgres SQLSTATE of a driver error, when present. */
export function sqlState(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
