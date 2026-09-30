import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange, IDBVersionChangeEvent, forceCloseDatabase } from 'fake-indexeddb';
import { createEntry, sample } from '../src/entry';
import type { DatedEntry } from '../src/entry';
import { MessageError } from '../src/messages';
import { createWordStore, databaseName } from '../src/storage';

const created = '2026-09-28T08:00:00.000Z';
const earlier = '2024-02-29T12:34:56.789Z';
const dated = (word: string): DatedEntry => ({ ...createEntry(word), created: earlier });

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
    'https://example.com/wordbook/?search=apple#word',
    'https://example.com/wordbook/index.html?version=3#word',
    'https://example.com/other/../wordbook/index.html',
  ]) assert.equal(databaseName(url), 'wordbook:/wordbook/');
  assert.equal(databaseName('https://example.com/index.html?x=1#top'), 'wordbook:/');
  assert.equal(databaseName('https://example.com/'), 'wordbook:/');
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
  const first = await store.save({ ...sample, word: ' APPLE ', id: 700, created: 'bad date', extra: 'ignored' });
  assert.deepEqual(first, { ...sample, word: 'apple', id: 1, created });
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

test('dual-accent, single-accent and legacy IPA survive reopening without dictionary preferences in database names or v1 records', async t => {
  const factory = new IDBFactory();
  const name = databaseName('https://example.test/wordbook/');
  const store = createWordStore({ name, indexedDB: factory, now: () => new Date(created) });
  t.after(() => store.close());
  const expected = [
    ['dual', 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/'],
    ['american', 'US /təˈmeɪ.toʊ/'],
    ['british', 'UK /təˈmɑː.təʊ/'],
    ['legacy', sample.phonetic],
  ].map(([word, phonetic], index) => ({ ...sample, word, phonetic, created, id: index + 1 }));
  for (const { id, created: _created, ...value } of expected) {
    const saved = await store.save({ ...value, provider: 'english-dictionary', dictionaryProvider: 'free-dictionary' });
    assert.deepEqual(saved, { ...value, created, id });
  }
  await store.close();
  assert.deepEqual(await store.list(), [...expected].reverse());
  assert.deepEqual(await factory.databases(), [{ name: 'wordbook:/wordbook/', version: 1 }]);
  const db = await openDatabase(factory, name, 1);
  t.after(() => db.close());
  const read = db.transaction('words').objectStore('words').getAll();
  const raw = await new Promise<unknown>((resolve, reject) => {
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.deepEqual(raw, expected);
});

test('database v1 contains only the words store with an auto-incrementing id and a unique word index', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'schema', indexedDB: factory });
  t.after(() => store.close());
  await store.list();
  const db = await openDatabase(factory, 'schema', 1);
  t.after(() => db.close());
  assert.equal(db.version, 1);
  assert.deepEqual([...db.objectStoreNames], ['words']);
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

test('imports prefer existing words and the first file occurrence, preserving dates and discarding client IDs', async t => {
  const store = createWordStore({ name: 'import', indexedDB: new IDBFactory(), now: () => new Date(created) });
  t.after(() => store.close());
  const existing = await store.save({ ...sample, word: 'apple' });
  const values = [
    { ...dated('apple'), translation: '不应覆盖', id: 80 },
    { ...dated('banana'), word: ' BANANA ', translation: '首条', id: 99 },
    { ...dated('banana'), translation: '后条' },
    { ...dated('cherry'), id: 600 },
    dated('apple'),
  ];
  assert.deepEqual(await store.importEntries(values), { imported: 2, skipped: 3 });
  assert.deepEqual(await store.list(), [
    { ...dated('cherry'), id: 3 },
    { ...dated('banana'), translation: '首条', id: 2 },
    existing,
  ]);
  assert.deepEqual(await store.importEntries(values), { imported: 0, skipped: 5 });
  assert.deepEqual(await store.importEntries([]), { imported: 0, skipped: 0 });
});

test('concurrent imports check duplicates within the same read-write transaction without rejecting overlapping batches', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'concurrent-import', indexedDB: factory });
  const right = createWordStore({ name: 'concurrent-import', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  const results = await Promise.all([
    left.importEntries([dated('shared'), dated('left')]),
    right.importEntries([dated('shared'), dated('right')]),
  ]);
  assert.equal(results.reduce((total, value) => total + value.imported, 0), 3);
  assert.equal(results.reduce((total, value) => total + value.skipped, 0), 1);
  assert.deepEqual((await left.list()).map(entry => entry.word).sort(), ['left', 'right', 'shared']);
});

test('invalid final entries and invalid duplicates reject the whole batch without partial writes', async t => {
  const store = createWordStore({ name: 'invalid-import', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const original = await store.save(createEntry('existing'));
  for (const values of [
    [dated('valid'), { ...dated('last'), definition: null }],
    [dated('valid'), { ...dated('valid'), created: '2024-01-01' }],
    [dated('valid'), { ...dated('existing'), source: undefined }],
  ]) {
    await assert.rejects(store.importEntries(values as unknown as DatedEntry[]));
    assert.deepEqual(await store.list(), [original]);
  }
  await assert.rejects(store.importEntries(new Array<DatedEntry>(1)), /内容无效/);
  assert.deepEqual(await store.list(), [original]);
  assert.deepEqual(await store.importEntries([dated('valid')]), { imported: 1, skipped: 0 });
});

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
  await assert.rejects(store.importEntries([dated('first'), dated('second'), dated('third')]), /中止/);
  assert.equal(succeeded, 2);
  assert.deepEqual(await store.list(), [existing]);
  abortAfter = 1;
  await assert.rejects(store.save(createEntry('saved-request')), /中止/);
  assert.equal(succeeded, 3);
  assert.deepEqual(await store.list(), [existing]);
  assert.deepEqual(await store.importEntries([dated('first'), dated('second')]), { imported: 2, skipped: 0 });
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
      const request = add(inject && entry.word === 'conflict' ? { ...entry, id: 1 } : value, key);
      request.addEventListener('success', () => { succeeded++; });
      return request;
    };
  }));
  const store = createWordStore({ name: 'constraint', indexedDB: factory });
  t.after(() => store.close());
  const existing = await store.save(createEntry('existing'));
  succeeded = 0;
  inject = true;
  await assert.rejects(store.importEntries([dated('first'), dated('conflict')]), /约束冲突/);
  assert.equal(succeeded, 1);
  assert.deepEqual(await store.list(), [existing]);
  inject = false;
  assert.deepEqual(await store.importEntries([dated('first'), dated('conflict')]), { imported: 2, skipped: 0 });
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
  const upgraded = await openDatabase(factory, 'blocked', 2);
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
  const db = await openDatabase(factory, 'version', 2);
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
