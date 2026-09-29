import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBVersionChangeEvent, forceCloseDatabase } from 'fake-indexeddb';
import { createEntry, sample } from '../src/entry';
import type { DatedEntry } from '../src/entry';
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

test('库名使用稳定部署目录，忽略页面名、hash、query，不跨项目混用', () => {
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

test('创建 store 不访问 IndexedDB；不支持时读取友好失败', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  const store = createWordStore({ name: 'unsupported' });
  await assert.rejects(store.list(), /不支持.*IndexedDB/);
  await assert.rejects(store.list(), /不支持.*IndexedDB/);
  await store.close();
});

test('保存采用七个字段和注入时间，倒序读取，重复词保留原内容', async t => {
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

test('数据库 v1 只有 words 仓库、自动递增 id 和唯一 word 索引', async t => {
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

test('非法保存和无效设备时间不写入，后续有效操作仍可执行', async t => {
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

test('两连接并发保存同一规范词只有一个成功，不覆盖先写入者', async t => {
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

test('导入已有库词优先、文件内首条优先，保留日期并丢弃客户端 ID', async t => {
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

test('并发导入在同一读写事务查重，交集不导致整批失败', async t => {
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

test('坏末项和无效重复项整批拒绝，无部分写入', async t => {
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

test('请求成功后事务中止仍拒绝并原子回滚，随后可以重试', async t => {
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

test('意外主键 ConstraintError 不是重复词，整批回滚而不吞错', async t => {
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

test('同步配额错误友好拒绝并回滚，不污染后续写入', async t => {
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

test('打开失败不永久缓存 rejected promise，再次调用可以打开', async t => {
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

test('打开请求异步失败后也可重试，不删除或降级词库', async t => {
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

test('blocked 及时拒绝，迟到的打开连接被关闭，重试仍可成功', { timeout: 5000 }, async t => {
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

test('打开中 close 取消等待，后续操作可重新打开', async t => {
  const store = createWordStore({ name: 'close-opening', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const pending = store.list();
  const closing = store.close();
  await assert.rejects(pending, /连接已关闭/);
  await closing;
  assert.deepEqual(await store.list(), []);
});

test('close 等待进行中的写事务完成，不丢失已提交数据', async t => {
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

test('versionchange 主动释放旧连接，后续版本错误明确拒绝', { timeout: 5000 }, async t => {
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

test('非预期连接关闭清除缓存，重新打开后数据仍在', async t => {
  const factory = new IDBFactory();
  let connection: IDBDatabase | undefined;
  let opens = 0;
  observeConnections(factory, db => { connection = db; opens++; });
  const store = createWordStore({ name: 'forced-close', indexedDB: factory });
  t.after(() => store.close());
  const original = await store.save(sample);
  assert.ok(connection);
  const closed = new Promise<void>(resolve => connection!.addEventListener('close', () => resolve(), { once: true }));
  // fake-indexeddb 6 的声明误写为构造器，运行时实际接收数据库实例。
  (forceCloseDatabase as unknown as (db: IDBDatabase) => void)(connection);
  await closed;
  assert.deepEqual(await store.list(), [original]);
  assert.equal(opens, 2);
});
