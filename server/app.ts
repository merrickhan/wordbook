// Framework-neutral HTTP API: (Request) => Response, shared by the Vercel function and tests.
import { MAX_BACKUP_BYTES } from '../src/backup.js';
import { MessageError, type Message } from '../src/messages.js';
import {
  clearLoginFailures, clearedSessionCookie, createSessionToken, isAuthenticated, loginThrottled,
  passwordMatches, recordLoginFailure, sessionCookie, validConfig, type AuthConfig,
} from './auth.js';
import type { Database } from './db.js';
import { createLibraryStore } from './store.js';

export type AppOptions = {
  db: Database;
  password?: string;
  sessionSecret?: string;
  now?: () => Date;
  /** Delay added to failed sign-ins. */
  failureDelayMs?: number;
  log?: (error: unknown) => void;
};

// Every non-GET request must carry this header. Browsers cannot add it cross-site without a CORS
// preflight, which this API never approves, so it complements the SameSite=Strict cookie against CSRF.
export const CLIENT_HEADER = 'x-wordbook';
export const ENCODING_HEADER = 'x-wordbook-encoding';
const MAX_REQUEST_BYTES = 1024 * 1024;
// A backup's JSON plus the small import envelope.
const MAX_IMPORT_BYTES = MAX_BACKUP_BYTES + 64 * 1024;
const GZIP_THRESHOLD = 32 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, readonly detail: Message) {
    super(detail.code);
  }
}

const statusByCode: Partial<Record<Message['code'], number>> = {
  duplicateWord: 409,
  duplicateCategory: 409,
  categoryMissing: 409,
  storageUnavailable: 503,
  storageConstraint: 409,
  storageInvalidRecord: 500,
};

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function empty(status = 204, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function failure(status: number, detail: Message, headers: HeadersInit = {}): Response {
  return json({ error: detail }, status, headers);
}

async function compressed(request: Request, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding',
  };
  // Large libraries would otherwise approach the hosting platform's response size limit.
  if (body.length < GZIP_THRESHOLD || !/\bgzip\b/i.test(request.headers.get('accept-encoding') ?? ''))
    return new Response(body, { headers });
  const gzipped = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Response(gzipped, { headers: { ...headers, 'content-encoding': 'gzip' } });
}

async function readBody(request: Request, limit: number, tooLarge: Message): Promise<Record<string, unknown>> {
  const encoding = request.headers.get(ENCODING_HEADER);
  if (encoding !== null && encoding !== 'gzip') throw new HttpError(415, { code: 'invalidRequest' });
  let stream = request.body;
  if (!stream) throw new HttpError(400, { code: 'invalidRequest' });
  if (encoding === 'gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, tooLarge);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, { code: 'invalidRequest' });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, { code: 'invalidRequest' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, { code: 'invalidRequest' });
  return value as Record<string, unknown>;
}

function pathId(segment: string | undefined): number {
  if (!segment || !/^[1-9]\d{0,15}$/.test(segment) || !Number.isSafeInteger(Number(segment)))
    throw new MessageError({ code: 'storageInvalidId' });
  return Number(segment);
}

/** Reads the API route from the path, or from the `route` query a platform rewrite may supply. */
export function apiRoute(url: URL): string[] {
  const rewritten = url.searchParams.get('route');
  const path = rewritten ?? url.pathname.replace(/^.*?\/api(?:\/|$)/, '');
  return path.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
}

export function createApp(options: AppOptions) {
  const now = options.now ?? (() => new Date());
  const store = createLibraryStore(options.db, { now });
  const log = options.log ?? ((error: unknown) => console.error(error));
  const delay = options.failureDelayMs ?? 750;
  const config: Partial<AuthConfig> = { password: options.password, sessionSecret: options.sessionSecret };

  async function session(request: Request, method: string, auth: AuthConfig): Promise<Response> {
    if (method === 'GET') return json({ authenticated: await isAuthenticated(auth, request, now()) });
    if (method === 'DELETE') return empty(204, { 'set-cookie': clearedSessionCookie(request) });
    if (method !== 'POST') throw new HttpError(405, { code: 'invalidRequest' });
    const body = await readBody(request, MAX_REQUEST_BYTES, { code: 'requestTooLarge' });
    if (await loginThrottled(options.db, now())) return failure(429, { code: 'loginRateLimited' });
    if (!await passwordMatches(auth, body.password)) {
      await recordLoginFailure(options.db, now());
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      return failure(401, { code: 'loginFailed' });
    }
    await clearLoginFailures(options.db);
    return json({ authenticated: true }, 200, { 'set-cookie': sessionCookie(request, await createSessionToken(auth, now())) });
  }

  async function library(request: Request, method: string, route: string[]): Promise<Response> {
    const [resource, id, extra] = route;
    if (extra !== undefined) throw new HttpError(404, { code: 'invalidRequest' });
    const body = () => readBody(request, MAX_REQUEST_BYTES, { code: 'requestTooLarge' });
    switch (`${method} ${resource}${id === undefined ? '' : '/:id'}`) {
      case 'GET library':
        return compressed(request, await store.snapshot());
      case 'POST words': {
        const { entry, categoryIds } = await body();
        return json(await store.save(entry, categoryIds ?? []), 201);
      }
      case 'DELETE words/:id':
        await store.remove(pathId(id));
        return empty();
      case 'POST categories':
        return json(await store.createCategory((await body()).name), 201);
      case 'PATCH categories/:id': {
        const categoryId = pathId(id);
        return json(await store.renameCategory(categoryId, (await body()).name));
      }
      case 'DELETE categories/:id':
        await store.deleteCategory(pathId(id));
        return empty();
      case 'POST word-categories': {
        const { wordIds, change } = await body();
        return json(await store.updateWordCategories(wordIds, change));
      }
      case 'POST import': {
        const { batch, overwriteExisting, selectedCategoryIds } =
          await readBody(request, MAX_IMPORT_BYTES, { code: 'backupTooLarge' });
        return json(await store.importEntries(batch, { overwriteExisting, selectedCategoryIds: selectedCategoryIds ?? [] }));
      }
      default:
        throw new HttpError(404, { code: 'invalidRequest' });
    }
  }

  async function handle(request: Request): Promise<Response> {
    try {
      const method = request.method.toUpperCase();
      const route = apiRoute(new URL(request.url));
      if (method !== 'GET' && request.headers.get(CLIENT_HEADER) !== '1')
        return failure(403, { code: 'requestRejected' });
      if (!validConfig(config)) {
        log(new Error('WORDBOOK_PASSWORD (8+ characters) and WORDBOOK_SESSION_SECRET (32+ characters) must be set'));
        return failure(500, { code: 'serverMisconfigured' });
      }
      if (route[0] === 'session' && route.length === 1) return await session(request, method, config);
      if (!await isAuthenticated(config, request, now())) return failure(401, { code: 'authRequired' });
      return await library(request, method, route);
    } catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.detail);
      if (error instanceof MessageError) {
        if (error.cause !== undefined) log(error);
        return failure(statusByCode[error.detail.code] ?? 422, error.detail);
      }
      log(error);
      return failure(500, { code: 'storageUnavailable' });
    }
  }

  return { handle };
}
