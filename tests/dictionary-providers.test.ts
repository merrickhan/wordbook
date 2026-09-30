import assert from 'node:assert/strict';
import test from 'node:test';
import { dictionaryProviders, DEFAULT_DICTIONARY_PROVIDER, isDictionaryProvider, readDictionaryProvider, writeDictionaryProvider } from '../src/dictionary-providers';
import { databaseName } from '../src/storage';
import { readLocale, writeLocale } from '../src/i18n';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
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
