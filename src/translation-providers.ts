import type { Message } from './messages';

export type BaiduCredentials = { appid: string; key: string };

export const translationProviders = {
  mymemory: { label: 'MyMemory', source: 'MyMemory（机器翻译）' },
  baidu: { label: 'Baidu', source: 'Baidu（机器翻译）' },
} as const;

export type TranslationProvider = keyof typeof translationProviders;
export const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'mymemory';

export function isTranslationProvider(value: unknown): value is TranslationProvider {
  return typeof value === 'string' && Object.hasOwn(translationProviders, value);
}

export function hasMachineTranslationSource(source: string): boolean {
  return source.split(' | ').some((part) =>
    part === translationProviders.mymemory.source || part === translationProviders.baidu.source);
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
const browserStorage: StorageAccess = () => globalThis.localStorage;

export function readTranslationProvider(namespace: string, getStorage: StorageAccess = browserStorage): TranslationProvider {
  try {
    const value = getStorage()?.getItem(`${namespace}:translationProvider`);
    return isTranslationProvider(value) ? value : DEFAULT_TRANSLATION_PROVIDER;
  } catch {
    return DEFAULT_TRANSLATION_PROVIDER;
  }
}

export function writeTranslationProvider(
  namespace: string,
  provider: TranslationProvider,
  getStorage: StorageAccess = browserStorage,
): boolean {
  if (!isTranslationProvider(provider)) return false;
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(`${namespace}:translationProvider`, provider);
    return true;
  } catch {
    return false;
  }
}

export function isBaiduCredentials(value: unknown): value is BaiduCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, 'appid') || !Object.hasOwn(value, 'key')) return false;
  const { appid, key } = value as Record<string, unknown>;
  return typeof appid === 'string' && appid.length >= 1 && appid.length <= 64 && !/[^0-9]/.test(appid)
    && typeof key === 'string' && key.length >= 1 && key.length <= 256 && !/[\s\p{Cc}]/u.test(key);
}

export function readBaiduCredentials(
  namespace: string,
  getStorage: StorageAccess = browserStorage,
): { credentials: BaiduCredentials | null; error: Message | null } {
  let value: string | null;
  try {
    const storage = getStorage();
    if (!storage) return { credentials: null, error: { code: 'baiduSettingsReadFailed' } };
    value = storage.getItem(`${namespace}:baiduCredentials`);
  } catch {
    return { credentials: null, error: { code: 'baiduSettingsReadFailed' } };
  }
  if (value === null) return { credentials: null, error: null };
  try {
    const credentials: unknown = JSON.parse(value);
    if (isBaiduCredentials(credentials)) {
      return { credentials: { appid: credentials.appid, key: credentials.key }, error: null };
    }
  } catch {
    // Do not expose stored credentials through parser errors or modify a bad value.
  }
  return { credentials: null, error: { code: 'baiduSettingsInvalid' } };
}

export function writeBaiduCredentials(
  namespace: string,
  credentials: BaiduCredentials,
  getStorage: StorageAccess = browserStorage,
): boolean {
  try {
    if (!isBaiduCredentials(credentials)) return false;
    const value = JSON.stringify({ appid: credentials.appid, key: credentials.key });
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(`${namespace}:baiduCredentials`, value);
    return true;
  } catch {
    return false;
  }
}

export function clearBaiduCredentials(namespace: string, getStorage: StorageAccess = browserStorage): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.removeItem(`${namespace}:baiduCredentials`);
    return true;
  } catch {
    return false;
  }
}
