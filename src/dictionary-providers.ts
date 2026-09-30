export const dictionaryProviders = {
  'free-dictionary': { label: 'FreeDict', name: 'FreeDictionaryAPI.com', homepage: 'https://freedictionaryapi.com/' },
  'english-dictionary': { label: 'EnglishDict', name: 'EnglishDictionaryAPI.com', homepage: 'https://englishdictionaryapi.com/' },
} as const;

export type DictionaryProvider = keyof typeof dictionaryProviders;
export const DEFAULT_DICTIONARY_PROVIDER: DictionaryProvider = 'free-dictionary';

export function isDictionaryProvider(value: unknown): value is DictionaryProvider {
  return typeof value === 'string' && Object.hasOwn(dictionaryProviders, value);
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'> | undefined;
const browserStorage: StorageAccess = () => globalThis.localStorage;

export function readDictionaryProvider(namespace: string, getStorage: StorageAccess = browserStorage): DictionaryProvider {
  try {
    const value = getStorage()?.getItem(`${namespace}:dictionaryProvider`);
    return isDictionaryProvider(value) ? value : DEFAULT_DICTIONARY_PROVIDER;
  } catch {
    return DEFAULT_DICTIONARY_PROVIDER;
  }
}

export function writeDictionaryProvider(
  namespace: string,
  provider: DictionaryProvider,
  getStorage: StorageAccess = browserStorage,
): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(`${namespace}:dictionaryProvider`, provider);
    return true;
  } catch {
    // An unavailable preference store must not interrupt the current page.
    return false;
  }
}
