import assert from 'node:assert/strict';
import test from 'node:test';
import {
  translationProviders, DEFAULT_TRANSLATION_PROVIDER, isTranslationProvider, hasMachineTranslationSource,
  readTranslationProvider, writeTranslationProvider, isBaiduCredentials,
  readBaiduCredentials, writeBaiduCredentials, clearBaiduCredentials,
  type BaiduCredentials, type TranslationProvider,
} from '../src/translation-providers';
import { readDictionaryProvider, writeDictionaryProvider } from '../src/dictionary-providers';
import { readLocale, writeLocale } from '../src/i18n';
import { databaseName } from '../src/storage';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

// These are synthetic fixtures, not service credentials.
const credentials: BaiduCredentials = {
  appid: '000123456789012345678901234567890',
  key: 'Synthetic-Key_Aa9+/=!"\\漢字',
};
const otherCredentials: BaiduCredentials = { appid: '98765432109876543210', key: 'Other-Test-Key_Bb2!' };
const namespace = 'wordbook:/';
const providerKey = `${namespace}:translationProvider`;
const credentialsKey = `${namespace}:baiduCredentials`;
const invalidCredentials: unknown[] = [
  null, undefined, true, 1, '', '123', [], {}, new Date(0),
  { appid: credentials.appid }, { key: credentials.key },
  Object.assign([], credentials), Object.create(credentials),
  ...[undefined, null, true, 123, 123n, new String('123'), '', '1'.repeat(65),
    ' 123', '123 ', '1 23', '123\n', '123\r', '\t123', '1' + String.fromCharCode(0) + '23', '1.2', '+123', '-123', '1e3', '１２３', '١٢٣']
    .map((appid) => ({ appid, key: credentials.key })),
  ...[undefined, null, true, 123, {}, [], new String('key'), '', 'k'.repeat(257)]
    .map((key) => ({ appid: credentials.appid, key })),
];
const forbiddenKeyCharacters = [
  ...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)),
  ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(0x7f + index)),
  ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
  ...[0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].map((code) => String.fromCharCode(code)),
];

test('only the two fixed translation provider IDs and their exact labels are supported', () => {
  assert.equal(DEFAULT_TRANSLATION_PROVIDER, 'mymemory');
  assert.deepEqual(translationProviders, {
    mymemory: { label: 'MyMemory', source: 'MyMemory（机器翻译）' },
    baidu: { label: 'Baidu', source: 'Baidu（机器翻译）' },
  });
  for (const id of Object.keys(translationProviders)) assert.equal(isTranslationProvider(id), true);
  for (const value of [null, undefined, {}, [], 1, true, Symbol('baidu'), new String('baidu'), '',
    ...Object.getOwnPropertyNames(Object.prototype), 'BAIDU', 'Baidu', 'MyMemory', ' baidu', 'baidu ',
    'free-dictionary', 'https://evil.example/']) {
    assert.equal(isTranslationProvider(value), false);
  }
});

test('machine translation attribution matches complete source tags separated by exactly space-pipe-space', () => {
  for (const source of ['MyMemory（机器翻译）', 'Baidu（机器翻译）']) {
    for (const attribution of [source, `EnglishDictionaryAPI.com | ${source}`, `${source} | dictionary`,
      `dictionary | ${source} | other`, `${source} | ${source}`]) {
      assert.equal(hasMachineTranslationSource(attribution), true);
    }
    for (const attribution of [`prefix${source}`, `${source}suffix`, `(${source})`, ` ${source}`, `${source} `,
      `dictionary|${source}`, `${source}|dictionary`, `dictionary |${source}`, `${source}| dictionary`,
      `dictionary |  ${source}`, `${source}  | dictionary`, `dictionary\n${source}`, `${source}\n`,
      `dictionary / ${source}`, `dictionary｜${source}`, `dictionary | [${source}] | other`]) {
      assert.equal(hasMachineTranslationSource(attribution), false);
    }
  }
  assert.equal(hasMachineTranslationSource('MyMemory（机器翻译） | Baidu（机器翻译）'), true);
  for (const source of ['', 'Baidu', 'MyMemory', 'baidu（机器翻译）', 'MyMemory(机器翻译)',
    'Baidu（机器翻译', 'free-dictionary', '__proto__', 'constructor']) {
    assert.equal(hasMachineTranslationSource(source), false);
  }
});

test('provider reads default without writing and restore only supported stored IDs', () => {
  const storage = memoryStorage();
  assert.equal(readTranslationProvider(namespace, () => storage), 'mymemory');
  assert.equal(storage.data.size, 0);
  for (const value of ['baidu', 'mymemory', '', 'null', '"baidu"', '__proto__', 'constructor', 'toString',
    'Baidu', 'BAIDU', ' baidu', 'baidu ', 'https://evil.example/']) {
    storage.setItem(providerKey, value);
    assert.equal(readTranslationProvider(namespace, () => storage), value === 'baidu' ? 'baidu' : 'mymemory');
    assert.deepEqual([...storage.data], [[providerKey, value]]);
  }
});

test('each provider preference write uses only its namespaced key and round-trips', () => {
  const storage = memoryStorage();
  const calls: [string, string][] = [];
  storage.setItem = (key, value) => { calls.push([key, value]); storage.data.set(key, value); };
  for (const provider of ['baidu', 'mymemory'] as const) {
    assert.equal(writeTranslationProvider(namespace, provider, () => storage), true);
    assert.equal(readTranslationProvider(namespace, () => storage), provider);
  }
  assert.deepEqual(calls, [[providerKey, 'baidu'], [providerKey, 'mymemory']]);
  assert.deepEqual([...storage.data], [[providerKey, 'mymemory']]);
});

test('invalid provider writes fail before accessing storage', () => {
  let accesses = 0;
  const getStorage = () => { accesses++; return memoryStorage(); };
  for (const value of [null, undefined, {}, [], 1, '', ...Object.getOwnPropertyNames(Object.prototype), 'BAIDU', 'baidu ']) {
    assert.equal(writeTranslationProvider(namespace, value as TranslationProvider, getStorage), false);
  }
  assert.equal(accesses, 0);
});

test('provider and credentials remain isolated by deployment directory without changing locale or dictionary', () => {
  const storage = memoryStorage();
  const getStorage = () => storage;
  const root = databaseName('https://example.com/');
  const subpath = databaseName('https://example.com/wordbook/');
  assert.equal(writeLocale(root, 'en', getStorage), true);
  assert.equal(writeLocale(subpath, 'zh-CN', getStorage), true);
  assert.equal(writeDictionaryProvider(root, 'english-dictionary', getStorage), true);
  assert.equal(writeDictionaryProvider(subpath, 'free-dictionary', getStorage), true);
  assert.equal(writeTranslationProvider(root, 'baidu', getStorage), true);
  assert.equal(writeBaiduCredentials(root, credentials, getStorage), true);
  assert.equal(readTranslationProvider(subpath, getStorage), 'mymemory');
  assert.deepEqual(readBaiduCredentials(subpath, getStorage), { credentials: null, error: null });
  assert.equal(writeTranslationProvider(subpath, 'mymemory', getStorage), true);
  assert.equal(writeBaiduCredentials(subpath, otherCredentials, getStorage), true);
  const rootAlias = databaseName('https://example.com/index.html?q=1#top');
  const subpathAlias = databaseName('https://example.com/wordbook/index.html?q=1#top');
  assert.equal(readTranslationProvider(rootAlias, getStorage), 'baidu');
  assert.deepEqual(readBaiduCredentials(rootAlias, getStorage), { credentials, error: null });
  assert.equal(readTranslationProvider(subpathAlias, getStorage), 'mymemory');
  assert.deepEqual(readBaiduCredentials(subpathAlias, getStorage), { credentials: otherCredentials, error: null });
  assert.equal(readLocale(root, getStorage), 'en');
  assert.equal(readLocale(subpath, getStorage), 'zh-CN');
  assert.equal(readDictionaryProvider(root, getStorage), 'english-dictionary');
  assert.equal(readDictionaryProvider(subpath, getStorage), 'free-dictionary');
  assert.deepEqual([...storage.data], [
    ['wordbook:/:locale', 'en'], ['wordbook:/wordbook/:locale', 'zh-CN'],
    ['wordbook:/:dictionaryProvider', 'english-dictionary'], ['wordbook:/wordbook/:dictionaryProvider', 'free-dictionary'],
    ['wordbook:/:translationProvider', 'baidu'], ['wordbook:/:baiduCredentials', JSON.stringify(credentials)],
    ['wordbook:/wordbook/:translationProvider', 'mymemory'], ['wordbook:/wordbook/:baiduCredentials', JSON.stringify(otherCredentials)],
  ]);
});

test('credential validation accepts string IDs and keys at both length limits without normalizing them', () => {
  for (const appid of ['0', '1', '0'.repeat(64), '9'.repeat(64), credentials.appid]) {
    for (const key of ['a', 'K'.repeat(256), credentials.key]) {
      const value = Object.freeze({ appid, key });
      assert.equal(isBaiduCredentials(value), true);
      assert.deepEqual(value, { appid, key });
    }
  }
  assert.equal(isBaiduCredentials(Object.assign(Object.create(null), credentials)), true);
});

test('credential validation rejects malformed shapes, non-string fields, and out-of-range values', () => {
  for (const value of invalidCredentials) assert.equal(isBaiduCredentials(value), false);
});

test('credential validation rejects every whitespace or control character anywhere in a key', () => {
  for (const character of forbiddenKeyCharacters) {
    for (const key of [character, `${character}key`, `ke${character}y`, `key${character}`]) {
      assert.equal(isBaiduCredentials({ appid: credentials.appid, key }), false);
    }
  }
});

test('invalid credentials never access storage or replace a saved pair', () => {
  const storage = memoryStorage();
  storage.setItem(credentialsKey, JSON.stringify(credentials));
  let accesses = 0;
  const getStorage = () => { accesses++; return storage; };
  for (const value of [...invalidCredentials, ...forbiddenKeyCharacters.map((character) => ({
    appid: credentials.appid, key: `key${character}`,
  }))]) {
    assert.equal(writeBaiduCredentials(namespace, value as BaiduCredentials, getStorage), false);
  }
  assert.equal(accesses, 0);
  assert.deepEqual([...storage.data], [[credentialsKey, JSON.stringify(credentials)]]);
});

test('missing credentials are a normal unconfigured state and reads never write or remove keys', () => {
  const storage = memoryStorage();
  const reads: string[] = [];
  storage.getItem = (key) => { reads.push(key); return null; };
  storage.setItem = () => { assert.fail('Read must not write'); };
  storage.removeItem = () => { assert.fail('Read must not remove'); };
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials: null, error: null });
  assert.deepEqual(reads, [credentialsKey]);
  assert.equal(storage.data.size, 0);
});

test('credential writes persist the exact pair together in a single setItem and discard unknown properties', () => {
  const storage = memoryStorage();
  const calls: [string, string][] = [];
  let serializations = 0;
  const input = Object.freeze({
    ...credentials, extra: 'not persisted', nested: { ignored: true },
    toJSON: () => { serializations++; throw new Error('Must not serialize the input object'); },
  });
  let accesses = 0;
  storage.setItem = (key, value) => { calls.push([key, value]); storage.data.set(key, value); };
  assert.equal(writeBaiduCredentials(namespace, input, () => { accesses++; return storage; }), true);
  assert.equal(accesses, 1);
  assert.equal(serializations, 0);
  assert.deepEqual(calls, [[credentialsKey, JSON.stringify(credentials)]]);
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials, error: null });
  assert.deepEqual([...storage.data], [[credentialsKey, JSON.stringify(credentials)]]);
  assert.equal(input.appid, credentials.appid);
  assert.equal(input.key, credentials.key);
  assert.equal(input.extra, 'not persisted');
});

test('updating credentials replaces both fields at once and preserves full-length IDs and keys', () => {
  const storage = memoryStorage();
  storage.setItem(credentialsKey, JSON.stringify(credentials));
  const updated = { appid: '0'.repeat(32) + '9'.repeat(32), key: 'Aa!_'.repeat(64) };
  const writes: [string, string][] = [];
  storage.setItem = (key, value) => { writes.push([key, value]); storage.data.set(key, value); };
  assert.equal(writeBaiduCredentials(namespace, updated, () => storage), true);
  assert.deepEqual(writes, [[credentialsKey, JSON.stringify(updated)]]);
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials: updated, error: null });
});

test('reading credentials returns only the validated fields without rewriting unknown stored properties', () => {
  const storage = memoryStorage();
  const raw = JSON.stringify({ ...credentials, extra: 'keep original storage untouched', nested: { ignored: true } });
  storage.setItem(credentialsKey, raw);
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials, error: null });
  assert.equal(storage.getItem(credentialsKey), raw);
});

test('malformed JSON and invalid stored fields report only a message code and leave bad values untouched', () => {
  const storage = memoryStorage();
  let writes = 0;
  let removals = 0;
  storage.setItem = () => { writes++; };
  storage.removeItem = () => { removals++; };
  const rawValues = ['', ' ', '{', 'undefined', `{ "appid": "${credentials.appid}", "key": "synthetic-unclosed-key`,
    'null', 'true', '123', '[]', '"123"', '{}',
    // Boxed strings become valid strings in JSON; BigInt cannot be serialized.
    ...invalidCredentials.filter((value) => value && typeof value === 'object'
      && !Object.values(value).some((field) => field instanceof String || typeof field === 'bigint'))
      .map((value) => JSON.stringify(value)),
    ...forbiddenKeyCharacters.map((character) => JSON.stringify({ appid: credentials.appid, key: `key${character}` })),
  ];
  for (const raw of rawValues) {
    storage.data.set(credentialsKey, raw);
    assert.deepEqual(readBaiduCredentials(namespace, () => storage), {
      credentials: null, error: { code: 'baiduSettingsInvalid' },
    });
    assert.deepEqual([...storage.data], [[credentialsKey, raw]]);
  }
  assert.equal(writes, 0);
  assert.equal(removals, 0);
});

test('unavailable storage and denied storage getters fail safely for every settings operation', () => {
  for (const getStorage of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
    assert.equal(readTranslationProvider(namespace, getStorage), 'mymemory');
    assert.equal(writeTranslationProvider(namespace, 'baidu', getStorage), false);
    assert.deepEqual(readBaiduCredentials(namespace, getStorage), {
      credentials: null, error: { code: 'baiduSettingsReadFailed' },
    });
    assert.equal(writeBaiduCredentials(namespace, credentials, getStorage), false);
    assert.equal(clearBaiduCredentials(namespace, getStorage), false);
  }
});

test('storage read errors stay distinct from invalid data and do not expose exceptions or their causes', () => {
  const storage = memoryStorage();
  storage.setItem(providerKey, 'baidu');
  storage.setItem(credentialsKey, JSON.stringify(credentials));
  const before = [...storage.data];
  storage.getItem = () => {
    throw new Error(`Synthetic failure ${credentials.appid} ${credentials.key}`, { cause: credentials });
  };
  assert.equal(readTranslationProvider(namespace, () => storage), 'mymemory');
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), {
    credentials: null, error: { code: 'baiduSettingsReadFailed' },
  });
  assert.deepEqual([...storage.data], before);
});

test('failed writes leave the previous provider, credential pair, and unrelated keys unchanged', () => {
  for (const error of [new DOMException('Full', 'QuotaExceededError'), new DOMException('Denied', 'SecurityError'), new Error('Cannot write')]) {
    const storage = memoryStorage();
    storage.setItem(providerKey, 'baidu');
    storage.setItem(credentialsKey, JSON.stringify(credentials));
    storage.setItem(`${namespace}:locale`, 'en');
    storage.setItem(`${namespace}:dictionaryProvider`, 'english-dictionary');
    const before = [...storage.data];
    let attempts = 0;
    storage.setItem = () => { attempts++; throw error; };
    assert.equal(writeTranslationProvider(namespace, 'mymemory', () => storage), false);
    assert.equal(writeBaiduCredentials(namespace, otherCredentials, () => storage), false);
    assert.equal(attempts, 2);
    assert.deepEqual([...storage.data], before);
    assert.equal(readTranslationProvider(namespace, () => storage), 'baidu');
    assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials, error: null });
  }
});

test('clearing credentials removes only the exact namespaced credential key and is safe to repeat', () => {
  const storage = memoryStorage();
  storage.setItem(credentialsKey, JSON.stringify(credentials));
  storage.setItem(providerKey, 'baidu');
  storage.setItem(`${namespace}:locale`, 'en');
  storage.setItem(`${namespace}:dictionaryProvider`, 'english-dictionary');
  storage.setItem('wordbook:/wordbook/:baiduCredentials', JSON.stringify(otherCredentials));
  storage.setItem(`${credentialsKey}:other`, 'unrelated');
  const expected = [...storage.data].filter(([key]) => key !== credentialsKey);
  const removed: string[] = [];
  storage.removeItem = (key) => { removed.push(key); storage.data.delete(key); };
  const withClear = { ...storage, clear: () => { assert.fail('Must not clear all storage'); } };
  assert.equal(clearBaiduCredentials(namespace, () => withClear), true);
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials: null, error: null });
  assert.deepEqual([...storage.data], expected);
  assert.equal(clearBaiduCredentials(namespace, () => withClear), true);
  assert.deepEqual(removed, [credentialsKey, credentialsKey]);
  assert.deepEqual([...storage.data], expected);
});

test('failed clears preserve credentials and all other stored preferences', () => {
  const storage = memoryStorage();
  storage.setItem(credentialsKey, JSON.stringify(credentials));
  storage.setItem(providerKey, 'baidu');
  storage.setItem(`${namespace}:locale`, 'en');
  storage.setItem(`${namespace}:dictionaryProvider`, 'english-dictionary');
  storage.setItem('wordbook:/wordbook/:baiduCredentials', JSON.stringify(otherCredentials));
  const before = [...storage.data];
  const removed: string[] = [];
  storage.removeItem = (key) => { removed.push(key); throw new DOMException('Denied', 'SecurityError'); };
  assert.equal(clearBaiduCredentials(namespace, () => storage), false);
  assert.deepEqual(removed, [credentialsKey]);
  assert.deepEqual([...storage.data], before);
  assert.deepEqual(readBaiduCredentials(namespace, () => storage), { credentials, error: null });
});

test('default storage getters use only the mocked browser storage and handle missing or denied access', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = memoryStorage();
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
    assert.equal(readTranslationProvider(namespace), 'mymemory');
    assert.deepEqual(readBaiduCredentials(namespace), { credentials: null, error: null });
    assert.equal(writeTranslationProvider(namespace, 'baidu'), true);
    assert.equal(writeBaiduCredentials(namespace, credentials), true);
    assert.equal(readTranslationProvider(namespace), 'baidu');
    assert.deepEqual(readBaiduCredentials(namespace), { credentials, error: null });
    assert.equal(clearBaiduCredentials(namespace), true);
    assert.deepEqual([...storage.data], [[providerKey, 'baidu']]);
    for (const get of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
      assert.equal(readTranslationProvider(namespace), 'mymemory');
      assert.equal(writeTranslationProvider(namespace, 'baidu'), false);
      assert.deepEqual(readBaiduCredentials(namespace), { credentials: null, error: { code: 'baiduSettingsReadFailed' } });
      assert.equal(writeBaiduCredentials(namespace, credentials), false);
      assert.equal(clearBaiduCredentials(namespace), false);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
