// Builds the request handler from environment variables; shared by the Vercel function and `pnpm dev`.
import { createApp } from './app.js';
import { createPgDatabase } from './pg-database.js';

export type Environment = Record<string, string | undefined>;

export function createHandler(env: Environment): (request: Request) => Promise<Response> {
  // Vercel's Postgres integrations (such as Neon) name variables after the prefix chosen when the
  // database is connected; accept the app-specific prefix and the two common defaults.
  const connectionString = env.WORDBOOK_DATABASE_URL || env.DATABASE_URL || env.POSTGRES_URL;
  const app = connectionString
    ? createApp({
      db: createPgDatabase(connectionString),
      password: env.WORDBOOK_PASSWORD,
      sessionSecret: env.WORDBOOK_SESSION_SECRET,
    })
    : undefined;
  return async request => {
    if (app) return app.handle(request);
    const problems = ['None of WORDBOOK_DATABASE_URL, DATABASE_URL or POSTGRES_URL is set'];
    console.error(problems[0]);
    return Response.json({ error: { code: 'serverMisconfigured' }, problems }, { status: 500, headers: { 'cache-control': 'no-store' } });
  };
}
