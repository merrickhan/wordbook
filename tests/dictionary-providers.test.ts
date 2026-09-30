import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { serializeBackup } from '../src/backup';
import {
  dictionaryProviders, DEFAULT_DICTIONARY_PROVIDER, isDictionaryProvider,
  readDictionaryProvider, removeLegacyTranslationPreferences, writeDictionaryProvider,
} from '../src/dictionary-providers';
import { sample } from '../src/entry';
import type { DatedEntry } from '../src/entry';
import { createWordStore, databaseName } from '../src/storage';
import { readLocale, writeLocale } from '../src/i18n';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('only the two fixed provider IDs are supported', () => {
  assert.equal(DEFAULT_DICTIONARY_PROVIDER, 'free-dictionary');
  assert.deepEqual(Object.keys(dictionaryProviders), ['free-dictionary', 'english-dictionary']);
  for (const id of Object.keys(dictionaryProviders)) assert.equal(isDictionaryProvider(id), true);
  for (const value of [null, undefined, {}, [], 1, '', '__proto__', 'constructor', 'FreeDictionaryAPI.com', 'https://evil.example/', 'ENGLISH-DICTIONARY']) {
    assert.equal(isDictionaryProvider(value), false);
  }
  assert.deepEqual(Object.values(dictionaryProviders).map((item) => [item.name, item.homepage]), [
    ['FreeDictionaryAPI.com', 'https://freedictionaryapi.com/'],
    ['EnglishDictionaryAPI.com', 'https://englishdictionaryapi.com/'],
  ]);
});

test('compact UI labels retain full names for titles and source attribution', () => {
  assert.deepEqual(Object.values(dictionaryProviders).map((item) => [item.label, item.name]), [
    ['FreeDict', 'FreeDictionaryAPI.com'],
    ['EnglishDict', 'EnglishDictionaryAPI.com'],
  ]);
});

test('preferences default to current provider and restore only supported values', () => {
  const storage = memoryStorage();
  assert.equal(readDictionaryProvider('wordbook:/', () => storage), 'free-dictionary');
  for (const value of ['english-dictionary', 'free-dictionary', '', 'null', '__proto__', 'ENGLISH-DICTIONARY', 'https://evil.example/']) {
    storage.setItem('wordbook:/:dictionaryProvider', value);
    assert.equal(readDictionaryProvider('wordbook:/', () => storage), value === 'english-dictionary' ? value : 'free-dictionary');
  }
  for (const provider of ['english-dictionary', 'free-dictionary'] as const) {
    assert.equal(writeDictionaryProvider('wordbook:/', provider, () => storage), true);
    assert.equal(readDictionaryProvider('wordbook:/', () => storage), provider);
  }
});

test('provider preference is separated by deployment path and does not overwrite locale', () => {
  const storage = memoryStorage();
  const getStorage = () => storage;
  const root = databaseName('https://example.com/');
  const subpath = databaseName('https://example.com/wordbook/');
  writeLocale(root, 'en', getStorage);
  writeDictionaryProvider(root, 'english-dictionary', getStorage);
  assert.equal(readDictionaryProvider(subpath, getStorage), 'free-dictionary');
  assert.equal(readLocale(root, getStorage), 'en');
  writeLocale(root, 'zh-CN', getStorage);
  assert.equal(readDictionaryProvider(databaseName('https://example.com/index.html?q=1#top'), getStorage), 'english-dictionary');
  assert.deepEqual([...storage.data], [['wordbook:/:locale', 'zh-CN'], ['wordbook:/:dictionaryProvider', 'english-dictionary']]);
});

test('unavailable storage getters and failed reads or writes are safe', () => {
  for (const getStorage of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
    assert.equal(readDictionaryProvider('wordbook:/', getStorage), 'free-dictionary');
    assert.equal(writeDictionaryProvider('wordbook:/', 'english-dictionary', getStorage), false);
  }
  const storage = memoryStorage();
  storage.getItem = () => { throw new Error('Cannot read'); };
  storage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  assert.equal(readDictionaryProvider('wordbook:/', () => storage), 'free-dictionary');
  assert.equal(writeDictionaryProvider('wordbook:/', 'english-dictionary', () => storage), false);
});

test('legacy cleanup shares root and subpath namespaces across folder, query, fragment and index URLs', () => {
  for (const folder of ['/', '/projects/wordbook/']) {
    const namespace = databaseName(`https://example.com${folder}`);
    for (const page of ['', '?search=apple#word', 'index.html?version=3#top']) {
      const storage = memoryStorage();
      const getStorage = () => storage;
      writeLocale(namespace, 'en', getStorage);
      writeDictionaryProvider(namespace, 'english-dictionary', getStorage);
      const retained = new Map(storage.data);
      storage.setItem(`${namespace}:baiduCredentials`, '{"appId":"synthetic-id","secretKey":"synthetic-secret"}');
      storage.setItem(`${namespace}:translationProvider`, 'retired-provider');
      const pageNamespace = databaseName(`https://example.com${folder}${page}`);
      assert.equal(pageNamespace, namespace);
      assert.equal(removeLegacyTranslationPreferences(pageNamespace, getStorage), undefined);
      assert.deepEqual(storage.data, retained);
      assert.equal(readLocale(namespace, getStorage), 'en');
      assert.equal(readDictionaryProvider(namespace, getStorage), 'english-dictionary');
    }
  }
});

test('legacy cleanup retains other namespaces, unnamespaced lookalikes and unrelated prefix or suffix keys', () => {
  const storage = memoryStorage();
  const namespace = databaseName('https://example.com/wordbook/');
  const otherNamespace = databaseName('https://example.com/other/');
  writeLocale(namespace, 'zh-CN', () => storage);
  writeDictionaryProvider(namespace, 'english-dictionary', () => storage);
  storage.setItem(`${namespace}:unrelated`, '保留的其他设置');
  for (const suffix of ['baiduCredentials', 'translationProvider']) {
    for (const key of [
      `${otherNamespace}:${suffix}`, suffix, `prefix-${namespace}:${suffix}`,
      `${namespace}:archived-${suffix}`, `${namespace}:${suffix}:backup`,
    ]) storage.setItem(key, `preserve ${key}`);
  }
  const retained = new Map(storage.data);
  storage.setItem(`${namespace}:baiduCredentials`, 'legacy credentials');
  storage.setItem(`${namespace}:translationProvider`, 'legacy provider');
  removeLegacyTranslationPreferences(namespace, () => storage);
  assert.deepEqual(storage.data, retained);
});

test('legacy cleanup uses only removeItem, without reading malformed values or accessing ambient APIs', t => {
  const storage = memoryStorage();
  const namespace = databaseName('https://example.com/wordbook/');
  const keys = [`${namespace}:baiduCredentials`, `${namespace}:translationProvider`];
  storage.setItem(keys[0], '{malformed credentials');
  storage.setItem(keys[1], 'not-json-or-a-provider');
  const events: string[] = [];
  let forbiddenAttempts = 0;
  const forbidden = (): never => {
    forbiddenAttempts++;
    throw new Error('Unexpected access outside removeItem');
  };
  const removeOnly: Pick<Storage, 'removeItem'> = new Proxy({
    removeItem(key: string) { events.push(key); storage.removeItem(key); },
  }, {
    get: (target, key) => key === 'removeItem' ? target.removeItem : forbidden(),
    has: forbidden,
    ownKeys: forbidden,
    getOwnPropertyDescriptor: forbidden,
    getPrototypeOf: forbidden,
    set: forbidden,
    defineProperty: forbidden,
    deleteProperty: forbidden,
  });
  const ambientKeys = ['localStorage', 'sessionStorage', 'indexedDB'] as const;
  const descriptors = ambientKeys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    for (const key of ambientKeys) Object.defineProperty(globalThis, key, { configurable: true, get: forbidden });
    t.mock.method(JSON, 'parse', forbidden);
    for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) t.mock.method(console, method, forbidden);
    const getStorage = () => { events.push('getStorage'); return removeOnly; };
    assert.deepEqual(events, []);
    assert.equal(removeLegacyTranslationPreferences(namespace, getStorage), undefined);
  } finally {
    ambientKeys.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    t.mock.restoreAll();
  }
  // Assert after cleanup returns so its catch blocks cannot swallow a forbidden-access failure.
  assert.equal(forbiddenAttempts, 0);
  assert.deepEqual(events, ['getStorage', ...keys]);
  assert.equal(storage.data.size, 0);
});

test('legacy cleanup safely calls unavailable or throwing storage getters once', () => {
  const namespace = databaseName('https://example.com/wordbook/');
  for (const getStorage of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
    let attempts = 0;
    assert.equal(removeLegacyTranslationPreferences(namespace, () => {
      attempts++;
      return getStorage();
    }), undefined);
    assert.equal(attempts, 1);
  }
});

test('legacy cleanup attempts both exact removals independently when the first, second or both throw', () => {
  const namespace = databaseName('https://example.com/wordbook/');
  const keys = [`${namespace}:baiduCredentials`, `${namespace}:translationProvider`];
  for (const failingKeys of [[keys[0]], [keys[1]], keys]) {
    const storage = memoryStorage();
    for (const key of keys) storage.setItem(key, 'legacy value');
    const attempts: string[] = [];
    let getterCalls = 0;
    assert.equal(removeLegacyTranslationPreferences(namespace, () => {
      getterCalls++;
      return {
        removeItem(key: string) {
          attempts.push(key);
          if (failingKeys.includes(key)) throw new DOMException('Denied', 'SecurityError');
          storage.removeItem(key);
        },
      };
    }), undefined);
    assert.equal(getterCalls, 1);
    assert.deepEqual(attempts, keys);
    assert.deepEqual(storage.data, new Map(failingKeys.map(key => [key, 'legacy value'])));
  }
});

test('legacy cleanup is repeatable with absent, singly present and reintroduced keys without writing a marker', () => {
  const storage = memoryStorage();
  const namespace = databaseName('https://example.com/wordbook/');
  const keys = [`${namespace}:baiduCredentials`, `${namespace}:translationProvider`];
  writeLocale(namespace, 'zh-CN', () => storage);
  writeDictionaryProvider(namespace, 'english-dictionary', () => storage);
  const retained = new Map(storage.data);
  for (const present of [[], [keys[0]], [keys[1]], keys, []]) {
    for (const key of present) storage.setItem(key, 'reintroduced legacy value');
    const attempts: string[] = [];
    assert.equal(removeLegacyTranslationPreferences(namespace, () => ({
      removeItem(key: string) { attempts.push(key); storage.removeItem(key); },
    })), undefined);
    assert.deepEqual(attempts, keys);
    assert.deepEqual(storage.data, retained);
  }
});

test('legacy cleanup preserves persisted IDs, descending order, all entry fields and identical fixed-time backups', async t => {
  const namespace = databaseName('https://example.com/wordbook/index.html?version=3#top');
  const exportedAt = '2026-09-28T08:00:00.000Z';
  const factory = new IDBFactory();
  const store = createWordStore({ name: namespace, indexedDB: factory, now: () => new Date(exportedAt) });
  t.after(() => store.close());
  const values: DatedEntry[] = [
    { ...sample, source: 'Historical source: 旧服务翻译记录 | 用户保留的调查笔记', created: '2024-02-29T12:34:56.789Z' },
    {
      word: 'tomato',
      phonetic: 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/',
      translation: '番茄',
      pos: 'Noun',
      definition: 'A red fruit used in cooking.',
      example: 'Slice the tomato for the salad.',
      source: 'FreeDictionaryAPI.com | 词典摘录，可经编辑 | 任意用户备注',
      created: '2020-01-01T00:00:00.000Z',
    },
  ];
  // Start above ID 1 so rebuilding the notebook with fresh IDs cannot pass unnoticed.
  const seed = await store.save({ ...sample, word: 'temporary' });
  await store.remove(seed.id);
  assert.deepEqual(await store.importEntries(values), { imported: 2, skipped: 0 });
  const before = await store.list();
  assert.deepEqual(before, values.map((value, index) => ({ ...value, id: index + 2 })).reverse());
  const backup = serializeBackup(before, exportedAt);
  assert.deepEqual(JSON.parse(backup), { format: 'wordbook', version: 1, exportedAt, entries: values });
  await store.close();

  const storage = memoryStorage();
  storage.setItem(`${namespace}:baiduCredentials`, '{malformed credentials');
  storage.setItem(`${namespace}:translationProvider`, 'retired-provider');
  removeLegacyTranslationPreferences(namespace, () => storage);
  assert.equal(storage.data.size, 0);
  const after = await store.list();
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(value => value.id), [3, 2]);
  assert.equal(serializeBackup(after, exportedAt), backup);
  assert.deepEqual(await factory.databases(), [{ name: namespace, version: 1 }]);
});
