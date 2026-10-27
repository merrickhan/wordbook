import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntry, sample, type DatedEntry } from '../src/entry';
import { MAX_CATEGORIES, type ImportBatch } from '../src/categories';
import { MAX_BACKUP_ENTRIES } from '../src/backup';
import { MessageError, type Message } from '../src/messages';
import { createTestDatabase, createTestStore, dumpTables, injectedFailure } from './helpers/database';

const created = '2026-09-28T08:00:00.000Z';
const earlier = '2024-02-29T12:34:56.789Z';
const dated = (word: string, extra: Partial<DatedEntry> = {}): DatedEntry => ({ ...createEntry(word), created: earlier, ...extra });
const batch = (entries: readonly DatedEntry[], categories: readonly string[] = [], references: readonly string[] = []): ImportBatch => ({
  categories, entries: entries.map(entry => ({ ...entry, categories: references })),
});
const code = (detail: Message) => (error: unknown) => {
  assert.ok(error instanceof MessageError, String(error));
  assert.deepEqual(error.detail, detail);
  return true;
};

test('saving trims seven fields, uses the injected time, lists newest first and rejects normalized duplicates', async () => {
  const store = await createTestStore({ now: () => new Date(created) });
  const first = await store.save({ ...sample, word: '  Investigation ', translation: ' 调查 ' });
  assert.deepEqual(first, { ...sample, translation: '调查', created, id: 1, categoryIds: [] });
  const second = await store.save(createEntry('apple'));
  assert.deepEqual((await store.list()).map(entry => entry.id), [second.id, first.id]);
  await assert.rejects(store.save({ ...sample, word: ' INVESTIGATION ', translation: 'changed' }),
    code({ code: 'duplicateWord', params: { word: 'investigation' } }));
  assert.equal((await store.list()).find(entry => entry.word === 'investigation')?.translation, '调查');
});

test('invalid entries and clocks reject before any write and do not block later operations', async () => {
  const store = await createTestStore({ now: () => new Date(Number.NaN) });
  await assert.rejects(store.save({ ...sample, word: '' }), code({ code: 'invalidWord' }));
  await assert.rejects(store.save({ ...sample, example: 1 }), code({ code: 'invalidFields' }));
  await assert.rejects(store.save(sample), code({ code: 'invalidClock' }));
  assert.deepEqual(store.db.modes, []);
  const valid = await createTestStore({ db: store.db, now: () => new Date(created) });
  assert.equal((await valid.save(sample)).created, created);
});

test('deletion by ID is idempotent, rejects invalid IDs without coercion and keeps other words', async () => {
  const store = await createTestStore();
  const apple = await store.save(createEntry('apple'));
  const pear = await store.save(createEntry('pear'));
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1', null] as unknown[])
    await assert.rejects(store.remove(id), code({ code: 'storageInvalidId' }));
  await store.remove(Number.MAX_SAFE_INTEGER);
  await store.remove(apple.id);
  await store.remove(apple.id);
  assert.deepEqual(await store.list(), [pear]);
});

test('a deleted and re-added word gets a new ID that a stale deletion cannot remove', async () => {
  const store = await createTestStore();
  const peer = await createTestStore({ db: store.db });
  const old = await store.save(createEntry('apple'));
  await peer.remove(old.id);
  const fresh = await peer.save(createEntry('apple'));
  assert.notEqual(fresh.id, old.id);
  await store.remove(old.id);
  assert.deepEqual(await store.list(), [fresh]);
});

test('concurrent saves of the same normalized word succeed only once', async () => {
  const store = await createTestStore();
  const results = await Promise.allSettled([store.save(createEntry('apple')), store.save({ ...sample, word: 'Apple ' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && code({ code: 'duplicateWord', params: { word: 'apple' } })(rejected.reason));
  assert.equal((await store.list()).length, 1);
});

test('imports keep existing words and the first file occurrence by default, retaining dates', async () => {
  const store = await createTestStore({ now: () => new Date(created) });
  const local = await store.save({ ...createEntry('apple'), translation: 'local' });
  const result = await store.importEntries(batch([
    dated('apple', { translation: 'file' }), dated('pear', { translation: 'first' }), dated('pear', { translation: 'second' }),
  ]));
  assert.deepEqual(result, { imported: 1, updated: 0, skipped: 2, classified: 0, categoriesCreated: 0 });
  const words = await store.list();
  assert.deepEqual(words.map(entry => [entry.word, entry.translation, entry.created]),
    [['pear', 'first', earlier], ['apple', 'local', created]]);
  assert.equal(words[1].id, local.id);
});

test('only overwriteExisting === true replaces content, including blanks and dates, keeping IDs and order', async () => {
  for (const overwriteExisting of [undefined, false, 'true', 1, {}]) {
    const store = await createTestStore();
    await store.importEntries(batch([dated('apple', { translation: 'old' })]));
    const result = await store.importEntries(batch([dated('apple', { translation: 'new' })]), { overwriteExisting });
    assert.equal(result.updated, 0);
    assert.equal((await store.list())[0].translation, 'old');
  }
  const store = await createTestStore();
  await store.importEntries(batch([dated('apple', { translation: 'old', example: 'kept?' }), dated('pear')]));
  const before = await store.list();
  const replacement = dated('apple', { translation: 'new', example: '', source: 'Raw | source', created });
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(await store.importEntries(batch([replacement, dated('plum')]), { overwriteExisting: true }),
      round ? { imported: 0, updated: 2, skipped: 0, classified: 0, categoriesCreated: 0 }
        : { imported: 1, updated: 1, skipped: 0, classified: 0, categoriesCreated: 0 });
  }
  const after = await store.list();
  assert.deepEqual(after.map(entry => entry.id), [3, before[0].id, before[1].id]);
  const apple = after.find(entry => entry.word === 'apple');
  assert.deepEqual(apple, { ...replacement, id: before[1].id, categoryIds: [] });
});

test('invalid batches, options and oversized imports reject before opening a transaction', async () => {
  const store = await createTestStore();
  const sparse = [dated('apple')];
  sparse.length = 2;
  for (const value of [
    null, {}, { categories: [], entries: 'x' }, batch([dated('apple'), { ...dated('pear'), created: 'yesterday' }]),
    { categories: [], entries: sparse.map(entry => entry && { ...entry, categories: [] }) },
    batch([dated('apple')], [], ['Undeclared']), batch([], ['Same', ' same ']),
  ]) await assert.rejects(store.importEntries(value as ImportBatch));
  await assert.rejects(store.importEntries(batch([dated('apple')]), { selectedCategoryIds: [0] }), code({ code: 'invalidCategoryIds' }));
  const many = batch(Array.from({ length: MAX_BACKUP_ENTRIES + 1 }, (_, index) => dated('w' + 'a'.repeat(index % 70) + String.fromCharCode(97 + (index % 26)))));
  await assert.rejects(store.importEntries(many), code({ code: 'backupTooManyEntries' }));
  assert.deepEqual(store.db.modes, []);
});

for (const statement of [/^\s*UPDATE words/, /INSERT INTO words/, /INSERT INTO word_categories/, /INSERT INTO categories/]) {
  test(`a failure at ${statement.source} rolls back the whole import and permits a complete retry`, async () => {
    const store = await createTestStore();
    const reading = await store.createCategory('Reading');
    await store.importEntries(batch([dated('apple', { translation: 'old' })]));
    const before = await dumpTables(store.db);
    const value = batch([dated('apple', { translation: 'new' }), dated('pear')], ['Reading', 'New topic'], ['Reading', 'New topic']);
    store.db.failOn(statement);
    await assert.rejects(store.importEntries(value, { overwriteExisting: true, selectedCategoryIds: [reading.id] }),
      code({ code: 'storageUnavailable' }));
    assert.deepEqual(await dumpTables(store.db), before);
    assert.deepEqual(await store.importEntries(value, { overwriteExisting: true, selectedCategoryIds: [reading.id] }),
      { imported: 1, updated: 1, skipped: 0, classified: 2, categoriesCreated: 1 });
  });
}

test('constraint violations surface as storageConstraint and roll back', async () => {
  const store = await createTestStore();
  await store.save(createEntry('apple'));
  store.db.failOn(/INSERT INTO words/, Object.assign(new Error('unique'), { code: '23505' }));
  await assert.rejects(store.importEntries(batch([dated('pear')])), code({ code: 'storageConstraint' }));
  assert.deepEqual((await store.list()).map(entry => entry.word), ['apple']);
});

test('category CRUD keeps IDs, rejects normalized duplicates and deletes only relationships with a category', async () => {
  const store = await createTestStore();
  const reading = await store.createCategory('  Reading ');
  assert.deepEqual(reading, { id: 1, name: 'Reading' });
  await assert.rejects(store.createCategory('reading'), code({ code: 'duplicateCategory' }));
  assert.deepEqual(await store.renameCategory(reading.id, 'READING'), { id: reading.id, name: 'READING' });
  const travel = await store.createCategory('Travel');
  await assert.rejects(store.renameCategory(travel.id, 'reading'), code({ code: 'duplicateCategory' }));
  await assert.rejects(store.renameCategory(99, 'Other'), code({ code: 'categoryMissing' }));
  await assert.rejects(store.createCategory('bad\u0000name'), code({ code: 'invalidCategoryName' }));
  const apple = await store.save(createEntry('apple'), [travel.id, reading.id, reading.id]);
  assert.deepEqual(apple.categoryIds, [reading.id, travel.id]);
  await store.deleteCategory(reading.id);
  await store.deleteCategory(reading.id);
  assert.deepEqual(await store.snapshot(), { words: [{ ...apple, categoryIds: [travel.id] }], categories: [travel] });
});

test('category capacity is enforced for creation and merged imports, counting empty categories', async () => {
  const db = await createTestDatabase();
  const store = await createTestStore({ db });
  await store.createCategory('seed');
  await db.query(`INSERT INTO categories (name, normalized_name)
    SELECT 'c' || n, 'c' || n FROM generate_series(1, ${MAX_CATEGORIES - 2}) AS n`);
  await store.importEntries(batch([], ['Last']));
  await assert.rejects(store.createCategory('Overflow'), code({ code: 'tooManyCategories' }));
  await assert.rejects(store.importEntries(batch([], ['Overflow'])), code({ code: 'tooManyCategories' }));
  assert.equal((await store.snapshot()).categories.length, MAX_CATEGORIES);
});

test('bulk classification counts distinct IDs and missing words, and never rewrites lexical columns', async () => {
  const store = await createTestStore();
  const [a, b] = [await store.createCategory('A'), await store.createCategory('B')];
  const apple = await store.save({ ...createEntry('apple'), source: 'Raw | source' }, [a.id]);
  const pear = await store.save(createEntry('pear'));
  const lexical = async () => (await dumpTables(store.db)).words;
  const before = await lexical();
  assert.deepEqual(await store.updateWordCategories([apple.id, pear.id, pear.id, 999], { mode: 'add', categoryIds: [a.id] }),
    { changed: 1, unchanged: 1, missing: 1 });
  assert.deepEqual(await store.updateWordCategories([apple.id, pear.id], { mode: 'replace', categoryIds: [b.id] }),
    { changed: 2, unchanged: 0, missing: 0 });
  assert.deepEqual(await store.updateWordCategories([apple.id], { mode: 'remove', categoryIds: [b.id] }),
    { changed: 1, unchanged: 0, missing: 0 });
  assert.deepEqual(await store.updateWordCategories([pear.id], { mode: 'clear' }), { changed: 1, unchanged: 0, missing: 0 });
  assert.deepEqual(await lexical(), before);
  await assert.rejects(store.updateWordCategories([apple.id], { mode: 'add', categoryIds: [] } as never), code({ code: 'invalidCategoryChange' }));
  await assert.rejects(store.updateWordCategories([0], { mode: 'clear' }), code({ code: 'storageInvalidId' }));
  assert.deepEqual(await store.updateWordCategories([], { mode: 'clear' }), { changed: 0, unchanged: 0, missing: 0 });
});

test('a stale word ID cannot resurrect or reclassify a deleted and re-added word', async () => {
  const store = await createTestStore();
  const topic = await store.createCategory('Topic');
  const old = await store.save(createEntry('apple'));
  await store.remove(old.id);
  const fresh = await store.save(createEntry('apple'));
  assert.deepEqual(await store.updateWordCategories([old.id], { mode: 'add', categoryIds: [topic.id] }),
    { changed: 0, unchanged: 0, missing: 1 });
  assert.deepEqual(await store.list(), [fresh]);
});

test('a deleted target category rejects saves, every targeted bulk mode and imports', async () => {
  const store = await createTestStore();
  const topic = await store.createCategory('Topic');
  const apple = await store.save(createEntry('apple'));
  await store.deleteCategory(topic.id);
  await assert.rejects(store.save(createEntry('pear'), [topic.id]), code({ code: 'categoryMissing' }));
  for (const mode of ['add', 'remove', 'replace'] as const)
    await assert.rejects(store.updateWordCategories([apple.id], { mode, categoryIds: [topic.id] }), code({ code: 'categoryMissing' }));
  await assert.rejects(store.importEntries(batch([dated('pear')]), { selectedCategoryIds: [topic.id] }), code({ code: 'categoryMissing' }));
  assert.deepEqual((await store.list()).map(entry => entry.word), ['apple']);
});

for (const overwriteExisting of [false, true]) {
  test(`imports union local, file and selected categories with independent counts, overwrite=${overwriteExisting}`, async () => {
    const store = await createTestStore();
    const local = await store.createCategory('Local');
    const selected = await store.createCategory('Selected');
    await store.save(createEntry('apple'), [local.id]);
    await store.save(createEntry('kiwi'), [local.id, selected.id]);
    const value = batch([dated('apple'), dated('kiwi'), dated('pear')], ['local', 'File', 'Empty'], ['File']);
    const first = await store.importEntries(value, { overwriteExisting, selectedCategoryIds: [selected.id] });
    assert.deepEqual(first, {
      imported: 1, updated: overwriteExisting ? 2 : 0, skipped: overwriteExisting ? 0 : 2, classified: 3, categoriesCreated: 2,
    });
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.categories.map(category => category.name), ['Local', 'Selected', 'File', 'Empty']);
    const byWord = new Map(snapshot.words.map(entry => [entry.word, entry.categoryIds]));
    assert.deepEqual(byWord.get('apple'), [1, 2, 3]);
    assert.deepEqual(byWord.get('kiwi'), [1, 2, 3]);
    assert.deepEqual(byWord.get('pear'), [2, 3]);
    const again = await store.importEntries(value, { overwriteExisting, selectedCategoryIds: [selected.id] });
    assert.equal(again.classified, 0);
    assert.equal(again.categoriesCreated, 0);
  });
}

test('concurrent overlapping imports serialize and reuse normalized category IDs', async () => {
  const store = await createTestStore();
  const peer = await createTestStore({ db: store.db });
  const results = await Promise.all([
    store.importEntries(batch([dated('apple'), dated('pear')], ['Topic'], ['Topic'])),
    peer.importEntries(batch([dated('pear'), dated('plum')], [' topic '], ['topic'])),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 3);
  assert.equal(results.reduce((sum, result) => sum + result.categoriesCreated, 0), 1);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.categories.length, 1);
  assert.ok(snapshot.words.every(entry => entry.categoryIds.length === 1));
});

test('snapshots use read-only transactions and are detached from later reads', async () => {
  const store = await createTestStore();
  await store.save(createEntry('apple'), [(await store.createCategory('Topic')).id]);
  store.db.modes.length = 0;
  const first = await store.snapshot();
  first.words[0].categoryIds.push(99);
  first.categories.length = 0;
  const second = await store.snapshot();
  assert.deepEqual(second.words[0].categoryIds, [1]);
  assert.equal(second.categories.length, 1);
  assert.deepEqual(store.db.modes, ['read', 'read']);
});

test('corrupt stored records reject reads as storage records without being rewritten', async () => {
  for (const corrupt of [
    "UPDATE categories SET name = ' padded'",
    "UPDATE categories SET normalized_name = 'other'",
    "UPDATE words SET word = 'APPLE'",
    "UPDATE words SET created = 'yesterday'",
  ]) {
    const store = await createTestStore();
    await store.save(createEntry('apple'), [(await store.createCategory('Topic')).id]);
    await store.db.query(corrupt);
    const before = await dumpTables(store.db);
    await assert.rejects(store.snapshot(), code({ code: 'storageInvalidRecord' }));
    assert.deepEqual(await dumpTables(store.db), before);
  }
});

test('database failures map to storageUnavailable while message errors pass through unchanged', async () => {
  const store = await createTestStore();
  await store.snapshot();
  const cause = injectedFailure();
  store.db.failOn(/FROM categories/, cause);
  await assert.rejects(store.snapshot(), error => code({ code: 'storageUnavailable' })(error) && (error as Error).cause === cause);
  const known = new MessageError({ code: 'duplicateWord', params: { word: 'x' } });
  store.db.failOn(/INSERT INTO words/, known);
  await assert.rejects(store.save(createEntry('apple')), error => error === known);
});
