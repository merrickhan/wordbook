import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, type AppOptions } from '../server/app';
import { MAX_LOGIN_FAILURES, SESSION_TTL_SECONDS } from '../server/auth';
import { createApiStore } from '../src/api-store';
import { createEntry, sample } from '../src/entry';
import { parseBackup, serializeBackup } from '../src/backup';
import { MessageError, type Message } from '../src/messages';
import { createTestDatabase } from './helpers/database';

const password = 'correct horse battery';
const sessionSecret = 's'.repeat(40);
const origin = 'https://wordbook.test';

async function setup(options: Partial<AppOptions> = {}) {
  const db = await createTestDatabase();
  let clock = new Date('2026-10-01T00:00:00.000Z');
  const app = createApp({ db, password, sessionSecret, now: () => clock, failureDelayMs: 0, log: () => {}, ...options });
  let cookie = '';
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await app.handle(new Request(origin + path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-wordbook': '1' }),
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body),
    }));
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    return response;
  }
  async function signIn() {
    const response = await call('POST', '/api/session', { password });
    assert.equal(response.status, 200);
  }
  return {
    db, app, call, signIn,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    get cookie() { return cookie; },
    set cookie(value: string) { cookie = value; },
  };
}

async function errorOf(response: Response): Promise<Message> {
  return (await response.json() as { error: Message }).error;
}

test('missing or weak configuration fails closed without touching the database', async () => {
  for (const config of [{ password: undefined }, { password: 'short' }, { sessionSecret: 'too-short' }]) {
    const { db, call } = await setup(config);
    const response = await call('GET', '/api/library');
    assert.equal(response.status, 500);
    const body = await response.json() as { error: unknown; problems: string[] };
    assert.deepEqual(body.error, { code: 'serverMisconfigured' });
    assert.equal(body.problems.length, 1);
    assert.ok(body.problems.every(problem => !problem.includes(password) && !problem.includes(sessionSecret)));
    assert.deepEqual(db.modes, []);
  }
});

test('writes require the client header, and the library requires a session', async () => {
  const { call, signIn } = await setup();
  const forged = await call('POST', '/api/session', { password }, { 'x-wordbook': '' });
  assert.equal(forged.status, 403);
  assert.deepEqual(await errorOf(forged), { code: 'requestRejected' });
  const anonymous = await call('GET', '/api/library');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await errorOf(anonymous), { code: 'authRequired' });
  assert.deepEqual(await (await call('GET', '/api/session')).json(), { authenticated: false });
  await signIn();
  assert.deepEqual(await (await call('GET', '/api/session')).json(), { authenticated: true });
  assert.deepEqual(await (await call('GET', '/api/library')).json(), { words: [], categories: [] });
});

test('session cookies are HttpOnly, SameSite=Strict, host-only on HTTPS and expire', async () => {
  const context = await setup();
  const response = await context.call('POST', '/api/session', { password });
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header, /^__Host-wordbook_session=v1\.\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  const plain = await context.app.handle(new Request('http://localhost:5173/api/session', {
    method: 'POST', headers: { 'x-wordbook': '1' }, body: JSON.stringify({ password }),
  }));
  assert.match(plain.headers.get('set-cookie') ?? '', /^wordbook_session=.*SameSite=Strict; Max-Age=\d+$/);
  context.advance(SESSION_TTL_SECONDS * 1000 + 1000);
  assert.equal((await context.call('GET', '/api/library')).status, 401);
});

test('tampered tokens, other secrets and a changed password invalidate sessions', async () => {
  const context = await setup();
  await context.signIn();
  const valid = context.cookie;
  context.cookie = valid.slice(0, -2) + (valid.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await context.call('GET', '/api/library')).status, 401);
  for (const options of [{ sessionSecret: 'x'.repeat(40) }, { password: 'a different password' }]) {
    const other = createApp({ db: context.db, password, sessionSecret, log: () => {}, ...options });
    const response = await other.handle(new Request(origin + '/api/library', { headers: { cookie: valid } }));
    assert.equal(response.status, 401);
  }
});

test('failed sign-ins are rejected, throttled globally and reset after a success window', async () => {
  const context = await setup();
  const wrong = await context.call('POST', '/api/session', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await errorOf(wrong), { code: 'loginFailed' });
  assert.equal(wrong.headers.get('set-cookie'), null);
  for (let attempt = 1; attempt < MAX_LOGIN_FAILURES; attempt++)
    await context.call('POST', '/api/session', { password: 123 });
  const throttled = await context.call('POST', '/api/session', { password });
  assert.equal(throttled.status, 429);
  assert.deepEqual(await errorOf(throttled), { code: 'loginRateLimited' });
  context.advance(15 * 60 * 1000 + 1);
  await context.signIn();
});

test('sign-out clears the cookie', async () => {
  const context = await setup();
  await context.signIn();
  const response = await context.call('DELETE', '/api/session');
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal(context.cookie, '');
  assert.equal((await context.call('GET', '/api/library')).status, 401);
});

test('routes work through both direct paths and the platform rewrite query', async () => {
  const context = await setup();
  await context.signIn();
  const saved = await context.call('POST', '/api/words', { entry: createEntry('apple') });
  assert.equal(saved.status, 201);
  const entry = await saved.json() as { id: number };
  const rewritten = await context.call('DELETE', `/api?route=words/${entry.id}`);
  assert.equal(rewritten.status, 204);
  assert.deepEqual(await (await context.call('GET', '/api?route=library')).json(), { words: [], categories: [] });
  for (const [method, path] of [['GET', '/api/unknown'], ['POST', '/api/library'], ['DELETE', '/api/words/1/extra']]) {
    const response = await context.call(method, path, method === 'GET' ? undefined : {});
    assert.equal(response.status, 404, path);
  }
  const invalid = await context.call('DELETE', '/api/words/01');
  assert.deepEqual(await errorOf(invalid), { code: 'storageInvalidId' });
});

test('domain errors keep their message codes and parameters, malformed bodies are rejected', async () => {
  const context = await setup();
  await context.signIn();
  await context.call('POST', '/api/words', { entry: sample });
  const duplicate = await context.call('POST', '/api/words', { entry: { ...sample, word: 'INVESTIGATION' } });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await errorOf(duplicate), { code: 'duplicateWord', params: { word: 'investigation' } });
  for (const body of ['{', '[]', 'null', new Uint8Array([0xff, 0xfe])]) {
    const response = await context.call('POST', '/api/categories', body);
    assert.equal(response.status, 400);
    assert.deepEqual(await errorOf(response), { code: 'invalidRequest' });
  }
  const huge = await context.call('POST', '/api/categories', JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
  assert.deepEqual(await errorOf(huge), { code: 'requestTooLarge' });
  const unsupported = await context.call('POST', '/api/categories', { name: 'x' }, { 'x-wordbook-encoding': 'br' });
  assert.equal(unsupported.status, 415);
});

test('gzip import bodies are accepted and limited after decompression', async () => {
  const context = await setup();
  await context.signIn();
  const gzip = async (text: string) => new Uint8Array(await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const batch = { categories: ['Topic'], entries: [{ ...createEntry('apple'), created: '2024-01-01T00:00:00.000Z', categories: ['Topic'] }] };
  const ok = await context.call('POST', '/api/import', await gzip(JSON.stringify({ batch, overwriteExisting: false })),
    { 'x-wordbook-encoding': 'gzip' });
  assert.deepEqual(await ok.json(), { imported: 1, updated: 0, skipped: 0, classified: 1, categoriesCreated: 1 });
  const bomb = await context.call('POST', '/api/import', await gzip(JSON.stringify({ batch, padding: ' '.repeat(11 * 1024 * 1024) })),
    { 'x-wordbook-encoding': 'gzip' });
  assert.equal(bomb.status, 413);
  assert.deepEqual(await errorOf(bomb), { code: 'backupTooLarge' });
});

test('large library responses are gzip-encoded only for clients that accept it', async () => {
  const context = await setup();
  await context.signIn();
  const entries = Array.from({ length: 300 }, (_, index) => ({
    ...createEntry('word ' + 'abcdefghijklmnopqrstuvwxyz'[index % 26] + 'x'.repeat(index % 50)),
    definition: 'd'.repeat(200), created: '2024-01-01T00:00:00.000Z', categories: [],
  }));
  await context.call('POST', '/api/import', { batch: { categories: [], entries } });
  const plain = await context.call('GET', '/api/library');
  assert.equal(plain.headers.get('content-encoding'), null);
  const zipped = await context.call('GET', '/api/library', undefined, { 'accept-encoding': 'gzip, br' });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  const text = await new Response(zipped.body!.pipeThrough(new DecompressionStream('gzip'))).text();
  assert.deepEqual(JSON.parse(text), await plain.json());
});

test('unexpected failures are logged and reported generically', async () => {
  const logged: unknown[] = [];
  const context = await setup({ log: error => logged.push(error) });
  await context.signIn();
  context.db.failOn(/FROM categories/);
  const response = await context.call('GET', '/api/library');
  assert.equal(response.status, 503);
  assert.deepEqual(await errorOf(response), { code: 'storageUnavailable' });
  assert.equal(logged.length, 1);
});

test('the browser client round-trips every operation and a v2 backup through the API', async () => {
  const context = await setup();
  const fetcher = (input: string, init?: RequestInit) => context.call(init?.method ?? 'GET', '/' + input,
    init?.body as string | undefined, Object.fromEntries(new Headers(init?.headers).entries()));
  let unauthorized = 0;
  const client = createApiStore({ fetch: fetcher, base: 'api/', onUnauthorized: () => unauthorized++ });
  assert.equal(await client.session(), false);
  await assert.rejects(client.snapshot(), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'authRequired');
  assert.equal(unauthorized, 1);
  await assert.rejects(client.login('wrong password'), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'loginFailed');
  await client.login(password);
  assert.equal(await client.session(), true);

  const topic = await client.createCategory(' Topic ');
  const apple = await client.save(createEntry('apple'), [topic.id]);
  const pear = await client.save(createEntry('pear'));
  await assert.rejects(client.save(createEntry('Apple')), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'duplicateWord');
  assert.deepEqual(await client.renameCategory(topic.id, 'Reading'), { id: topic.id, name: 'Reading' });
  assert.deepEqual(await client.updateWordCategories([pear.id, 999], { mode: 'add', categoryIds: [topic.id] }),
    { changed: 1, unchanged: 0, missing: 1 });
  const backup = serializeBackup(await client.snapshot(), '2026-10-01T00:00:00.000Z');
  await client.remove(apple.id);
  await client.deleteCategory(topic.id);
  assert.deepEqual(await client.list(), [{ ...pear, categoryIds: [] }]);
  assert.deepEqual(await client.importEntries(parseBackup(backup), { overwriteExisting: true }),
    { imported: 1, updated: 1, skipped: 0, classified: 2, categoriesCreated: 1 });
  const restored = await client.snapshot();
  assert.deepEqual(restored.words.map(entry => [entry.word, entry.categoryIds.length]), [['apple', 1], ['pear', 1]]);

  await client.logout();
  assert.equal(await client.session(), false);
});

test('the browser client maps network failures and unknown server errors to safe messages', async () => {
  const offline = createApiStore({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.snapshot(), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'serverUnreachable');
  for (const [status, body, expected] of [
    [500, { error: { code: '<script>' } }, 'storageUnavailable'],
    [422, { error: { code: 'duplicateWord', params: {} } }, 'operationFailed'],
    [502, 'not json', 'storageUnavailable'],
    [409, { error: { code: 'categoryMissing' } }, 'categoryMissing'],
  ] as const) {
    const client = createApiStore({
      fetch: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    });
    await assert.rejects(client.snapshot(), (error: unknown) =>
      error instanceof MessageError && error.detail.code === expected);
  }
  const malformed = createApiStore({ fetch: async () => Response.json({ words: [{ id: 1 }], categories: [] }) });
  await assert.rejects(malformed.snapshot(), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'storageInvalidRecord');
  await assert.rejects(malformed.remove(0), (error: unknown) =>
    error instanceof MessageError && error.detail.code === 'storageInvalidId');
});
