import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MAX_CATEGORIES, type CategoryChange, type ImportBatch } from '../src/categories';
import { createEntry, validateDatedEntry } from '../src/entry';
import { createWordStore } from '../src/storage';

const created = '2024-02-29T12:34:56.789Z';
const entry = (word: string, categories: string[] = []) => ({ ...createEntry(word), created, categories });
const code = (value: string) => ({ name: 'MessageError', detail: { code: value } });

function openDatabase(factory: IDBFactory, name: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Unexpected blocked database'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

function rawRecords(db: IDBDatabase, name = 'words'): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(name).objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function observeTransactions(factory: IDBFactory, observe: (transaction: IDBTransaction) => void) {
  const open = factory.open.bind(factory);
  factory.open = (name, version) => {
    const request = open(name, version);
    request.addEventListener('success', () => {
      const db = request.result;
      const transact = db.transaction.bind(db);
      db.transaction = (...args: Parameters<IDBDatabase['transaction']>) => {
        const transaction = transact(...args);
        observe(transaction);
        return transaction;
      };
    });
    return request;
  };
}

async function seedV1(factory: IDBFactory, name: string) {
  const db = await openDatabase(factory, name, 1, database => {
    const words = database.createObjectStore('words', { keyPath: 'id', autoIncrement: true });
    words.createIndex('word', 'word', { unique: true });
  });
  const values = [
    { ...createEntry('first'), created, id: 3, source: '  Historical source | MyMemory（机器翻译）  ' },
    { ...createEntry('last'), created: '2020-01-01T00:00:00.000Z', id: 9, phonetic: ' /raw/ ' },
  ];
  const transaction = db.transaction('words', 'readwrite');
  const words = transaction.objectStore('words');
  values.forEach(value => words.add(value));
  words.add({ ...createEntry('deleted'), created, id: 90 });
  words.delete(90);
  await completed(transaction);
  db.close();
  return values;
}

test('v1 upgrade preserves raw records, dates, IDs, order and generator without backfilling categoryIds', async t => {
  const factory = new IDBFactory();
  const values = await seedV1(factory, 'migration');
  const store = createWordStore({ name: 'migration', indexedDB: factory });
  t.after(() => store.close());
  assert.deepEqual(await store.snapshot(), {
    words: values.map(value => ({ ...validateDatedEntry(value), id: value.id, categoryIds: [] })).reverse(), categories: [],
  });
  const db = await openDatabase(factory, 'migration', 2);
  t.after(() => db.close());
  assert.deepEqual(await rawRecords(db), values, 'Reading legacy records must not backfill or trim them');
  assert.equal((await store.save(createEntry('next'))).id, 91);
  assert.deepEqual((await rawRecords(db)).slice(0, 2), values);
  assert.equal((await store.createCategory('Empty')).id, 1);
  await assert.rejects(openDatabase(factory, 'migration', 1), { name: 'VersionError' });
  assert.deepEqual((await store.snapshot()).categories, [{ id: 1, name: 'Empty' }]);
});

test('a failed upgrade rolls back the added store without losing v1 data or key-generator state and can retry', async t => {
  const factory = new IDBFactory();
  const values = await seedV1(factory, 'failed-upgrade');
  const open = factory.open.bind(factory);
  let fail = true;
  factory.open = (name, version) => {
    const request = open(name, version);
    if (version === 2 && fail) {
      fail = false;
      request.addEventListener('upgradeneeded', () => {
        const db = request.result;
        const create = db.createObjectStore.bind(db);
        db.createObjectStore = (...args: Parameters<IDBDatabase['createObjectStore']>) => {
          create(...args);
          throw new DOMException('Synthetic failed schema upgrade', 'QuotaExceededError');
        };
      });
    }
    return request;
  };
  const store = createWordStore({ name: 'failed-upgrade', indexedDB: factory });
  t.after(() => store.close());
  await assert.rejects(store.snapshot(), code('storageQuota'));
  const legacy = await openDatabase(factory, 'failed-upgrade', 1);
  assert.deepEqual([...legacy.objectStoreNames], ['words']);
  assert.deepEqual(await rawRecords(legacy), values);
  legacy.close();
  assert.equal((await store.snapshot()).words.length, 2);
  assert.equal((await store.save(createEntry('next'))).id, 91);
});

test('empty category CRUD persists, case-only rename keeps its ID, and concurrent normalized duplicates reject once', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'category-crud', indexedDB: factory });
  const peer = createWordStore({ name: 'category-crud', indexedDB: factory });
  t.after(() => Promise.all([store.close(), peer.close()]));
  const first = await store.createCategory(' Café ');
  const second = await store.createCategory('__proto__');
  assert.deepEqual(first, { id: 1, name: 'Café' });
  assert.deepEqual(await store.snapshot(), { words: [], categories: [first, second] });
  await store.close();
  assert.deepEqual((await store.snapshot()).categories, [first, second]);
  assert.deepEqual(await store.renameCategory(first.id, 'CAFÉ'), { id: first.id, name: 'CAFÉ' });
  await assert.rejects(store.renameCategory(second.id, 'café'), code('duplicateCategory'));
  await assert.rejects(store.renameCategory(999, 'Missing'), code('categoryMissing'));
  const outcomes = await Promise.allSettled([store.createCategory('Travel'), peer.createCategory(' TRAVEL ')]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const failed = outcomes.find(value => value.status === 'rejected');
  assert.deepEqual(failed?.reason.detail, { code: 'duplicateCategory' });
  await store.deleteCategory(second.id);
  await store.deleteCategory(second.id);
  assert.deepEqual((await peer.snapshot()).categories.map(value => value.id), [1, 3]);
});

test('snapshots read both stores in one readonly transaction and remain detached from persistent arrays', async t => {
  const factory = new IDBFactory();
  const transactions: { mode: IDBTransactionMode; names: string[] }[] = [];
  observeTransactions(factory, transaction => transactions.push({ mode: transaction.mode, names: [...transaction.objectStoreNames] }));
  const store = createWordStore({ name: 'snapshot', indexedDB: factory });
  t.after(() => store.close());
  const category = await store.createCategory('Topic');
  const original = await store.save(createEntry('word'), [category.id]);
  transactions.length = 0;
  const snapshot = await store.snapshot();
  assert.deepEqual(transactions, [{ mode: 'readonly', names: ['categories', 'words'] }]);
  snapshot.words[0].categoryIds.length = 0;
  snapshot.words[0].source = 'Not persistent';
  snapshot.categories[0].name = 'Not persistent';
  assert.deepEqual(await store.snapshot(), { words: [original], categories: [category] });
  transactions.length = 0;
  assert.deepEqual(await store.list(), [original]);
  assert.deepEqual(transactions, [{ mode: 'readonly', names: ['categories', 'words'] }]);
});

test('relationship changes count distinct selected IDs and missing words, without imposing a word-selection limit', async t => {
  const store = createWordStore({ name: 'changes', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const categories = await Promise.all(['One', 'Two', 'Three'].map(name => store.createCategory(name)));
  const [one, two, three] = categories.map(category => category.id);
  const first = await store.save(createEntry('first'), [one]);
  const second = await store.save(createEntry('second'), [two]);
  const selected = [first.id, first.id, second.id, 100];
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'add', categoryIds: [two, one, two] }), { changed: 2, unchanged: 0, missing: 1 });
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'add', categoryIds: [one, two] }), { changed: 0, unchanged: 2, missing: 1 });
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'remove', categoryIds: [one] }), { changed: 2, unchanged: 0, missing: 1 });
  assert.deepEqual((await store.list()).map(value => value.categoryIds), [[two], [two]]);
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'replace', categoryIds: [three] }), { changed: 2, unchanged: 0, missing: 1 });
  assert.deepEqual((await store.list()).map(value => value.categoryIds), [[three], [three]]);
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'clear' }), { changed: 2, unchanged: 0, missing: 1 });
  assert.deepEqual(await store.updateWordCategories(selected, { mode: 'clear' }), { changed: 0, unchanged: 2, missing: 1 });
  assert.deepEqual(await store.updateWordCategories(Array.from({ length: 1002 }, (_, index) => index + 10), { mode: 'clear' }), { changed: 0, unchanged: 0, missing: 1002 });
  await store.remove(first.id);
  await store.remove(second.id);
  assert.deepEqual((await store.snapshot()).categories, categories, 'Removing the final word must retain empty categories');
});

test('bulk add reads latest peer content and relations, and a stale ID cannot resurrect a deleted and readded word', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'latest', indexedDB: factory });
  const right = createWordStore({ name: 'latest', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  const first = await left.createCategory('First');
  const second = await right.createCategory('Second');
  const original = await left.save(createEntry('shared'), [first.id]);
  const removed = await left.save(createEntry('removed'));
  await left.snapshot();
  const replacement = { ...entry('shared'), source: 'Latest peer source', translation: 'Latest peer translation' };
  await right.importEntries({ categories: [], entries: [replacement] }, { overwriteExisting: true });
  await right.updateWordCategories([original.id], { mode: 'replace', categoryIds: [second.id] });
  await right.remove(removed.id);
  const fresh = await right.save(createEntry('removed'), [second.id]);
  assert.deepEqual(await left.updateWordCategories([original.id, removed.id], { mode: 'add', categoryIds: [first.id] }), { changed: 1, unchanged: 0, missing: 1 });
  assert.deepEqual(await left.list(), [fresh, {
    ...validateDatedEntry(replacement), id: original.id, categoryIds: [first.id, second.id],
  }]);
});

test('classification-only writes preserve the exact raw lexical fields, source attribution and unrelated metadata', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'raw-source', indexedDB: factory });
  t.after(() => store.close());
  const first = await store.createCategory('First');
  const second = await store.createCategory('Second');
  const db = await openDatabase(factory, 'raw-source', 2);
  t.after(() => db.close());
  const raw = {
    word: 'historical', phonetic: ' /raw/ ', translation: '  合成译文  ', pos: '\tNoun\t',
    definition: '\nOriginal definition.\n', example: '\r\nOriginal example.\r\n',
    source: '  dictionary | MyMemory（机器翻译） | 原始备注  ', created, id: 42, extra: { keep: 'unchanged' },
  };
  const transaction = db.transaction('words', 'readwrite');
  transaction.objectStore('words').add(raw);
  await completed(transaction);
  await store.updateWordCategories([42], { mode: 'add', categoryIds: [first.id] });
  assert.deepEqual(await rawRecords(db), [{ ...raw, categoryIds: [first.id] }]);
  await store.importEntries({ categories: ['Second'], entries: [entry('historical', ['Second'])] });
  assert.deepEqual(await rawRecords(db), [{ ...raw, categoryIds: [first.id, second.id] }]);
  await store.renameCategory(first.id, 'Renamed');
  assert.deepEqual(await rawRecords(db), [{ ...raw, categoryIds: [first.id, second.id] }]);
  await store.deleteCategory(first.id);
  assert.deepEqual(await rawRecords(db), [{ ...raw, categoryIds: [second.id] }]);
  await store.updateWordCategories([42], { mode: 'clear' });
  assert.deepEqual(await rawRecords(db), [{ ...raw, categoryIds: [] }]);
});

test('a deleted target category rejects save, all targeted bulk modes and imports rather than silently recreating it', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'stale-target', indexedDB: factory });
  const peer = createWordStore({ name: 'stale-target', indexedDB: factory });
  t.after(() => Promise.all([left.close(), peer.close()]));
  const target = await left.createCategory('Target');
  const word = await left.save(createEntry('word'), [target.id]);
  await peer.deleteCategory(target.id);
  const newTarget = await peer.createCategory('Target');
  assert.notEqual(target.id, newTarget.id);
  const before = await left.snapshot();
  await assert.rejects(left.save(createEntry('new'), [target.id]), code('categoryMissing'));
  for (const mode of ['add', 'remove', 'replace'] as const) {
    await assert.rejects(left.updateWordCategories([word.id], { mode, categoryIds: [target.id] }), code('categoryMissing'));
    await assert.rejects(left.updateWordCategories([], { mode, categoryIds: [target.id] }), code('categoryMissing'));
  }
  await assert.rejects(left.importEntries({ categories: ['Target', 'Must roll back'], entries: [entry('new')] }, { selectedCategoryIds: [target.id] }), code('categoryMissing'));
  assert.deepEqual(await left.snapshot(), before);
});

for (const connection of ['cold', 'warm']) {
  test(`${connection} saves, bulk changes and imports snapshot input arrays and options before opening or awaiting`, async t => {
    const store = createWordStore({ name: `snapshots-${connection}`, indexedDB: new IDBFactory() });
    t.after(() => store.close());
    const first = await store.createCategory('First');
    const second = await store.createCategory('Second');
    const cool = async () => { if (connection === 'cold') await store.close(); };
    await cool();
    const selected = [first.id];
    const draft = { ...createEntry('word'), source: 'Original source' };
    const saving = store.save(draft, selected);
    selected[0] = second.id;
    draft.source = 'Mutated';
    const saved = await saving;
    assert.deepEqual(saved.categoryIds, [first.id]);
    assert.equal(saved.source, 'Original source');
    await cool();
    const wordIds = [saved.id];
    const change: CategoryChange = { mode: 'replace', categoryIds: [second.id] };
    const updating = store.updateWordCategories(wordIds, change);
    wordIds[0] = 999;
    (change.categoryIds as number[])[0] = first.id;
    change.mode = 'remove';
    assert.deepEqual(await updating, { changed: 1, unchanged: 0, missing: 0 });
    assert.deepEqual((await store.list())[0].categoryIds, [second.id]);
    await cool();
    const batch = { categories: ['Imported'], entries: [{ ...entry('word', ['Imported']), source: 'Incoming' }] };
    const options = { overwriteExisting: false, selectedCategoryIds: [first.id] };
    const importing = store.importEntries(batch, options);
    batch.categories[0] = 'Mutated';
    batch.entries[0].categories.length = 0;
    batch.entries[0].source = 'Mutated';
    batch.entries.push(entry('other'));
    options.overwriteExisting = true;
    options.selectedCategoryIds[0] = 999;
    assert.deepEqual(await importing, { imported: 0, updated: 0, skipped: 1, classified: 1, categoriesCreated: 1 });
    const snapshot = await store.snapshot();
    assert.equal(snapshot.words.length, 1);
    assert.equal(snapshot.words[0].source, 'Original source');
    assert.deepEqual(snapshot.words[0].categoryIds, [first.id, second.id, 3]);
    assert.deepEqual(snapshot.categories[2], { id: 3, name: 'Imported' });
  });
}

for (const overwriteExisting of [false, true]) {
  test(`imports union local, file and selected categories with accurate independent counts, overwrite=${overwriteExisting}`, async t => {
    const store = createWordStore({ name: `union-${overwriteExisting}`, indexedDB: new IDBFactory() });
    t.after(() => store.close());
    const local = await store.createCategory('Local');
    const shared = await store.createCategory('Shared');
    const selected = await store.createCategory('Selected');
    const original = await store.save({ ...createEntry('existing'), source: 'Preserve original content' }, [local.id]);
    const first = { ...entry('existing', ['SHARED']), source: 'Incoming attribution', translation: 'Incoming' };
    const batch = {
      categories: ['shared', '__proto__', 'Empty', 'Later only'],
      entries: [first, entry('fresh', ['__proto__']), entry('fresh', ['Later only']), entry('existing', ['Later only'])],
    };
    assert.deepEqual(await store.importEntries(batch, { overwriteExisting, selectedCategoryIds: [selected.id] }), {
      imported: 1, updated: Number(overwriteExisting), skipped: 2 + Number(!overwriteExisting), classified: 2, categoriesCreated: 3,
    });
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.categories.map(value => value.name), ['Local', 'Shared', 'Selected', '__proto__', 'Empty', 'Later only']);
    assert.deepEqual(snapshot.words, [
      { ...validateDatedEntry(entry('fresh')), id: 2, categoryIds: [selected.id, 4] },
      { ...(overwriteExisting ? validateDatedEntry(first) : original), id: original.id, categoryIds: [local.id, shared.id, selected.id] },
    ]);
    assert.deepEqual(await store.importEntries(batch, { overwriteExisting, selectedCategoryIds: [selected.id] }), {
      imported: 0, updated: overwriteExisting ? 2 : 0, skipped: overwriteExisting ? 2 : 4, classified: 0, categoriesCreated: 0,
    });
    const before = (await store.list()).map(value => value.categoryIds);
    await store.importEntries({ categories: [], entries: [entry('existing'), entry('fresh')] }, { overwriteExisting });
    assert.deepEqual((await store.list()).map(value => value.categoryIds), before, 'A v1-style empty directory cannot remove categories');
    assert.deepEqual(await store.importEntries({ categories: ['Only empty'], entries: [] }), {
      imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 1,
    });
  });
}

test('concurrent imports reuse normalized category IDs, preserve local names and merge all relationships', async t => {
  const factory = new IDBFactory();
  const left = createWordStore({ name: 'concurrent-categories', indexedDB: factory });
  const right = createWordStore({ name: 'concurrent-categories', indexedDB: factory });
  t.after(() => Promise.all([left.close(), right.close()]));
  const batches = [
    { categories: ['Shared', 'Left'], entries: [entry('word', ['Shared', 'Left'])] },
    { categories: ['SHARED', 'Right'], entries: [entry('word', ['SHARED', 'Right'])] },
  ];
  const counts = await Promise.all([left.importEntries(batches[0]), right.importEntries(batches[1])]);
  assert.equal(counts.reduce((sum, count) => sum + count.categoriesCreated, 0), 3);
  assert.equal(counts.reduce((sum, count) => sum + count.imported, 0), 1);
  assert.equal(counts.reduce((sum, count) => sum + count.skipped, 0), 1);
  assert.equal(counts.reduce((sum, count) => sum + count.classified, 0), 2);
  const snapshot = await left.snapshot();
  assert.equal(snapshot.categories.length, 3);
  assert.deepEqual(snapshot.words[0].categoryIds, snapshot.categories.map(value => value.id));
  assert.deepEqual(await right.snapshot(), snapshot);
});

test('category capacity is enforced on the merged library inside the transaction, including empty directories', async t => {
  const factory = new IDBFactory();
  const store = createWordStore({ name: 'capacity', indexedDB: factory });
  const peer = createWordStore({ name: 'capacity', indexedDB: factory });
  t.after(() => Promise.all([store.close(), peer.close()]));
  const categories = Array.from({ length: MAX_CATEGORIES - 1 }, (_, index) => `Topic ${index}`);
  const counts = await store.importEntries({ categories, entries: [] });
  assert.equal(counts.categoriesCreated, 999);
  const outcomes = await Promise.allSettled([store.createCategory('Final left'), peer.createCategory('Final right')]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.deepEqual(outcomes.find(value => value.status === 'rejected')?.reason.detail, { code: 'tooManyCategories' });
  const before = await store.snapshot();
  await assert.rejects(store.importEntries({ categories: ['Overflow'], entries: [entry('must not persist')] }), code('tooManyCategories'));
  assert.deepEqual(await store.snapshot(), before);
  assert.equal((await store.importEntries({ categories, entries: [] })).categoriesCreated, 0);
  const all = before.categories.map(value => value.id);
  const word = await store.save(createEntry('full'), all);
  assert.deepEqual(await store.updateWordCategories([word.id], { mode: 'add', categoryIds: all }), { changed: 0, unchanged: 1, missing: 0 });
});

test('category-only transaction failure rolls back category deletion and successful word-reference updates together', async t => {
  const factory = new IDBFactory();
  let abort = false;
  let updated = 0;
  observeTransactions(factory, transaction => {
    if (!abort || transaction.mode !== 'readwrite') return;
    const words = transaction.objectStore('words');
    const cursor = words.openCursor.bind(words);
    words.openCursor = (...args: Parameters<IDBObjectStore['openCursor']>) => {
      const request = cursor(...args);
      request.addEventListener('success', () => {
        if (!request.result) return;
        const update = request.result.update.bind(request.result);
        request.result.update = (value: unknown) => {
          const write = update(value);
          write.addEventListener('success', () => { updated++; transaction.abort(); });
          return write;
        };
      });
      return request;
    };
  });
  const store = createWordStore({ name: 'delete-rollback', indexedDB: factory });
  t.after(() => store.close());
  const category = await store.createCategory('Keep');
  await store.save(createEntry('first'), [category.id]);
  await store.save(createEntry('second'), [category.id]);
  const before = await store.snapshot();
  abort = true;
  await assert.rejects(store.deleteCategory(category.id), code('storageAborted'));
  assert.equal(updated, 1);
  abort = false;
  assert.deepEqual(await store.snapshot(), before);
  await store.close();
  assert.deepEqual(await store.snapshot(), before);
  await store.deleteCategory(category.id);
  assert.deepEqual(await store.snapshot(), { words: before.words.map(word => ({ ...word, categoryIds: [] })), categories: [] });
});

test('import failures after category and word successes roll back both stores and their generators before retry', async t => {
  const factory = new IDBFactory();
  let abort = false;
  const events: string[] = [];
  observeTransactions(factory, transaction => {
    if (!abort || transaction.mode !== 'readwrite') return;
    for (const name of ['categories', 'words']) {
      const objectStore = transaction.objectStore(name);
      const add = objectStore.add.bind(objectStore);
      objectStore.add = (...args: Parameters<IDBObjectStore['add']>) => {
        const request = add(...args);
        request.addEventListener('success', () => {
          events.push(name);
          if (name === 'words') transaction.abort();
        });
        return request;
      };
    }
  });
  const store = createWordStore({ name: 'import-rollback', indexedDB: factory });
  t.after(() => store.close());
  const existing = await store.save(createEntry('existing'));
  const batch = { categories: ['Imported', 'Empty'], entries: [entry('existing', ['Imported']), entry('new', ['Imported'])] };
  abort = true;
  await assert.rejects(store.importEntries(batch, { overwriteExisting: true }), code('storageAborted'));
  assert.deepEqual(events, ['categories', 'categories', 'words']);
  abort = false;
  await store.close();
  assert.deepEqual(await store.snapshot(), { words: [existing], categories: [] });
  assert.deepEqual(await store.importEntries(batch, { overwriteExisting: true }), { imported: 1, updated: 1, skipped: 0, classified: 2, categoriesCreated: 2 });
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.categories.map(value => value.id), [1, 2]);
  assert.deepEqual(snapshot.words.map(value => value.id), [2, 1]);
});

test('invalid inputs including later duplicate references reject before opening a database', async () => {
  const factory = new IDBFactory();
  let opens = 0;
  factory.open = () => { opens++; throw new Error('Must not open'); };
  const store = createWordStore({ name: 'prevalidate', indexedDB: factory });
  await assert.rejects(store.save(createEntry('word'), [0]), code('invalidCategoryIds'));
  await assert.rejects(store.createCategory(''), code('invalidCategoryName'));
  await assert.rejects(store.renameCategory(0, 'Name'), code('storageInvalidId'));
  await assert.rejects(store.deleteCategory(NaN), code('storageInvalidId'));
  await assert.rejects(store.updateWordCategories([1, , 2] as number[], { mode: 'clear' }), code('storageInvalidId'));
  await assert.rejects(store.updateWordCategories([1], { mode: 'add', categoryIds: [] }), code('invalidCategoryChange'));
  await assert.rejects(store.importEntries({ categories: [], entries: [entry('word'), entry('word', ['Missing'])] }), code('categoryMissing'));
  await assert.rejects(store.importEntries({ categories: [], entries: [] }, { selectedCategoryIds: [0] }), code('invalidCategoryIds'));
  await assert.rejects(store.importEntries([] as unknown as ImportBatch), code('invalidImportBatch'));
  assert.equal(opens, 0);
  await store.close();
});

test('corrupt relationships are not silently interpreted as uncategorized and corrupted lexical fields reject as storage records', async t => {
  for (const corrupt of [
    { categoryIds: null }, { categoryIds: undefined }, { categoryIds: [0] }, { categoryIds: [999] },
    { categoryIds: new Array(1) }, { categoryIds: '1' }, { source: null }, { created: 'invalid' },
  ]) {
    const factory = new IDBFactory();
    const store = createWordStore({ name: 'corrupt', indexedDB: factory });
    t.after(() => store.close());
    const original = await store.save(createEntry('word'));
    const db = await openDatabase(factory, 'corrupt', 2);
    t.after(() => db.close());
    const raw = { ...original, ...corrupt };
    const transaction = db.transaction('words', 'readwrite');
    transaction.objectStore('words').put(raw);
    await completed(transaction);
    await assert.rejects(store.snapshot(), code('storageInvalidRecord'));
    await assert.rejects(store.updateWordCategories([original.id], { mode: 'clear' }), code('storageInvalidRecord'));
    await assert.rejects(store.importEntries({ categories: ['Must roll back'], entries: [entry('word')] }), code('storageInvalidRecord'));
    assert.deepEqual(await rawRecords(db), [raw]);
    assert.deepEqual(await rawRecords(db, 'categories'), []);
  }
});

test('corrupt category names or internal unique keys reject snapshots without rewriting storage', async t => {
  for (const raw of [
    { id: 1, name: 'Valid', normalizedName: 'wrong' }, { id: 1, name: ' Untrimmed ', normalizedName: 'untrimmed' },
    { id: 1, name: '', normalizedName: '' }, { id: -1, name: 'Valid', normalizedName: 'valid' },
  ]) {
    const factory = new IDBFactory();
    const store = createWordStore({ name: 'bad-directory', indexedDB: factory });
    t.after(() => store.close());
    await store.snapshot();
    const db = await openDatabase(factory, 'bad-directory', 2);
    t.after(() => db.close());
    const transaction = db.transaction('categories', 'readwrite');
    transaction.objectStore('categories').put(raw);
    await completed(transaction);
    await assert.rejects(store.snapshot(), code('storageInvalidRecord'));
    assert.deepEqual(await rawRecords(db, 'categories'), [raw]);
  }
});
