// Builds the request handler from environment variables; shared by the Vercel function and `pnpm dev`.
import { createApp } from './app.js';
import { createPgDatabase } from './pg-database.js';

export type Environment = Record<string, string | undefined>;

export function createHandler(env: Environment): (request: Request) => Promise<Response> {
  // Vercel's Postgres integrations (such as Neon) expose DATABASE_URL or POSTGRES_URL.
  const connectionString = env.DATABASE_URL || env.POSTGRES_URL;
  const app = connectionString
    ? createApp({
      db: createPgDatabase(connectionString),
      password: env.WORDBOOK_PASSWORD,
      sessionSecret: env.WORDBOOK_SESSION_SECRET,
    })
    : undefined;
  return async request => {
    if (app) return app.handle(request);
    console.error('DATABASE_URL (or POSTGRES_URL) is not set');
    return Response.json({ error: { code: 'serverMisconfigured' } }, { status: 500, headers: { 'cache-control': 'no-store' } });
  };
}
