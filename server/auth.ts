// Single-owner authentication: one password from the environment and a stateless signed cookie.
import type { Database } from './db.js';
import { ensureSchema } from './schema.js';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const MIN_SECRET_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 8;

export type AuthConfig = { password: string; sessionSecret: string };

const encoder = new TextEncoder();

export function validConfig(config: Partial<AuthConfig>): config is AuthConfig {
  return typeof config.password === 'string' && config.password.length >= MIN_PASSWORD_LENGTH
    && typeof config.sessionSecret === 'string' && config.sessionSecret.length >= MIN_SECRET_LENGTH;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

/** Derives the signing key from both secrets, so changing the password also ends existing sessions. */
function signingKey(config: AuthConfig): Promise<CryptoKey> {
  const cacheKey = config.sessionSecret + '\u0000' + config.password;
  let key = keys.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey(
        'raw', encoder.encode(config.sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const derived = await crypto.subtle.sign('HMAC', base, encoder.encode('wordbook-session-v1\u0000' + config.password));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })();
    keys.clear();
    keys.set(cacheKey, key);
  }
  return key;
}

/** Compares a candidate password in constant time by verifying it against the expected password's MAC. */
export async function passwordMatches(config: AuthConfig, candidate: unknown): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  const key = await signingKey(config);
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode('password\u0000' + config.password));
  return crypto.subtle.verify('HMAC', key, expected, encoder.encode('password\u0000' + candidate));
}

export async function createSessionToken(config: AuthConfig, now: Date): Promise<string> {
  const expires = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expires}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(config), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

export async function verifySessionToken(config: AuthConfig, token: string | undefined, now: Date): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return false;
  const signature = fromBase64url(match[2]);
  if (!signature) return false;
  const valid = await crypto.subtle.verify('HMAC', await signingKey(config), signature, encoder.encode(`v1.${match[1]}`));
  return valid && Number(match[1]) * 1000 > now.getTime();
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

// `__Host-` requires Secure, so plain-HTTP local development uses an unprefixed name.
export function cookieName(request: Request): string {
  return secureRequest(request) ? '__Host-wordbook_session' : 'wordbook_session';
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(request: Request, token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
    + (secureRequest(request) ? '; Secure' : '');
}

export function clearedSessionCookie(request: Request): string {
  return sessionCookie(request, '', 0);
}

export async function isAuthenticated(config: AuthConfig, request: Request, now: Date): Promise<boolean> {
  return verifySessionToken(config, readCookie(request, cookieName(request)), now);
}

// A global failure budget is enough for a single-owner app and needs no per-client state.
export async function loginThrottled(db: Database, now: Date): Promise<boolean> {
  await ensureSchema(db);
  const since = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS).toISOString();
  const { rows } = await db.query<{ failures: number }>(
    'SELECT count(*)::integer AS failures FROM login_failures WHERE failed_at > $1::timestamptz', [since],
  );
  return Number(rows[0]?.failures ?? 0) >= MAX_LOGIN_FAILURES;
}

export async function recordLoginFailure(db: Database, now: Date): Promise<void> {
  await ensureSchema(db);
  const cutoff = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS).toISOString();
  await db.transaction('write', async tx => {
    await tx.query('DELETE FROM login_failures WHERE failed_at <= $1::timestamptz', [cutoff]);
    await tx.query('INSERT INTO login_failures (failed_at) VALUES ($1::timestamptz)', [now.toISOString()]);
  });
}

export async function clearLoginFailures(db: Database): Promise<void> {
  await ensureSchema(db);
  await db.query('DELETE FROM login_failures');
}
