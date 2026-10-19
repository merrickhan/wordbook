import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange, IDBVersionChangeEvent, forceCloseDatabase } from 'fake-indexeddb';
import { createEntry, sample } from '../src/entry';
import type { DatedEntry } from '../src/entry';
import type { ImportBatch } from '../src/categories';
import { MessageError } from '../src/messages';
import { createWordStore, databaseName } from '../src/storage';

const created = '2026-09-28T08:00:00.000Z';
const earlier = '2024-02-29T12:34:56.789Z';
const dated = (word: string): DatedEntry => ({ ...createEntry(word), created: earlier });
const batch = (entries: readonly DatedEntry[]): ImportBatch => ({
  categories: [], entries: entries.map(entry => ({ ...entry, categories: [] })),
});

function observeConnections(factory: IDBFactory, observe: (db: IDBDatabase) => void) {
  const open = factory.open.bind(factory);
  factory.open = (name, version) => {
    const request = open(name, version);
    request.addEventListener('success', () => observe(request.result));
    return request;
  };
}

function interceptWrites(db: IDBDatabase, intercept: (words: IDBObjectStore, transaction: IDBTransaction) => void) {
  const transact = db.transaction.bind(db);
  db.transaction = (...args: Parameters<IDBDatabase['transaction']>) => {
    const transaction = transact(...args);
    if (transaction.mode === 'readwrite') intercept(transaction.objectStore('words'), transaction);
    return transaction;
  };
}

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Unexpected blocked database'));
  });
}

test('database names use stable deployment directories, ignoring page names, fragments and queries without mixing projects', () => {
  for (const url of [
    'https://example.com/wordbook/',
    'https://example.com/wordbook/#/words',
    'https://example.com/wordbook/#/add',
    'https://example.com/wordbook/?search=apple#word',
    'https://example.com/wordbook/?search=apple#/words',
    'https://example.com/wordbook/?search=apple#/add',
    'https://example.com/wordbook/index.html?version=3#word',
    'https://example.com/wordbook/index.html?version=3#/words',
    'https://example.com/wordbook/index.html?version=3#/add',
    'https://example.com/other/../wordbook/index.html',
  ]) assert.equal(databaseName(url), 'wordbook:/wordbook/');
  for (const url of [
    'https://example.com/',
    'https://example.com/#/words',
    'https://example.com/#/add',
    'https://example.com/?search=apple#/words',
    'https://example.com/?search=apple#/add',
    'https://example.com/index.html?x=1#top',
    'https://example.com/index.html?x=1#/words',
    'https://example.com/index.html?x=1#/add',
  ]) assert.equal(databaseName(url), 'wordbook:/');
  assert.notEqual(databaseName('https://example.com/a/'), databaseName('https://example.com/b/'));
});

test('creating a store does not access IndexedDB, and unsupported reads fail with a helpful message', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  const store = createWordStore({ name: 'unsupported' });
  await assert.rejects(store.list(), /不支持.*IndexedDB/);
  await assert.rejects(store.list(), /不支持.*IndexedDB/);
  await store.close();
});

test('saving uses seven fields and an injected time, lists in reverse order and preserves original duplicate content', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'save', indexedDB: factory, now: () => new Date(created) });
  t.after(() => store.close());
  assert.deepEqual(await store.list(), []);
  const first = await store.save({ ...sample, word: ' APPLE ', categoryIds: [], id: 700, created: 'bad date', extra: 'ignored' });
  assert.deepEqual(first, { ...sample, word: 'apple', categoryIds: [], id: 1, created });
  const second = await store.save(createEntry('Banana'));
  assert.equal(second.id, 2);
  await assert.rejects(store.save({ ...sample, word: ' Apple ', translation: '不能覆盖' }), /apple.*原词条已保留/);
  assert.deepEqual(await store.list(), [second, first]);
  await store.close();
  assert.deepEqual(await store.list(), [second, first]);
  const reopened = createWordStore({ name: 'save', indexedDB: factory });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.list(), [second, first]);
  const other = createWordStore({ name: 'other-project', indexedDB: factory });
  t.after(() => other.close());
  assert.deepEqual(await other.list(), []);
});

test('deletion by ID survives reopening and is visible to peers without affecting other content, order or deployments', async t => {
  const factory = new IDBFactory();
  const name = databaseName('https://example.test/remove/');
  const store = createWordStore({ name, indexedDB: factory, now: () => new Date(created) });
  const peer = createWordStore({ name, indexedDB: factory });
  const other = createWordStore({ name: databaseName('https://example.test/other/'), indexedDB: factory });
  t.after(() => Promise.all([store.close(), peer.close(), other.close()]));
  const first = await store.save({ ...createEntry('first'), translation: '合成首项', source: 'Synthetic first fixture' });
  const removed = await store.save(createEntry('removed'));
  const last = await store.save({
    ...createEntry('last'),
    phonetic: 'US /læst/ · UK /lɑːst/',
    pos: 'Adjective',
    definition: 'A synthetic last entry.',
    example: 'This is the last synthetic example.',
    source: 'Synthetic last fixture',
  });
  const otherFirst = await other.save(createEntry('first'));
  const otherRemoved = await other.save({ ...createEntry('removed'), translation: '另一部署的合成词' });
  assert.equal(otherRemoved.id, removed.id);
  assert.deepEqual(await peer.list(), [last, removed, first]);

  assert.equal(await store.remove(removed.id), undefined);
  assert.deepEqual(await store.list(), [last, first]);
  assert.deepEqual(await peer.list(), [last, first]);
  await store.close();
  assert.deepEqual(await store.list(), [last, first]);
  assert.deepEqual(await other.list(), [otherRemoved, otherFirst]);

  await store.remove(first.id);
  assert.deepEqual(await store.list(), [last]);
  await store.remove(last.id);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await peer.list(), []);
  await store.close();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await other.list(), [otherRemoved, otherFirst]);
});

test('deleting missing or already deleted IDs is idempotent, and the maximum safe integer leaves other records intact', async t => {
  const store = createWordStore({ name: 'missing-remove', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  assert.equal(await store.remove(1), undefined);
  assert.deepEqual(await store.list(), []);
  const removed = await store.save(createEntry('removed'));
  const survivor = await store.save(createEntry('survivor'));
  assert.equal(removed.id, 1);
  for (const id of [removed.id, removed.id, 99, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await store.remove(id), undefined);
    assert.deepEqual(await store.list(), [survivor]);
  }
});

test('dual-accent, single-accent and legacy IPA survive reopening without dictionary preferences in database names or v2 records', async t => {
  const factory = new IDBFactory();
  const name = databaseName('https://example.test/wordbook/');
  const store = createWordStore({ name, indexedDB: factory, now: () => new Date(created) });
  t.after(() => store.close());
  const expected = [
    ['dual', 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/'],
    ['american', 'US /təˈmeɪ.toʊ/'],
    ['british', 'UK /təˈmɑː.təʊ/'],
    ['legacy', sample.phonetic],
  ].map(([word, phonetic], index) => ({ ...sample, word, phonetic, created, categoryIds: [], id: index + 1 }));
  for (const { id, created: _created, ...value } of expected) {
    const saved = await store.save({ ...value, provider: 'english-dictionary', dictionaryProvider: 'free-dictionary' });
    assert.deepEqual(saved, { ...value, created, categoryIds: [], id });
  }
  await store.close();
  assert.deepEqual(await store.list(), [...expected].reverse());
  assert.deepEqual(await factory.databases(), [{ name: 'wordbook:/wordbook/', version: 2 }]);
  const db = await openDatabase(factory, name, 2);
  t.after(() => db.close());
  const read = db.transaction('words').objectStore('words').getAll();
  const raw = await new Promise<unknown>((resolve, reject) => {
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.deepEqual(raw, expected);
});

test('database v2 retains the words schema and adds an independent uniquely named category directory', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'schema', indexedDB: factory });
  t.after(() => store.close());
  await store.list();
  const db = await openDatabase(factory, 'schema', 2);
  t.after(() => db.close());
  assert.equal(db.version, 2);
  assert.deepEqual([...db.objectStoreNames], ['categories', 'words']);
  const categories = db.transaction('categories').objectStore('categories');
  assert.equal(categories.keyPath, 'id');
  assert.equal(categories.autoIncrement, true);
  assert.deepEqual([...categories.indexNames], ['normalizedName']);
  assert.equal(categories.index('normalizedName').keyPath, 'normalizedName');
  assert.equal(categories.index('normalizedName').unique, true);
  const words = db.transaction('words').objectStore('words');
  assert.equal(words.keyPath, 'id');
  assert.equal(words.autoIncrement, true);
  assert.deepEqual([...words.indexNames], ['word']);
  assert.equal(words.index('word').keyPath, 'word');
  assert.equal(words.index('word').unique, true);
});

test('invalid entries and device times prevent writes without blocking later valid operations', async t => {
  const factory = new IDBFactory();
  let invalidClock = true;
  const store = createWordStore({ name: 'validation', indexedDB: factory, now: () => new Date(invalidClock ? NaN : created) });
  t.after(() => store.close());
  await assert.rejects(store.save({ ...sample, definition: null }), /内容无效/);
  await assert.rejects(store.save(sample), /当前时间/);
  assert.deepEqual(await store.list(), []);
  invalidClock = false;
  assert.equal((await store.save(sample)).id, 1);
});

test('invalid deletion IDs reject with storageInvalidId before opening the database without key coercion or range deletion', async t => {
  const factory = new IDBFactory();
  const seed = createWordStore({ name: 'invalid-remove', indexedDB: factory });
  t.after(() => seed.close());
  const first = await seed.save(createEntry('first'));
  const second = await seed.save(createEntry('second'));
  await seed.close();
  const open = factory.open.bind(factory);
  let opens = 0;
  factory.open = (name, version) => {
    opens++;
    return open(name, version);
  };
  const store = createWordStore({ name: 'invalid-remove', indexedDB: factory });
  t.after(() => store.close());
  const invalidIds: unknown[] = [
    0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '1', undefined, null, true, 1n, {}, [1], IDBKeyRange.only(first.id), IDBKeyRange.bound(first.id, second.id),
  ];
  for (const id of invalidIds) {
    await assert.rejects(store.remove(id as number), error =>
      error instanceof MessageError && error.detail.code === 'storageInvalidId');
  }
  assert.equal(opens, 0);
  assert.deepEqual(await store.list(), [second, first]);
  assert.equal(opens, 1);
  assert.equal(await store.remove(first.id), undefined);
  assert.deepEqual(await store.list(), [second]);
});

test('concurrent saves of the same normalized word from two connections succeed only once without overwriting the first writer', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'concurrent', indexedDB: factory });
  const right = createWordStore({ name: 'concurrent', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  await Promise.all([left.list(), right.list()]);
  const outcomes = await Promise.allSettled([
    left.save({ ...sample, word: ' APPLE ', translation: 'left' }),
    right.save({ ...sample, word: 'apple', translation: 'right' }),
  ]);
  const saved = outcomes.filter(result => result.status === 'fulfilled');
  const rejected = outcomes.filter(result => result.status === 'rejected');
  assert.equal(saved.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /原词条已保留/);
  assert.deepEqual(await left.list(), [saved[0].value]);
  assert.deepEqual(await right.list(), [saved[0].value]);
});

test('a peer deleting and readding a word gets a new ID that cannot be deleted through the stale ID', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'remove-readd', indexedDB: factory, now: () => new Date(earlier) });
  const right = createWordStore({ name: 'remove-readd', indexedDB: factory, now: () => new Date(created) });
  t.after(() => Promise.all([left.close(), right.close()]));
  const original = await left.save({ ...createEntry('shared'), translation: '原始合成词' });
  const survivor = await left.save(createEntry('survivor'));
  assert.deepEqual(await right.list(), [survivor, original]);
  await right.remove(original.id);
  const fresh = await right.save({
    ...createEntry(' SHARED '), translation: '新合成词', definition: 'A synthetic replacement.', source: 'Synthetic replacement fixture',
  });
  assert.ok(fresh.id > survivor.id);
  assert.equal(fresh.word, original.word);
  assert.equal(await left.remove(original.id), undefined);
  assert.deepEqual(await left.list(), [fresh, survivor]);
  assert.deepEqual(await right.list(), [fresh, survivor]);
  await left.close();
  assert.deepEqual(await left.list(), [fresh, survivor]);
});

test('imports default to preserving existing words and the first file occurrence, retaining dates and discarding client IDs', async t => {
  const store = createWordStore({ name: 'import', indexedDB: new IDBFactory(), now: () => new Date(created) });
  t.after(() => store.close());
  const existing = await store.save({ ...sample, word: 'apple' });
  const values = [
    { ...dated('apple'), translation: '不应覆盖', categoryIds: [], id: 80 },
    { ...dated('banana'), word: ' BANANA ', translation: '首条', categoryIds: [], id: 99 },
    { ...dated('banana'), translation: '后条' },
    { ...dated('cherry'), categoryIds: [], id: 600 },
    dated('apple'),
  ];
  assert.deepEqual(await store.importEntries(batch(values)), { classified: 0, categoriesCreated: 0, imported: 2, updated: 0, skipped: 3 });
  assert.deepEqual(await store.list(), [
    { ...dated('cherry'), categoryIds: [], id: 3 },
    { ...dated('banana'), translation: '首条', categoryIds: [], id: 2 },
    existing,
  ]);
  assert.deepEqual(await store.importEntries(batch(values)), { classified: 0, categoriesCreated: 0, imported: 0, updated: 0, skipped: 5 });
  assert.deepEqual(await store.importEntries(batch([])), { classified: 0, categoriesCreated: 0, imported: 0, updated: 0, skipped: 0 });
});

test('empty options, explicit false and non-boolean truthy values never enable overwriting', async t => {
  const store = createWordStore({ name: 'safe-import-options', indexedDB: new IDBFactory(), now: () => new Date(created) });
  t.after(() => store.close());
  const existing = await store.save({ ...sample, word: 'existing' });
  const values = [
    { ...dated('existing'), word: ' EXISTING ', translation: 'Do not replace the original' },
    dated('new'),
    { ...dated('new'), word: ' NEW ', translation: 'Later duplicate' },
  ];
  assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: false }), { classified: 0, categoriesCreated: 0, imported: 1, updated: 0, skipped: 2 });
  const expected = [{ ...dated('new'), categoryIds: [], id: 2 }, existing];
  assert.deepEqual(await store.list(), expected);
  assert.deepEqual(await store.importEntries(batch(values), {}), { classified: 0, categoriesCreated: 0, imported: 0, updated: 0, skipped: 3 });
  for (const value of [undefined, false, null, 0, 1, 'true', {}, []]) {
    assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: value as boolean }), {
      classified: 0, categoriesCreated: 0, imported: 0, updated: 0, skipped: 3,
    });
    assert.deepEqual(await store.list(), expected);
  }
});

test('overwrite replaces all fields and dates, clears blanks and keeps IDs, order and unrelated records across repeats and reopening', async t => {
  const factory = new IDBFactory();
  const name = 'overwrite-import';
  const store = createWordStore({ name, indexedDB: factory, now: () => new Date(created) });
  t.after(() => store.close());
  const temporary = await store.save(createEntry('temporary'));
  await store.remove(temporary.id);
  const original = await store.save({ ...sample, word: 'alpha' });
  const unrelated = await store.save({ ...sample, word: 'unrelated', source: 'Keep this opaque historical attribution' });
  const cleared = await store.save({ ...sample, word: 'clear' });
  const identical = await store.save({ ...sample, word: 'identical' });
  const replacement: DatedEntry = {
    word: 'alpha', phonetic: 'US /æl.fə/ · UK /æl.fə/', translation: '新的合成释义', pos: 'Adjective',
    definition: 'A complete replacement definition.', example: 'A completely different example.',
    source: 'Historical source | arbitrary user note | MyMemory（机器翻译）', created: earlier,
  };
  const blank: DatedEntry = { ...dated('clear'), source: '' };
  const first: DatedEntry = { ...dated('new first'), translation: 'First occurrence wins', created: '2020-01-01T00:00:00.000Z' };
  const last = { ...dated('new last'), created: '2025-01-01T00:00:00.000Z' };
  const values = Object.freeze([
    { ...replacement, word: ' ALPHA ', phonetic: ` ${replacement.phonetic} `, translation: ` ${replacement.translation} `, categoryIds: [], id: unrelated.id, extra: { ignore: true } },
    { ...first, word: ' NEW FIRST ', categoryIds: [], id: original.id, extra: 'ignored' },
    { ...dated('alpha'), translation: 'Later existing-word duplicate must not win' },
    { ...blank, phonetic: ' \t', translation: '　', pos: ' ', definition: '\n', example: '\r\n', source: ' \t　', categoryIds: [], id: -1 },
    { ...identical, categoryIds: [], id: 9999, dictionaryProvider: 'ignored' },
    { ...dated('new first'), translation: 'Later new-word duplicate must not win' },
    { ...last, categoryIds: [], id: 600 },
  ].map(value => Object.freeze(value)));
  const input = structuredClone(values);
  const expected = [
    { ...last, categoryIds: [], id: 7 }, { ...first, categoryIds: [], id: 6 }, identical,
    { ...blank, categoryIds: [], id: cleared.id }, unrelated, { ...replacement, categoryIds: [], id: original.id },
  ];
  for (const counts of [
    { classified: 0, categoriesCreated: 0, imported: 2, updated: 3, skipped: 2 },
    { classified: 0, categoriesCreated: 0, imported: 0, updated: 5, skipped: 2 },
  ]) {
    const result = await store.importEntries(batch(values), { overwriteExisting: true });
    assert.deepEqual(result, counts);
    assert.equal(result.imported + result.updated + result.skipped, values.length);
    assert.deepEqual(await store.list(), expected);
    assert.deepEqual(values, input);
  }
  for (const overwriteExisting of [false, true]) {
    assert.deepEqual(await store.importEntries(batch([]), { overwriteExisting }), { classified: 0, categoriesCreated: 0, imported: 0, updated: 0, skipped: 0 });
    assert.deepEqual(await store.list(), expected);
  }
  await store.close();
  const reopened = createWordStore({ name, indexedDB: factory });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.list(), expected);
  assert.deepEqual(await factory.databases(), [{ name, version: 2 }]);
  const db = await openDatabase(factory, name, 2);
  t.after(() => db.close());
  const request = db.transaction('words').objectStore('words').getAll();
  const raw = await new Promise<unknown>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // list() also validates records, so inspect raw storage to catch accidentally persisted IDs or extras.
  assert.deepEqual(raw, [...expected].reverse());
  assert.deepEqual(values, input);
});

test('overwrite uses one readwrite transaction and publishes completed add and put counts only after commit', async t => {
  const factory = new IDBFactory();
  const modes: IDBTransactionMode[] = [];
  const events: string[] = [];
  let observing = false;
  observeConnections(factory, db => {
    const transact = db.transaction.bind(db);
    db.transaction = (...args: Parameters<IDBDatabase['transaction']>) => {
      const transaction = transact(...args);
      if (observing) modes.push(transaction.mode);
      return transaction;
    };
    interceptWrites(db, (words, transaction) => {
      if (!observing) return;
      for (const method of ['add', 'put'] as const) {
        const write = words[method].bind(words);
        words[method] = (value: unknown, key?: IDBValidKey) => {
          const request = write(value, key);
          request.addEventListener('success', () => { events.push(method); });
          return request;
        };
      }
      transaction.addEventListener('complete', () => { events.push('commit'); });
    });
  });
  const store = createWordStore({ name: 'overwrite-commit', indexedDB: factory });
  t.after(() => store.close());
  await store.save(createEntry('existing'));
  observing = true;
  const counts = await store.importEntries(batch([dated('existing'), dated('new'), dated('new')]), { overwriteExisting: true }).then(result => {
    events.push('resolved');
    return result;
  });
  observing = false;
  assert.deepEqual(modes, ['readwrite']);
  assert.deepEqual(events.slice(0, 2).sort(), ['add', 'put']);
  assert.deepEqual(events.slice(2), ['commit', 'resolved']);
  assert.deepEqual(counts, { classified: 0, categoriesCreated: 0, imported: 1, updated: 1, skipped: 1 });
});

for (const connection of ['cold', 'warm']) {
  for (const overwriteExisting of [false, true]) {
    test(`${connection} imports snapshot overwriteExisting=${overwriteExisting} before callers mutate the options`, async t => {
      const store = createWordStore({ name: 'snapshot-options', indexedDB: new IDBFactory(), now: () => new Date(created) });
      t.after(() => store.close());
      const original = await store.save({ ...sample, word: 'existing' });
      if (connection === 'cold') await store.close();
      const replacement = { ...dated('existing'), translation: 'Snapshot replacement' };
      const options = { overwriteExisting };
      const pending = store.importEntries(batch([replacement]), options);
      options.overwriteExisting = !overwriteExisting;
      assert.deepEqual(await pending, { classified: 0, categoriesCreated: 0, imported: 0, updated: Number(overwriteExisting), skipped: Number(!overwriteExisting) });
      assert.deepEqual(await store.list(), [overwriteExisting ? { ...replacement, categoryIds: [], id: original.id } : original]);
    });
  }
}

test('concurrent imports check duplicates within the same read-write transaction without rejecting overlapping batches', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'concurrent-import', indexedDB: factory });
  const right = createWordStore({ name: 'concurrent-import', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  const results = await Promise.all([
    left.importEntries(batch([dated('shared'), dated('left')])),
    right.importEntries(batch([dated('shared'), dated('right')])),
  ]);
  assert.equal(results.reduce((total, value) => total + value.imported, 0), 3);
  assert.equal(results.reduce((total, value) => total + value.updated, 0), 0);
  assert.equal(results.reduce((total, value) => total + value.skipped, 0), 1);
  for (const result of results) assert.equal(result.imported + result.updated + result.skipped, 2);
  assert.deepEqual((await left.list()).map(entry => entry.word).sort(), ['left', 'right', 'shared']);
});

test('concurrent overlapping overwrite imports serialize both existing and newly shared words without changing their IDs', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'concurrent-overwrite', indexedDB: factory });
  const right = createWordStore({ name: 'concurrent-overwrite', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  const shared = await left.save({ ...sample, word: 'shared' });
  const unrelated = await left.save({ ...sample, word: 'unrelated' });
  await right.list();
  const batches = ['left', 'right'].map(side => [
    { ...dated('shared'), word: ' SHARED ', translation: `${side} existing replacement` },
    { ...dated('overlap'), word: ' OVERLAP ', source: `${side} new shared attribution` },
    dated(side),
    { ...dated('overlap'), source: `${side} ignored later occurrence` },
  ]);
  const results = await Promise.all([
    left.importEntries(batch(batches[0]), { overwriteExisting: true }),
    right.importEntries(batch(batches[1]), { overwriteExisting: true }),
  ]);
  const first = results.findIndex(result => result.imported === 2);
  assert.notEqual(first, -1);
  const second = 1 - first;
  assert.deepEqual(results[first], { classified: 0, categoriesCreated: 0, imported: 2, updated: 1, skipped: 1 });
  assert.deepEqual(results[second], { classified: 0, categoriesCreated: 0, imported: 1, updated: 2, skipped: 1 });
  for (const result of results) assert.equal(result.imported + result.updated + result.skipped, 4);
  const expected = [
    { ...batches[second][2], categoryIds: [], id: 5 }, { ...batches[first][2], categoryIds: [], id: 4 },
    { ...batches[second][1], word: 'overlap', categoryIds: [], id: 3 }, unrelated,
    { ...batches[second][0], word: 'shared', categoryIds: [], id: shared.id },
  ];
  assert.deepEqual(await left.list(), expected);
  assert.deepEqual(await right.list(), expected);
  await Promise.all([left.close(), right.close()]);
  assert.deepEqual(await left.list(), expected);
});

for (const overwriteExisting of [false, true]) {
  test(`invalid final, duplicate and sparse entries validate before any transaction with overwriteExisting=${overwriteExisting}`, async t => {
    const factory = new IDBFactory();
    let transactions = 0;
    observeConnections(factory, db => {
      const transact = db.transaction.bind(db);
      db.transaction = (...args: Parameters<IDBDatabase['transaction']>) => {
        transactions++;
        return transact(...args);
      };
    });
    const store = createWordStore({ name: 'invalid-import', indexedDB: factory });
    t.after(() => store.close());
    const original = await store.save({ ...sample, word: 'existing' });
    const replacement = { ...dated('existing'), translation: 'Must not partially replace' };
    const sparse = Object.assign(new Array<DatedEntry>(3), { 0: replacement, 1: dated('valid') });
    for (const values of [
      [replacement, dated('valid'), { ...dated('last'), definition: null }],
      [replacement, dated('valid'), { ...dated('valid'), word: ' VALID ', created: '2024-01-01' }],
      [replacement, dated('valid'), { ...dated('existing'), source: undefined }],
      sparse, new Array<DatedEntry>(1),
    ]) {
      const before = transactions;
      await assert.rejects(store.importEntries(batch(values as unknown as DatedEntry[]), { overwriteExisting }));
      assert.equal(transactions, before, 'Do not begin a transaction until every record, including duplicates and holes, is valid');
      assert.deepEqual(await store.list(), [original]);
    }
    assert.deepEqual(await store.importEntries(batch([replacement, dated('valid')]), { overwriteExisting }), {
      classified: 0, categoriesCreated: 0, imported: 1, updated: Number(overwriteExisting), skipped: Number(!overwriteExisting),
    });
    assert.deepEqual(await store.list(), [
      { ...dated('valid'), categoryIds: [], id: 2 }, overwriteExisting ? { ...replacement, categoryIds: [], id: original.id } : original,
    ]);
  });
}

test('overwrite rejects non-positive, unsafe and non-numeric existing IDs without committing any part of the batch', async t => {
  const invalidIds: IDBValidKey[] = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1', new Date(0), [1]];
  for (const id of invalidIds) {
    const factory = new IDBFactory();
    const name = 'invalid-overwrite-id';
    const store = createWordStore({ name, indexedDB: factory });
    t.after(() => store.close());
    await store.save({ ...sample, word: 'existing' });
    const db = await openDatabase(factory, name, 2);
    t.after(() => db.close());
    const transaction = db.transaction('words', 'readwrite');
    transaction.objectStore('words').add({ ...dated('corrupt'), id });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const readRaw = () => new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('words').objectStore('words').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const before = await readRaw();
    await assert.rejects(store.importEntries(batch([dated('existing'), dated('new'), dated('corrupt')]), { overwriteExisting: true }), {
      name: 'MessageError', detail: { code: 'storageInvalidId' },
    });
    assert.deepEqual(await readRaw(), before);
    await store.close();
    assert.deepEqual(await readRaw(), before);
  }
});

test('overwrite preserves a maximum-safe-integer existing ID instead of using the incoming ID or allocating another', async t => {
  const factory = new IDBFactory();
  const name = 'safe-overwrite-id';
  const store = createWordStore({ name, indexedDB: factory });
  t.after(() => store.close());
  const unrelated = await store.save(createEntry('unrelated'));
  const db = await openDatabase(factory, name, 2);
  t.after(() => db.close());
  const transaction = db.transaction('words', 'readwrite');
  transaction.objectStore('words').add({ ...dated('boundary'), categoryIds: [], id: Number.MAX_SAFE_INTEGER });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  const replacement = { ...dated('boundary'), translation: 'Replace at the same safe key', created };
  const values = [{ ...replacement, categoryIds: [], id: unrelated.id }];
  assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: true }), {
    classified: 0, categoriesCreated: 0, imported: 0, updated: 1, skipped: 0,
  });
  await store.close();
  assert.deepEqual(await store.list(), [{ ...replacement, categoryIds: [], id: Number.MAX_SAFE_INTEGER }, unrelated]);
});

test('an abort after successful put and add requests rolls both back, survives reopening and permits a complete retry', async t => {
  const factory = new IDBFactory();
  let abort = false;
  const succeeded: string[] = [];
  let committed = false;
  observeConnections(factory, db => interceptWrites(db, (words, transaction) => {
    if (!abort) return;
    abort = false;
    for (const method of ['put', 'add'] as const) {
      const write = words[method].bind(words);
      words[method] = (value: unknown, key?: IDBValidKey) => {
        const request = write(value, key);
        request.addEventListener('success', () => {
          succeeded.push(method);
          if (succeeded.length === 2) transaction.abort();
        });
        return request;
      };
    }
    transaction.addEventListener('complete', () => { committed = true; });
  }));
  const store = createWordStore({ name: 'abort-overwrite', indexedDB: factory });
  t.after(() => store.close());
  const existing = await store.save({ ...sample, word: 'existing' });
  const unrelated = await store.save({ ...sample, word: 'unrelated' });
  const values = [dated('existing'), dated('first'), dated('second')];
  abort = true;
  await assert.rejects(store.importEntries(batch(values), { overwriteExisting: true }), {
    name: 'MessageError', detail: { code: 'storageAborted' },
  });
  assert.deepEqual(succeeded, ['put', 'add']);
  assert.equal(committed, false);
  assert.deepEqual(await store.list(), [unrelated, existing]);
  await store.close();
  assert.deepEqual(await store.list(), [unrelated, existing]);
  assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: true }), { classified: 0, categoriesCreated: 0, imported: 2, updated: 1, skipped: 0 });
  assert.deepEqual(await store.list(), [
    { ...dated('second'), categoryIds: [], id: 4 }, { ...dated('first'), categoryIds: [], id: 3 }, unrelated, { ...dated('existing'), categoryIds: [], id: existing.id },
  ]);
});

for (const failingMethod of ['put', 'add'] as const) {
  test(`a synchronous ${failingMethod} failure inside an import callback aborts both queued puts and adds and allows retry`, async t => {
    const factory = new IDBFactory();
    let fail = false;
    const attempted: string[] = [];
    observeConnections(factory, db => interceptWrites(db, words => {
      if (!fail) return;
      for (const method of ['put', 'add'] as const) {
        const write = words[method].bind(words);
        words[method] = (value: unknown, key?: IDBValidKey) => {
          attempted.push(method);
          if (method === failingMethod && (value as DatedEntry).word === 'failure')
            throw new DOMException('Synthetic synchronous write failure', 'QuotaExceededError');
          return write(value, key);
        };
      }
    }));
    const store = createWordStore({ name: 'sync-overwrite', indexedDB: factory });
    t.after(() => store.close());
    const existing = await store.save({ ...sample, word: 'existing' });
    const unrelated = await store.save({ ...sample, word: 'unrelated' });
    const failed = failingMethod === 'put' ? await store.save({ ...sample, word: 'failure' }) : undefined;
    const before = await store.list();
    const values = [dated('existing'), dated('new'), dated('failure')];
    fail = true;
    await assert.rejects(store.importEntries(batch(values), { overwriteExisting: true }), {
      name: 'MessageError', detail: { code: 'storageQuota' },
    });
    assert.deepEqual(attempted, ['put', 'add', failingMethod]);
    assert.deepEqual(await store.list(), before);
    await store.close();
    assert.deepEqual(await store.list(), before);
    fail = false;
    assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: true }), {
      classified: 0, categoriesCreated: 0, imported: failed ? 1 : 2, updated: failed ? 2 : 1, skipped: 0,
    });
    const restored = await store.list();
    assert.deepEqual(restored, failed ? [
      { ...dated('new'), categoryIds: [], id: 4 }, { ...dated('failure'), categoryIds: [], id: failed.id }, unrelated, { ...dated('existing'), categoryIds: [], id: existing.id },
    ] : [
      { ...dated('failure'), categoryIds: [], id: 4 }, { ...dated('new'), categoryIds: [], id: 3 }, unrelated, { ...dated('existing'), categoryIds: [], id: existing.id },
    ]);
  });

  test(`an asynchronous ${failingMethod} constraint failure rolls back successful puts and adds instead of counting a skipped word`, async t => {
    const factory = new IDBFactory();
    let fail = false;
    const succeeded: string[] = [];
    const errors: string[] = [];
    observeConnections(factory, db => interceptWrites(db, words => {
      if (!fail) return;
      for (const method of ['put', 'add'] as const) {
        const write = words[method].bind(words);
        words[method] = (value: unknown, key?: IDBValidKey) => {
          const entry = value as DatedEntry;
          const conflict = method === failingMethod && entry.word === 'failure';
          // add collides on the primary key; put collides on the unique word index at a different ID.
          const injected = conflict ? { ...entry, ...(method === 'put' ? { word: 'existing' } : { id: 1 }) } : value;
          const request = write(injected, key);
          request.addEventListener('success', () => { succeeded.push(method); });
          request.addEventListener('error', () => { errors.push(request.error?.name ?? ''); });
          return request;
        };
      }
    }));
    const store = createWordStore({ name: 'constraint-overwrite', indexedDB: factory });
    t.after(() => store.close());
    const existing = await store.save({ ...sample, word: 'existing' });
    const unrelated = await store.save({ ...sample, word: 'unrelated' });
    const failed = failingMethod === 'put' ? await store.save({ ...sample, word: 'failure' }) : undefined;
    const before = await store.list();
    const values = [dated('existing'), dated('new'), dated('failure')];
    fail = true;
    await assert.rejects(store.importEntries(batch(values), { overwriteExisting: true }), {
      name: 'MessageError', detail: { code: 'storageConstraint' },
    });
    assert.deepEqual(succeeded, ['put', 'add']);
    assert.deepEqual(errors, ['ConstraintError']);
    assert.deepEqual(await store.list(), before);
    await store.close();
    assert.deepEqual(await store.list(), before);
    fail = false;
    assert.deepEqual(await store.importEntries(batch(values), { overwriteExisting: true }), {
      classified: 0, categoriesCreated: 0, imported: failed ? 1 : 2, updated: failed ? 2 : 1, skipped: 0,
    });
    assert.deepEqual(await store.list(), failed ? [
      { ...dated('new'), categoryIds: [], id: 4 }, { ...dated('failure'), categoryIds: [], id: failed.id }, unrelated, { ...dated('existing'), categoryIds: [], id: existing.id },
    ] : [
      { ...dated('failure'), categoryIds: [], id: 4 }, { ...dated('new'), categoryIds: [], id: 3 }, unrelated, { ...dated('existing'), categoryIds: [], id: existing.id },
    ]);
  });
}

test('transaction aborts after successful requests still reject and roll back atomically, allowing retries', async t => {
  const factory = new IDBFactory();
  let abortAfter = 0;
  let succeeded = 0;
  observeConnections(factory, db => interceptWrites(db, (words, transaction) => {
    if (!abortAfter) return;
    const count = abortAfter;
    abortAfter = 0;
    const add = words.add.bind(words);
    let seen = 0;
    words.add = (...args: Parameters<IDBObjectStore['add']>) => {
      const request = add(...args);
      request.addEventListener('success', () => {
        succeeded++;
        if (++seen === count) transaction.abort();
      });
      return request;
    };
  }));
  const store = createWordStore({ name: 'abort', indexedDB: factory });
  t.after(() => store.close());
  const existing = await store.save(createEntry('existing'));
  abortAfter = 2;
  await assert.rejects(store.importEntries(batch([dated('first'), dated('second'), dated('third')])), /中止/);
  assert.equal(succeeded, 2);
  assert.deepEqual(await store.list(), [existing]);
  abortAfter = 1;
  await assert.rejects(store.save(createEntry('saved-request')), /中止/);
  assert.equal(succeeded, 3);
  assert.deepEqual(await store.list(), [existing]);
  assert.deepEqual(await store.importEntries(batch([dated('first'), dated('second')])), { classified: 0, categoriesCreated: 0, imported: 2, updated: 0, skipped: 0 });
  assert.deepEqual((await store.list()).map(entry => entry.id), [3, 2, 1]);
});

test('transaction aborts after successful delete requests reject, preserve records after reopening and allow retries', async t => {
  const factory = new IDBFactory();
  let abort = false;
  let succeeded = 0;
  observeConnections(factory, db => interceptWrites(db, (words, transaction) => {
    if (!abort) return;
    abort = false;
    const remove = words.delete.bind(words);
    words.delete = (...args: Parameters<IDBObjectStore['delete']>) => {
      const request = remove(...args);
      request.addEventListener('success', () => {
        succeeded++;
        transaction.abort();
      });
      return request;
    };
  }));
  const store = createWordStore({ name: 'abort-remove', indexedDB: factory });
  t.after(() => store.close());
  const removed = await store.save(createEntry('removed'));
  const survivor = await store.save(createEntry('survivor'));
  abort = true;
  await assert.rejects(store.remove(removed.id), { name: 'MessageError', detail: { code: 'storageAborted' } });
  assert.equal(succeeded, 1);
  assert.deepEqual(await store.list(), [survivor, removed]);
  await store.close();
  assert.deepEqual(await store.list(), [survivor, removed]);
  assert.equal(await store.remove(removed.id), undefined);
  assert.deepEqual(await store.list(), [survivor]);
});

test('synchronous deletion failures reject without changing the notebook and allow retrying the same ID', async t => {
  const factory = new IDBFactory();
  let fail = false;
  observeConnections(factory, db => interceptWrites(db, words => {
    if (!fail) return;
    words.delete = () => {
      fail = false;
      throw new DOMException('Inactive', 'TransactionInactiveError');
    };
  }));
  const store = createWordStore({ name: 'sync-remove', indexedDB: factory });
  t.after(() => store.close());
  const removed = await store.save(createEntry('removed'));
  const survivor = await store.save(createEntry('survivor'));
  fail = true;
  await assert.rejects(store.remove(removed.id), { name: 'MessageError', detail: { code: 'storageInactive' } });
  assert.deepEqual(await store.list(), [survivor, removed]);
  assert.equal(await store.remove(removed.id), undefined);
  assert.deepEqual(await store.list(), [survivor]);
});

test('unexpected primary-key ConstraintError is not treated as a duplicate word and rolls back the whole batch', async t => {
  const factory = new IDBFactory();
  let inject = false;
  let succeeded = 0;
  observeConnections(factory, db => interceptWrites(db, words => {
    const add = words.add.bind(words);
    words.add = (value: unknown, key?: IDBValidKey) => {
      const entry = value as DatedEntry;
      const request = add(inject && entry.word === 'conflict' ? { ...entry, categoryIds: [], id: 1 } : value, key);
      request.addEventListener('success', () => { succeeded++; });
      return request;
    };
  }));
  const store = createWordStore({ name: 'constraint', indexedDB: factory });
  t.after(() => store.close());
  const existing = await store.save(createEntry('existing'));
  succeeded = 0;
  inject = true;
  await assert.rejects(store.importEntries(batch([dated('first'), dated('conflict')])), /约束冲突/);
  assert.equal(succeeded, 1);
  assert.deepEqual(await store.list(), [existing]);
  inject = false;
  assert.deepEqual(await store.importEntries(batch([dated('first'), dated('conflict')])), { classified: 0, categoriesCreated: 0, imported: 2, updated: 0, skipped: 0 });
});

test('synchronous quota errors fail helpfully and roll back without affecting later writes', async t => {
  const factory = new IDBFactory();
  let fail = true;
  observeConnections(factory, db => interceptWrites(db, words => {
    if (!fail) return;
    words.add = () => {
      fail = false;
      throw new DOMException('Full', 'QuotaExceededError');
    };
  }));
  const store = createWordStore({ name: 'quota', indexedDB: factory });
  t.after(() => store.close());
  await assert.rejects(store.save(sample), /存储空间不足/);
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.save(sample)).id, 1);
});

test('open failures do not permanently cache rejected promises and later calls can reopen the database', async t => {
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  let attempts = 0;
  factory.open = (name, version) => {
    if (++attempts === 1) throw new DOMException('Denied', 'SecurityError');
    return open(name, version);
  };
  const store = createWordStore({ name: 'retry', indexedDB: factory });
  t.after(() => store.close());
  assert.equal(attempts, 0);
  await assert.rejects(store.list(), /禁止访问.*权限/);
  assert.equal((await store.save(sample)).id, 1);
  assert.equal(attempts, 2);
});

test('asynchronous open failures allow retries without deleting or downgrading the notebook', async t => {
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  let fail = true;
  factory.open = (name, version) => {
    const request = open(name, version);
    if (fail) {
      fail = false;
      request.addEventListener('upgradeneeded', () => request.transaction?.abort());
    }
    return request;
  };
  const store = createWordStore({ name: 'async-retry', indexedDB: factory });
  t.after(() => store.close());
  await assert.rejects(store.list());
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.save(sample)).id, 1);
});

test('blocked opens reject promptly, close late connections and still allow successful retries', { timeout: 5000 }, async t => {
  const factory = new IDBFactory();
  const seed = createWordStore({ name: 'blocked', indexedDB: factory });
  const original = await seed.save(sample);
  await seed.close();
  const open = factory.open.bind(factory);
  let block = true;
  factory.open = (name, version) => {
    const request = open(name, version);
    if (block) {
      block = false;
      queueMicrotask(() => request.dispatchEvent(new IDBVersionChangeEvent('blocked')));
    }
    return request;
  };
  const store = createWordStore({ name: 'blocked', indexedDB: factory });
  t.after(() => store.close());
  await assert.rejects(store.list(), /其他标签页占用/);
  assert.deepEqual(await store.list(), [original]);
  await store.close();
  const upgraded = await openDatabase(factory, 'blocked', 3);
  upgraded.close();
});

test('close cancels pending opens and later operations can reopen the database', async t => {
  const store = createWordStore({ name: 'close-opening', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const pending = store.list();
  const closing = store.close();
  await assert.rejects(pending, /连接已关闭/);
  await closing;
  assert.deepEqual(await store.list(), []);
});

test('close waits for active write transactions without losing committed data', async t => {
  const factory = new IDBFactory();
  let duringWrite: (() => void) | undefined;
  observeConnections(factory, db => interceptWrites(db, () => duringWrite?.()));
  const store = createWordStore({ name: 'close-transaction', indexedDB: factory });
  t.after(() => store.close());
  let closed: Promise<void> | undefined;
  duringWrite = () => { queueMicrotask(() => { closed = store.close(); }); };
  const saved = await store.save(sample);
  assert.ok(closed);
  await closed;
  duringWrite = undefined;
  assert.deepEqual(await store.list(), [saved]);
});

test('versionchange releases old connections and subsequent version mismatches explicitly reject', { timeout: 5000 }, async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'version', indexedDB: factory });
  t.after(() => store.close());
  const original = await store.save(sample);
  const db = await openDatabase(factory, 'version', 3);
  t.after(() => db.close());
  await assert.rejects(store.list(), /版本不兼容/);
  await assert.rejects(store.list(), /版本不兼容/);
  const read = db.transaction('words').objectStore('words').get(original.id);
  const value = await new Promise<unknown>((resolve, reject) => {
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.deepEqual(value, original);
});

test('unexpected connection closure clears the cache while preserving data after reopening', async t => {
  const factory = new IDBFactory();
  let connection: IDBDatabase | undefined;
  let opens = 0;
  observeConnections(factory, db => { connection = db; opens++; });
  const store = createWordStore({ name: 'forced-close', indexedDB: factory });
  t.after(() => store.close());
  const original = await store.save(sample);
  assert.ok(connection);
  const closed = new Promise<void>(resolve => connection!.addEventListener('close', () => resolve(), { once: true }));
  // fake-indexeddb 6 incorrectly declares a constructor parameter; at runtime it accepts a database instance.
  (forceCloseDatabase as unknown as (db: IDBDatabase) => void)(connection);
  await closed;
  assert.deepEqual(await store.list(), [original]);
  assert.equal(opens, 2);
});
