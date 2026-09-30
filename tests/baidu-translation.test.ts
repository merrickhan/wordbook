import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  BAIDU_CALLBACK, buildBaiduUrl, parseBaiduTranslation, requestBaiduJsonp, translateBaidu,
  type BaiduTransport,
} from '../src/baidu-translation';
import { MessageError } from '../src/messages';
import type { BaiduCredentials } from '../src/translation-providers';

// Public documentation example and artificial test credentials only; no API is contacted.
const publicExample = { appid: '2015063000000001', key: '12345678' };
const credentials = { appid: '2026093000000001', key: 'dummyBaiduKeyForTestsOnly' };
const sensitive = 'raw-diagnostic-secret-must-not-escape';
const payload = (src = 'apple', dst = '苹果') => ({ from: 'en', to: 'zh', trans_result: [{ src, dst }] });
const url = () => buildBaiduUrl('apple', credentials, '12345678');
const codeIs = (code: string) => (error: unknown) => {
  assert.ok(error instanceof MessageError);
  assert.deepEqual(error.detail, { code });
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error) + JSON.stringify(error), new RegExp(sensitive));
  return true;
};
const noTransport: BaiduTransport = async () => { assert.fail('transport must not be called'); };

test('URL signing matches the public Baidu MD5 example and independent Node crypto', () => {
  const request = new URL(buildBaiduUrl('apple', publicExample, '1435660288'));
  const expected = createHash('md5').update('2015063000000001apple143566028812345678', 'utf8').digest('hex');
  assert.equal(expected, 'f89f9594663708c1605f3d736d01d2d4');
  assert.equal(request.origin + request.pathname, 'https://fanyi-api.baidu.com/api/trans/vip/translate');
  assert.deepEqual(Object.fromEntries(request.searchParams), {
    q: 'apple', from: 'en', to: 'zh', appid: publicExample.appid, salt: '1435660288',
    sign: expected, callback: BAIDU_CALLBACK,
  });
  assert.equal(BAIDU_CALLBACK, 'wordbookBaiduCallback');
  assert.equal(request.searchParams.has('key'), false);
});

test('signing preserves raw Unicode, apostrophes, spaces and reserved characters before encoding once', () => {
  for (const word of [" Mother's-in-law ", 'ice cream', 'café 中文 😀', 'a+b&c=%27/#?', '</script><script>bad()</script>']) {
    const salt = 'fixed-salt-123';
    const request = new URL(buildBaiduUrl(word, credentials, salt));
    assert.equal(request.searchParams.get('q'), word);
    assert.equal(request.searchParams.get('salt'), salt);
    assert.equal(request.searchParams.get('sign'), createHash('md5')
      .update(credentials.appid + word + salt + credentials.key, 'utf8').digest('hex'));
    assert.match(request.searchParams.get('sign')!, /^[a-f0-9]{32}$/);
    assert.equal([...request.searchParams.keys()].length, 7);
    assert.equal(request.href.includes(credentials.key), false);
    assert.equal(request.href.includes(encodeURIComponent(credentials.key)), false);
  }
  assert.match(buildBaiduUrl("mother's word", credentials, '123'), /q=mother%27s\+word&/);
  assert.match(buildBaiduUrl('%27', credentials, '123'), /q=%2527&/);
});

test('URL building rejects invalid credentials without reflecting them', () => {
  for (const value of [null, {}, [], { appid: '', key: sensitive }, { appid: credentials.appid, key: '' }]) {
    assert.throws(() => buildBaiduUrl('apple', value as BaiduCredentials, '123'), codeIs('baiduInvalidCredentials'));
  }
});

test('valid translations are trimmed, deduplicated and limited to the matching whole query', () => {
  assert.equal(parseBaiduTranslation(payload(), 'apple'), '苹果');
  assert.equal(parseBaiduTranslation({ ...payload(), trans_result: [
    { src: 'pineapple', dst: '不能拼入的菠萝' },
    { src: ' APPLE ', dst: ' 苹果 ' },
    { src: 'apple', dst: '苹果' },
    { src: 'apple', dst: '苹果公司 Apple' },
    { src: 'apple', dst: 'English only' },
    { src: 'apple', dst: '' },
  ] }, ' Apple '), '苹果；苹果公司 Apple');
  assert.equal(parseBaiduTranslation(payload("mother's-in-law", ' 姻亲 '), "mother's-in-law"), '姻亲');
  assert.equal(parseBaiduTranslation(payload('apple', '𠀀'), 'apple'), '𠀀');
});

test('absent error codes and numeric or string 200/52000 allow response parsing', () => {
  for (const error_code of [undefined, 200, '200', 52000, '52000']) {
    assert.equal(parseBaiduTranslation({ ...payload(), error_code }, 'apple'), '苹果');
  }
});

test('business errors take precedence over content and use only safe message codes', () => {
  const cases = [
    [52003, 'baiduAuthFailed'], [54001, 'baiduAuthFailed'], [90107, 'baiduAuthFailed'],
    [54003, 'baiduRateLimited'], [54005, 'baiduRateLimited'], [54004, 'baiduQuota'],
    [58000, 'baiduIpBlocked'], [58003, 'baiduIpBlocked'],
    [52001, 'baiduUnavailable'], [99999, 'baiduUnavailable'], [0, 'baiduUnavailable'],
  ] as const;
  for (const [number, code] of cases) {
    for (const error_code of [number, String(number)]) {
      for (const content of [payload(), { from: 'wrong', trans_result: null }]) {
        assert.throws(() => parseBaiduTranslation({ ...content, error_code, error_msg: sensitive }, 'apple'), codeIs(code));
      }
    }
  }
  assert.throws(() => parseBaiduTranslation({ error_code: sensitive, error_msg: sensitive }, 'apple'), codeIs('baiduUnavailable'));
});

test('invalid language, shape, source or non-Chinese content is rejected', () => {
  for (const value of [
    null, [], 'not JSON', 1, true, {},
    { ...payload(), from: 'auto' }, { ...payload(), from: 'fr' },
    { ...payload(), to: 'en' }, { ...payload(), to: 'zh-CN' }, { ...payload(), from: undefined },
    { ...payload(), error_code: null }, { ...payload(), error_code: {} }, { ...payload(), error_code: [] },
    { ...payload(), trans_result: null }, { ...payload(), trans_result: {} }, { ...payload(), trans_result: [] },
    { ...payload(), trans_result: [null] }, { ...payload(), trans_result: [{ src: 'apple' }] },
    { ...payload(), trans_result: [{ src: 1, dst: '苹果' }] },
    { ...payload(), trans_result: [{ src: 'apple', dst: ['苹果'] }] },
    { ...payload(), trans_result: [...payload().trans_result, { src: 'apple', dst: {} }] },
    payload('pineapple'), payload('apple pie'), payload('apple\npear'),
    payload('apple', ''), payload('apple', ' \n '), payload('apple', 'Apple'), payload('apple', '123?!'),
  ]) assert.throws(() => parseBaiduTranslation(value, 'apple'), codeIs('baiduInvalidResponse'));
  assert.throws(() => parseBaiduTranslation(payload(), ' '), codeIs('baiduInvalidResponse'));
});

test('translations respect the 2000-character limit without slicing complete values', () => {
  assert.equal(parseBaiduTranslation(payload('apple', ' ' + '中'.repeat(2000) + ' '), 'apple'), '中'.repeat(2000));
  assert.throws(() => parseBaiduTranslation(payload('apple', '中'.repeat(2001)), 'apple'), codeIs('baiduInvalidResponse'));
  assert.equal(parseBaiduTranslation({ ...payload(), trans_result: [
    { src: 'apple', dst: '中'.repeat(2001) }, { src: 'apple', dst: '苹果' },
  ] }, 'apple'), '苹果');
  assert.throws(() => parseBaiduTranslation({ ...payload(), trans_result: [
    { src: 'apple', dst: '中'.repeat(1000) }, { src: 'apple', dst: '文'.repeat(1000) },
  ] }, 'apple'), codeIs('baiduInvalidResponse'));
  assert.equal(parseBaiduTranslation({ ...payload(), trans_result: [
    { src: 'apple', dst: '中'.repeat(2000) }, { src: 'apple', dst: '中'.repeat(2000) },
  ] }, 'apple').length, 2000);
});

test('parser exceptions cannot expose raw upstream diagnostics', () => {
  const value = { get error_code() { throw new Error(sensitive); } };
  assert.throws(() => parseBaiduTranslation(value, 'apple'), codeIs('baiduInvalidResponse'));
});

test('translation injects only a signed URL and signal into the transport with fresh random salts', async (context) => {
  let randomCalls = 0;
  context.mock.method(globalThis.crypto, 'getRandomValues', ((bytes: Uint8Array) => {
    assert.equal(bytes.length, 16);
    return bytes.fill(++randomCalls);
  }) as typeof crypto.getRandomValues);
  const controller = new AbortController();
  const requests: URL[] = [];
  const transport: BaiduTransport = async (request, signal) => {
    assert.equal(signal, controller.signal);
    requests.push(new URL(request));
    return payload(' APPLE ', ' 苹果 ');
  };
  assert.equal(await translateBaidu(' Apple ', credentials, controller.signal, transport), '苹果');
  assert.equal(await translateBaidu(' Apple ', credentials, controller.signal, transport), '苹果');
  assert.equal(randomCalls, 2);
  assert.notEqual(requests[0].searchParams.get('salt'), requests[1].searchParams.get('salt'));
  for (const request of requests) {
    assert.equal(request.searchParams.get('q'), ' Apple ');
    assert.equal(request.searchParams.get('sign'), createHash('md5')
      .update(credentials.appid + ' Apple ' + request.searchParams.get('salt') + credentials.key).digest('hex'));
    assert.equal(request.href.includes(credentials.key), false);
  }
});

test('missing or invalid configuration rejects before randomness and transport', async (context) => {
  context.mock.method(globalThis.crypto, 'getRandomValues', () => { assert.fail('must not need randomness'); });
  for (const value of [null, undefined]) {
    await assert.rejects(translateBaidu('apple', value as null, undefined, noTransport), codeIs('baiduNotConfigured'));
  }
  for (const value of [{}, [], 'key', { appid: 'not-an-appid', key: sensitive }, { appid: credentials.appid, key: '' }]) {
    await assert.rejects(translateBaidu('apple', value as BaiduCredentials, undefined, noTransport), codeIs('baiduInvalidCredentials'));
  }
});

test('transport exceptions are sanitized and preserve only approved Baidu message codes', async () => {
  for (const transport of [
    (() => { throw new Error(sensitive); }) as BaiduTransport,
    async () => { throw new Error(sensitive, { cause: credentials }); },
    async () => { throw { url: url(), key: credentials.key, error_msg: sensitive }; },
    async () => { throw sensitive; },
  ]) await assert.rejects(translateBaidu('apple', credentials, undefined, transport), codeIs('baiduUnavailable'));
  const known = new MessageError({ code: 'baiduTimedOut' }, { cause: sensitive });
  known.message = sensitive;
  await assert.rejects(translateBaidu('apple', credentials, undefined, async () => { throw known; }), (error) => {
    assert.notEqual(error, known);
    return codeIs('baiduTimedOut')(error);
  });
  await assert.rejects(translateBaidu('apple', credentials, undefined, async () => ({ error_code: 54003, error_msg: sensitive })),
    codeIs('baiduRateLimited'));
  await assert.rejects(translateBaidu('apple', credentials, undefined, async () => payload('other')), codeIs('baiduInvalidResponse'));
});

test('pre-cancellation wins over missing configuration and preserves the exact reason', async () => {
  for (const reason of [new Error('cancel'), { cancelled: true }, 'cancel', null]) {
    const controller = new AbortController();
    controller.abort(reason);
    await assert.rejects(translateBaidu('apple', null, controller.signal, noTransport), (error) => error === reason);
    await assert.rejects(requestBaiduJsonp('invalid URL', controller.signal), (error) => error === reason);
  }
});

test('cancellation rejects immediately even when the injected transport ignores the signal', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const controller = new AbortController();
    const reason = { cancelled: outcome };
    let complete!: (value: unknown) => void;
    const pending = translateBaidu('apple', credentials, controller.signal, () => new Promise((resolve, reject) => {
      complete = outcome === 'resolve' ? resolve : reject;
    }));
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    complete(outcome === 'resolve' ? payload() : new Error(sensitive));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test('cancellation during transport completion or parsing never returns a stale translation', async () => {
  for (const duringParsing of [false, true]) {
    const controller = new AbortController();
    const reason = { phase: duringParsing };
    const transport: BaiduTransport = async () => {
      if (!duringParsing) controller.abort(reason);
      return { ...payload(), get trans_result() {
        if (duringParsing) controller.abort(reason);
        return payload().trans_result;
      } };
    };
    await assert.rejects(translateBaidu('apple', credentials, controller.signal, transport), (error) => error === reason);
  }
});

test('translation removes its abort listener after success and failure', async (context) => {
  for (const succeeds of [true, false]) {
    const controller = new AbortController();
    const add = context.mock.method(controller.signal, 'addEventListener');
    const remove = context.mock.method(controller.signal, 'removeEventListener');
    const promise = translateBaidu('apple', credentials, controller.signal, async () => {
      if (!succeeds) throw new Error(sensitive);
      return payload();
    });
    if (succeeds) assert.equal(await promise, '苹果');
    else await assert.rejects(promise, codeIs('baiduUnavailable'));
    assert.equal(add.mock.callCount(), 1);
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1]);
    controller.abort();
    assert.equal(remove.mock.callCount(), 1);
  }
});

test('randomness failure is an asynchronous, sanitized local failure', async (context) => {
  context.mock.method(globalThis.crypto, 'getRandomValues', () => { throw new Error(sensitive); });
  let promise!: Promise<string>;
  assert.doesNotThrow(() => { promise = translateBaidu('apple', credentials, undefined, noTransport); });
  await assert.rejects(promise, codeIs('baiduUnavailable'));
  await assert.rejects(requestBaiduJsonp(url()), codeIs('baiduUnavailable'));
});

// Minimal message/iframe stub; no browser or network implementation is installed here.
type Listener = (event: MessageEvent) => void;
function mockDom(context: TestContext, fails?: 'create' | 'append' | 'post' | 'remove') {
  const listeners = new Set<Listener>();
  const created: string[] = [];
  const frames: ReturnType<typeof makeFrame>[] = [];
  const makeFrame = () => {
    const attributes: Record<string, string> = {};
    const requests: { data: Record<string, unknown>; origin: string }[] = [];
    return {
      hidden: false, tabIndex: 0, title: '', referrerPolicy: '', srcdoc: '', attributes, requests, removed: 0,
      setAttribute(name: string, value: string) { attributes[name] = value; },
      remove() { this.removed++; if (fails === 'remove') throw new Error(sensitive); },
      contentWindow: { postMessage(data: Record<string, unknown>, origin: string) {
        if (fails === 'post') throw new Error(sensitive);
        requests.push({ data, origin });
      } },
    };
  };
  const owner = {
    addEventListener(type: string, listener: Listener) { assert.equal(type, 'message'); listeners.add(listener); },
    removeEventListener(type: string, listener: Listener) { assert.equal(type, 'message'); listeners.delete(listener); },
  };
  const document = {
    createElement(tag: string) {
      created.push(tag);
      assert.equal(tag, 'iframe', 'no third-party script may enter the parent document');
      if (fails === 'create') throw new Error(sensitive);
      const frame = makeFrame(); frames.push(frame); return frame;
    },
    body: { appendChild() { if (fails === 'append') throw new Error(sensitive); } },
  };
  for (const [key, value] of Object.entries({ window: owner, document })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const token = (index = 0) => {
    const match = /const token = '([a-f0-9]{32})'/.exec(frames[index].srcdoc);
    assert.ok(match); return match[1];
  };
  const emit = (data: Record<string, unknown>, index = 0, source: unknown = frames[index].contentWindow, origin = 'null') => {
    for (const listener of [...listeners]) listener({ data, source, origin } as MessageEvent);
  };
  const ready = (index = 0) => emit({ type: 'ready', token: token(index) }, index);
  const result = (value: unknown, index = 0) => emit({ type: 'result', token: token(index), ok: true, value }, index);
  return { frames, listeners, created, token, emit, ready, result };
}

test('JSONP rejects non-protocol URLs before creating DOM or contacting any host', async (context) => {
  const dom = mockDom(context);
  const valid = url();
  const change = (key: string, value: string) => { const next = new URL(valid); next.searchParams.set(key, value); return next.href; };
  for (const invalid of [
    '', 'not a URL', 'javascript:alert(1)', valid.replace('https:', 'http:'),
    valid.replace('fanyi-api.baidu.com', 'fanyi-api.baidu.com.evil.example'),
    valid.replace('fanyi-api.baidu.com', 'user:password@fanyi-api.baidu.com'),
    valid.replace('fanyi-api.baidu.com', 'fanyi-api.baidu.com:8443'),
    valid.replace('/translate?', '/other?'), valid + '#fragment', ' ' + valid,
    valid.replace('/api/', '/api/../api/'), valid + '&callback=' + BAIDU_CALLBACK,
    valid + '&key=' + credentials.key, valid + '&extra=1',
    change('callback', 'alert'), change('from', 'auto'), change('to', 'en'),
    change('sign', 'not-a-signature'), change('q', ''), change('salt', ''),
  ]) await assert.rejects(requestBaiduJsonp(invalid), codeIs('baiduInvalidResponse'));
  assert.deepEqual(dom.created, []);
  assert.equal(dom.listeners.size, 0);
});

test('JSONP uses opaque sandbox, CSP nonce and a source/token/phase-checked handshake', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const dom = mockDom(context);
  const word = '</script><script>queryMustNotEnterSrcdoc()</script>';
  const requestUrl = buildBaiduUrl(word, credentials, '123');
  const pending = requestBaiduJsonp(requestUrl);
  const frame = dom.frames[0];
  assert.equal(frame.hidden, true);
  assert.equal(frame.tabIndex, -1);
  assert.ok(frame.title);
  assert.deepEqual(frame.attributes, { sandbox: 'allow-scripts' });
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.match(frame.srcdoc, /default-src 'none'/);
  assert.match(frame.srcdoc, /base-uri 'none'/);
  assert.match(frame.srcdoc, /form-action 'none'/);
  const nonce = /<script nonce="([a-f0-9]{32})">/.exec(frame.srcdoc)![1];
  assert.ok(frame.srcdoc.includes("script-src 'nonce-" + nonce + "' https://fanyi-api.baidu.com"));
  assert.match(frame.srcdoc, /<meta name="referrer" content="no-referrer">/);
  for (const secret of [requestUrl, word, credentials.appid, credentials.key, 'queryMustNotEnterSrcdoc'])
    assert.equal(frame.srcdoc.includes(secret), false);
  assert.equal('crossOrigin' in frame, false);
  assert.deepEqual(dom.created, ['iframe']);

  dom.emit({ type: 'ready', token: dom.token() }, 0, {});
  dom.emit({ type: 'ready', token: 'wrong' });
  dom.emit({ type: 'ready', token: dom.token() }, 0, frame.contentWindow, 'https://example.com');
  dom.emit({ type: 'unexpected', token: dom.token() });
  dom.result(payload()); // A result cannot bypass the ready stage.
  assert.equal(frame.requests.length, 0);
  assert.equal(frame.removed, 0);
  dom.ready();
  assert.deepEqual(frame.requests, [{ data: { type: 'request', token: dom.token(), url: requestUrl }, origin: '*' }]);
  dom.ready();
  assert.equal(frame.requests.length, 1);
  const value = payload();
  dom.result(value);
  assert.equal(await pending, value);
  assert.equal(frame.removed, 1);
  assert.equal(dom.listeners.size, 0);
  dom.result({ error_code: 54003 });
  context.mock.timers.tick(30000);
  assert.equal(frame.removed, 1);
});

test('concurrent JSONP requests cannot consume each other’s messages', async (context) => {
  const dom = mockDom(context);
  const first = requestBaiduJsonp(url());
  const second = requestBaiduJsonp(url());
  assert.notEqual(dom.token(0), dom.token(1));
  dom.emit({ type: 'ready', token: dom.token(0) }, 1);
  assert.equal(dom.frames[0].requests.length, 0);
  assert.equal(dom.frames[1].requests.length, 0);
  dom.ready(0); dom.ready(1);
  dom.result(payload('apple', '一'), 1);
  assert.deepEqual(await second, payload('apple', '一'));
  assert.equal(dom.frames[0].removed, 0);
  assert.equal(dom.listeners.size, 1);
  dom.result(payload(), 0);
  await first;
  assert.equal(dom.listeners.size, 0);
});

test('JSONP abort removes the frame, timer and both listeners immediately in either stage', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const dom = mockDom(context);
  for (const ready of [false, true]) {
    const index = dom.frames.length;
    const controller = new AbortController();
    const removed = context.mock.method(controller.signal, 'removeEventListener');
    const reason = { cancelled: ready };
    const pending = requestBaiduJsonp(url(), controller.signal);
    if (ready) dom.ready(index);
    controller.abort(reason);
    assert.equal(dom.frames[index].removed, 1);
    assert.equal(dom.listeners.size, 0);
    assert.equal(removed.mock.callCount(), 1);
    await assert.rejects(pending, (error) => error === reason);
    context.mock.timers.tick(30000);
    dom.result(payload(), index);
    assert.equal(dom.frames[index].removed, 1);
  }
});

test('the 30-second JSONP deadline includes waiting for ready and does not restart after it', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const dom = mockDom(context);
  for (const ready of [false, true]) {
    const index = dom.frames.length;
    const pending = requestBaiduJsonp(url());
    context.mock.timers.tick(29999);
    if (ready) dom.ready(index);
    assert.equal(dom.frames[index].removed, 0);
    context.mock.timers.tick(1);
    await assert.rejects(pending, codeIs('baiduTimedOut'));
    assert.equal(dom.frames[index].removed, 1);
    assert.equal(dom.listeners.size, 0);
  }
});

test('messages received past the deadline cannot win against a delayed timer', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const dom = mockDom(context);
  for (const ready of [false, true]) {
    const index = dom.frames.length;
    const pending = requestBaiduJsonp(url());
    if (ready) dom.ready(index);
    context.mock.timers.setTime(Date.now() + 30000);
    if (ready) dom.result(payload(), index);
    else dom.ready(index);
    await assert.rejects(pending, codeIs('baiduTimedOut'));
    assert.equal(dom.frames[index].removed, 1);
    assert.equal(dom.listeners.size, 0);
  }
});

test('frame result errors and malformed envelopes never reflect arbitrary fields', async (context) => {
  const dom = mockDom(context);
  for (const [data, code] of [
    [{ ok: false, code: 'baiduUnavailable' }, 'baiduUnavailable'],
    [{ ok: false, code: 'baiduInvalidResponse' }, 'baiduInvalidResponse'],
    [{ ok: false, code: sensitive }, 'baiduInvalidResponse'],
    [{ ok: true }, 'baiduInvalidResponse'], [{ ok: 'true', value: payload() }, 'baiduInvalidResponse'],
  ] as const) {
    const index = dom.frames.length;
    const pending = requestBaiduJsonp(url());
    dom.ready(index);
    dom.emit({ type: 'result', token: dom.token(index), ...data, error_msg: sensitive }, index);
    await assert.rejects(pending, codeIs(code));
    assert.equal(dom.frames[index].removed, 1);
    assert.equal(dom.listeners.size, 0);
  }
});

for (const fails of ['create', 'append', 'post', 'remove'] as const) {
  test(`synchronous ${fails} failure still settles asynchronously and cleans remaining resources`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const dom = mockDom(context, fails);
    const controller = new AbortController();
    const removed = context.mock.method(controller.signal, 'removeEventListener');
    let pending!: Promise<unknown>;
    assert.doesNotThrow(() => { pending = requestBaiduJsonp(url(), controller.signal); });
    if (fails === 'post' || fails === 'remove') dom.ready();
    if (fails === 'remove') {
      dom.result(payload());
      assert.deepEqual(await pending, payload());
    } else await assert.rejects(pending, codeIs('baiduUnavailable'));
    assert.equal(dom.listeners.size, 0);
    assert.equal(removed.mock.callCount(), 1);
    if (dom.frames.length) assert.equal(dom.frames[0].removed, 1);
    context.mock.timers.tick(30000);
    assert.equal(removed.mock.callCount(), 1);
  });
}

test('missing browser DOM is a safe asynchronous transport failure', async () => {
  assert.equal(typeof document, 'undefined');
  let pending!: Promise<unknown>;
  assert.doesNotThrow(() => { pending = requestBaiduJsonp(url()); });
  await assert.rejects(pending, codeIs('baiduUnavailable'));
});

function runBootstrap(srcdoc: string) {
  const messages: { data: Record<string, unknown>; origin: string }[] = [];
  const scripts: Record<string, unknown>[] = [];
  let receive!: (event: { source: unknown; origin: string; data: unknown }) => void;
  const parent = { postMessage(data: Record<string, unknown>, origin: string) {
    messages.push({ data: structuredClone(data), origin });
  } };
  const window = {
    wordbookBaiduCallback: undefined as ((value: unknown) => void) | undefined,
    addEventListener(_type: string, handler: typeof receive) { receive = handler; },
    removeEventListener() {},
  };
  const document = {
    createElement(tag: string) { assert.equal(tag, 'script'); return {}; },
    body: { appendChild(script: Record<string, unknown>) {
      assert.equal(typeof window.wordbookBaiduCallback, 'function', 'fixed callback must exist before loading the script');
      scripts.push(script);
    } },
  };
  const code = /<script nonce="[a-f0-9]+">([\s\S]*)<\/script>/.exec(srcdoc)![1];
  runInNewContext(code, { parent, window, document }, { timeout: 1000 });
  const send = (data: unknown, source: unknown = parent, origin = 'https://wordbook.example') => receive({ source, origin, data });
  return { messages, scripts, window, send };
}

test('frame bootstrap accepts initialization once from its parent and posts only to that origin', async (context) => {
  const dom = mockDom(context);
  const controller = new AbortController();
  const pending = requestBaiduJsonp(url(), controller.signal);
  const child = runBootstrap(dom.frames[0].srcdoc);
  assert.deepEqual(child.messages, [{ data: { type: 'ready', token: dom.token() }, origin: '*' }]);
  const request = { type: 'request', token: dom.token(), url: url() };
  child.send(request, {});
  child.send({ ...request, token: 'wrong' });
  child.send({ ...request, type: 'wrong' });
  assert.equal(child.scripts.length, 0);
  child.send(request);
  child.send(request);
  assert.equal(child.scripts.length, 1);
  const script = child.scripts[0];
  assert.equal(script.src, url());
  assert.equal(script.referrerPolicy, 'no-referrer');
  assert.equal('crossOrigin' in script, false);
  child.window.wordbookBaiduCallback!(payload());
  child.window.wordbookBaiduCallback!({ error_code: 54003 });
  (script.onload as () => void)();
  (script.onerror as () => void)();
  assert.deepEqual(child.messages[1], {
    data: { type: 'result', token: dom.token(), ok: true, value: payload() }, origin: 'https://wordbook.example',
  });
  assert.equal(child.messages.length, 2);
  controller.abort();
  await assert.rejects(pending, (error) => error === controller.signal.reason);
});

test('frame bootstrap handles load/error/clone failures safely and supports opaque parents', async (context) => {
  const dom = mockDom(context);
  const controller = new AbortController();
  const pending = requestBaiduJsonp(url(), controller.signal);
  for (const [event, code] of [
    ['load', 'baiduInvalidResponse'], ['error', 'baiduUnavailable'], ['clone', 'baiduInvalidResponse'],
  ] as const) {
    const child = runBootstrap(dom.frames[0].srcdoc);
    child.send({ type: 'request', token: dom.token(), url: url() }, undefined, 'null');
    if (event === 'clone') child.window.wordbookBaiduCallback!({ raw: sensitive, cannotClone: () => undefined });
    else (child.scripts[0][event === 'load' ? 'onload' : 'onerror'] as () => void)();
    assert.deepEqual(child.messages[1], { data: { type: 'result', token: dom.token(), ok: false, code }, origin: '*' });
    assert.equal(child.messages.length, 2);
    assert.equal(JSON.stringify(child.messages).includes(sensitive), false);
  }
  controller.abort();
  await assert.rejects(pending, (error) => error === controller.signal.reason);
});
