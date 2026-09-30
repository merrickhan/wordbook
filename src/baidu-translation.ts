import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { MessageError } from './messages';
import { isBaiduCredentials, type BaiduCredentials } from './translation-providers';

export type BaiduTransport = (url: string, signal?: AbortSignal) => Promise<unknown>;
export const BAIDU_CALLBACK = 'wordbookBaiduCallback';
const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
const DEADLINE_MS = 30000;
const failureCodes = [
  'baiduNotConfigured', 'baiduInvalidCredentials', 'baiduAuthFailed', 'baiduRateLimited',
  'baiduQuota', 'baiduIpBlocked', 'baiduUnavailable', 'baiduInvalidResponse', 'baiduTimedOut',
] as const;
type FailureCode = typeof failureCodes[number];

function failure(code: FailureCode): MessageError {
  return new MessageError({ code });
}

function safeFailure(error: unknown, fallback: FailureCode = 'baiduUnavailable'): MessageError {
  // Rebuild even known errors: an injected transport must not attach diagnostics or credentials.
  try {
    const code = error instanceof MessageError ? error.detail.code : undefined;
    if (failureCodes.includes(code as FailureCode)) return failure(code as FailureCode);
  } catch { /* Treat malformed error objects as an unknown failure. */ }
  return failure(fallback);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function randomHex(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export function buildBaiduUrl(word: string, credentials: BaiduCredentials, salt: string): string {
  try {
    if (!isBaiduCredentials(credentials)) throw failure('baiduInvalidCredentials');
    const sign = bytesToHex(md5(utf8ToBytes(credentials.appid + word + salt + credentials.key)));
    const params = new URLSearchParams({
      q: word, from: 'en', to: 'zh', appid: credentials.appid, salt, sign, callback: BAIDU_CALLBACK,
    });
    return BAIDU_ENDPOINT + '?' + params.toString();
  } catch (error) {
    throw safeFailure(error);
  }
}

export function parseBaiduTranslation(value: unknown, word: string): string {
  try {
    const response = record(value);
    if (!response) throw failure('baiduInvalidResponse');
    const code = response.error_code;
    if (code !== undefined) {
      if (typeof code !== 'string' && typeof code !== 'number') throw failure('baiduInvalidResponse');
      switch (String(code)) {
        case '200':
        case '52000': break;
        case '52003':
        case '54001':
        case '90107': throw failure('baiduAuthFailed');
        case '54003':
        case '54005': throw failure('baiduRateLimited');
        case '54004': throw failure('baiduQuota');
        case '58000':
        case '58003': throw failure('baiduIpBlocked');
        default: throw failure('baiduUnavailable');
      }
    }
    const query = word.trim().toLowerCase();
    if (!query || response.from !== 'en' || response.to !== 'zh' || !Array.isArray(response.trans_result))
      throw failure('baiduInvalidResponse');

    const translations = new Set<string>();
    for (const item of response.trans_result) {
      const result = record(item);
      if (!result || typeof result.src !== 'string' || typeof result.dst !== 'string')
        throw failure('baiduInvalidResponse');
      if (result.src.trim().toLowerCase() !== query) continue;
      const translation = result.dst.trim();
      if (translation.length <= 2000 && /\p{Script=Han}/u.test(translation)) translations.add(translation);
    }
    const translation = [...translations].join('；');
    if (!translation || translation.length > 2000) throw failure('baiduInvalidResponse');
    return translation;
  } catch (error) {
    throw safeFailure(error, 'baiduInvalidResponse');
  }
}

function callTransport(url: string, signal: AbortSignal | undefined, transport: BaiduTransport): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (ok: boolean, value: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      if (ok) resolve(value);
      else reject(value);
    };
    const cancel = () => finish(false, signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    try {
      Promise.resolve(transport(url, signal)).then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
  });
}

export async function translateBaidu(
  word: string,
  credentials: BaiduCredentials | null,
  signal?: AbortSignal,
  transport: BaiduTransport = requestBaiduJsonp,
): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  try {
    if (credentials == null) throw failure('baiduNotConfigured');
    if (!isBaiduCredentials(credentials)) throw failure('baiduInvalidCredentials');
    const url = buildBaiduUrl(word, credentials, randomHex());
    const value = await callTransport(url, signal, transport);
    if (signal?.aborted) throw signal.reason;
    const translation = parseBaiduTranslation(value, word);
    if (signal?.aborted) throw signal.reason;
    return translation;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw safeFailure(error);
  }
}

function validateJsonpUrl(value: string): void {
  const allowed = new Set(['q', 'from', 'to', 'appid', 'salt', 'sign', 'callback']);
  try {
    const url = new URL(value);
    if (!value.startsWith(BAIDU_ENDPOINT + '?') || url.origin + url.pathname !== BAIDU_ENDPOINT ||
      url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(value) ||
      [...url.searchParams.keys()].length !== allowed.size ||
      [...allowed].some((key) => url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get('callback') !== BAIDU_CALLBACK ||
      url.searchParams.get('from') !== 'en' || url.searchParams.get('to') !== 'zh' ||
      !url.searchParams.get('q') || !url.searchParams.get('appid') || !url.searchParams.get('salt') ||
      !/^[a-f0-9]{32}$/.test(url.searchParams.get('sign') || '')) throw failure('baiduInvalidResponse');
  } catch {
    throw failure('baiduInvalidResponse');
  }
}

function bootstrap(token: string, nonce: string): string {
  // Only locally generated hex enters srcdoc; the signed URL travels in the handshake.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://fanyi-api.baidu.com; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"></head><body><script nonce="${nonce}">
(() => {
  const token = '${token}';
  let initialized = false;
  let finished = false;
  let targetOrigin = '*';
  function finish(result) {
    if (finished) return;
    finished = true;
    try {
      parent.postMessage({ type: 'result', token, ...result }, targetOrigin);
    } catch {
      try {
        parent.postMessage({ type: 'result', token, ok: false, code: 'baiduInvalidResponse' }, targetOrigin);
      } catch {}
    }
  }
  function receive(event) {
    const data = event.data;
    if (initialized || event.source !== parent || !data || data.type !== 'request' || data.token !== token) return;
    initialized = true;
    window.removeEventListener('message', receive);
    targetOrigin = event.origin === 'null' ? '*' : event.origin;
    try {
      if (typeof data.url !== 'string') return finish({ ok: false, code: 'baiduInvalidResponse' });
      window.wordbookBaiduCallback = (value) => finish({ ok: true, value });
      const script = document.createElement('script');
      script.referrerPolicy = 'no-referrer';
      script.onerror = () => finish({ ok: false, code: 'baiduUnavailable' });
      script.onload = () => finish({ ok: false, code: 'baiduInvalidResponse' });
      script.src = data.url;
      document.body.appendChild(script);
    } catch {
      finish({ ok: false, code: 'baiduUnavailable' });
    }
  }
  window.addEventListener('message', receive);
  try { parent.postMessage({ type: 'ready', token }, '*'); } catch {}
})();
</script></body></html>`;
}

export async function requestBaiduJsonp(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    let owner: Window | undefined;
    let frame: HTMLIFrameElement | undefined;
    let child: Window | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token = '';
    let deadline = 0;
    let phase: 'ready' | 'result' = 'ready';
    let finished = false;

    const finish = (ok: boolean, value: unknown) => {
      if (finished) return;
      finished = true;
      // Removing the frame stops local observation, not necessarily the upstream request.
      for (const cleanup of [
        () => clearTimeout(timer),
        () => owner?.removeEventListener('message', receive),
        () => signal?.removeEventListener('abort', cancel),
        () => frame?.remove(),
      ]) {
        try { cleanup(); } catch { /* Continue the remaining cleanup even if the DOM became unavailable. */ }
      }
      if (ok) resolve(value);
      else reject(value);
    };
    const cancel = () => finish(false, signal?.reason);
    const expired = () => {
      if (signal?.aborted) { cancel(); return true; }
      if (Date.now() >= deadline) { finish(false, failure('baiduTimedOut')); return true; }
      return false;
    };
    const receive = (event: MessageEvent) => {
      if (finished || !child || event.source !== child || event.origin !== 'null') return;
      try {
        const data = record(event.data);
        if (!data || data.token !== token || expired()) return;
        if (phase === 'ready' && data.type === 'ready') {
          phase = 'result';
          child.postMessage({ type: 'request', token, url }, '*');
        } else if (phase === 'result' && data.type === 'result') {
          if (data.ok === true && Object.hasOwn(data, 'value')) finish(true, data.value);
          else finish(false, failure(data.ok === false && data.code === 'baiduUnavailable'
            ? 'baiduUnavailable' : 'baiduInvalidResponse'));
        }
      } catch (error) {
        finish(false, signal?.aborted ? signal.reason : safeFailure(error));
      }
    };

    try {
      deadline = Date.now() + DEADLINE_MS;
      validateJsonpUrl(url);
      token = randomHex();
      const nonce = randomHex();
      owner = window;
      signal?.addEventListener('abort', cancel, { once: true });
      if (expired()) return;
      timer = setTimeout(() => finish(false, signal?.aborted ? signal.reason : failure('baiduTimedOut')),
        Math.max(0, deadline - Date.now()));
      owner.addEventListener('message', receive);
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.title = 'Wordbook Baidu JSONP transport';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.srcdoc = bootstrap(token, nonce);
      document.body.appendChild(frame);
      child = frame.contentWindow;
      if (!child) throw failure('baiduUnavailable');
      expired();
    } catch (error) {
      finish(false, signal?.aborted ? signal.reason : safeFailure(error));
    }
  });
}
