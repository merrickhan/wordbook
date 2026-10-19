import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MAX_BACKUP_BYTES, MAX_BACKUP_ENTRIES, parseBackup, serializeBackup } from '../src/backup';
import { MAX_CATEGORIES, MAX_CATEGORY_NAME_LENGTH } from '../src/categories';
import type { Category, ImportBatch, LibrarySnapshot } from '../src/categories';
import { createEntry, sample, validateCreated } from '../src/entry';
import type { DatedEntry, StoredEntry } from '../src/entry';
import { MessageError } from '../src/messages';
import { createWordStore } from '../src/storage';

const exportedAt = '2026-09-28T08:00:00.000Z';
const created = '2024-02-29T12:34:56.789Z';
const entry: DatedEntry = { ...sample, created };
const stored: StoredEntry = { ...entry, id: 1, categoryIds: [] };
const envelope = (entries: unknown = [entry]) => ({ format: 'wordbook', version: 1, exportedAt, entries });
const unclassified = (entries: readonly DatedEntry[] = []): ImportBatch => ({
  categories: [], entries: entries.map(value => ({ ...value, categories: [] })),
});
const envelopeV2 = (entries: unknown = unclassified([entry]).entries, categories: unknown = []) =>
  ({ format: 'wordbook', version: 2, exportedAt, categories, entries });
const snapshot = (words: StoredEntry[] = [], categories: Category[] = []): LibrarySnapshot => ({ words, categories });
const hasCode = (code: string) => (error: unknown) => error instanceof MessageError && error.detail.code === code;

// Keep v1 fixtures separate: a legacy entry's category-looking extras must never become references.
test('v2 envelopes, business fields and dates round-trip in ascending ID order without exporting IDs', () => {
  const values = [
    { ...stored, word: 'third', id: 90, created: '2020-01-01T00:00:00.000Z' },
    { ...stored, word: 'first', id: 4, created: '2025-01-01T00:00:00.000Z' },
    { ...stored, word: 'second', id: 50, extra: 'ignored' },
  ];
  const original = structuredClone(values);
  const text = serializeBackup(snapshot(values), exportedAt);
  const backup = JSON.parse(text);
  assert.deepEqual(Object.keys(backup), ['format', 'version', 'exportedAt', 'categories', 'entries']);
  assert.equal(backup.format, 'wordbook');
  assert.equal(backup.version, 2);
  assert.equal(backup.exportedAt, exportedAt);
  assert.deepEqual(backup.categories, []);
  assert.deepEqual(backup.entries.map((value: DatedEntry) => value.word), ['first', 'second', 'third']);
  for (const value of backup.entries) {
    assert.deepEqual(Object.keys(value).sort(), [...Object.keys(sample), 'created', 'categories'].sort());
    assert.deepEqual(value.categories, []);
    for (const field of ['id', 'categoryIds', 'extra']) assert.equal(field in value, false);
  }
  assert.deepEqual(parseBackup(text), { categories: [], entries: backup.entries });
  assert.deepEqual(parseBackup(text).entries[1], { ...entry, word: 'second', categories: [] });
  assert.deepEqual(values, original);
});

test('v1 reading and v2 round trips preserve all seven fields, dates and sources for dual, single and unmarked accents', async t => {
  const freeSource = 'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/tomato | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑';
  const englishSource = freeSource.replace('FreeDictionaryAPI.com', 'EnglishDictionaryAPI.com');
  const values = [
    ['dual', 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/', freeSource],
    ['american', 'US /təˈmeɪ.toʊ/', freeSource],
    ['british', 'UK /təˈmɑː.təʊ/', freeSource],
    ['unmarked', '/təˈmɑːtəʊ/', englishSource],
    ['legacy', sample.phonetic, sample.source],
  ].map(([word, phonetic, source]) => ({ ...entry, word, phonetic, source }));
  const originals = values.map((value, index) => ({
    ...value, id: index + 1, categoryIds: [], provider: 'english-dictionary', dictionaryProvider: 'free-dictionary',
  }));
  const text = serializeBackup(snapshot(originals), exportedAt);
  assert.deepEqual(JSON.parse(text), envelopeV2(unclassified(values).entries));
  const parsed = parseBackup(text);
  assert.deepEqual(parsed, unclassified(values));
  assert.deepEqual(parseBackup(JSON.stringify(envelope(values))), parsed);
  const store = createWordStore({ name: 'phonetic-backup', indexedDB: new IDBFactory(), now: () => new Date(created) });
  t.after(() => store.close());
  assert.deepEqual(await store.importEntries(parsed), { imported: 5, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 });
  await store.close();
  const restored = await store.snapshot();
  assert.deepEqual(restored, snapshot(values.map((value, index) => ({ ...value, id: index + 1, categoryIds: [] })).reverse()));
  assert.equal(serializeBackup(restored, exportedAt), text);
});

test('v1 extras remain ignored and both versions preserve opaque sources without mutating or exporting unrelated fields', () => {
  const metadata = { category: 'synthetic-category-only', tags: ['synthetic-tag-only'] };
  const machineSource = 'MyMemory（机器翻译）';
  const historicalSource = 'Historical source: an arbitrary imported note';
  const sources = [machineSource, historicalSource, ...['FreeDictionaryAPI.com', 'EnglishDictionaryAPI.com'].map(provider =>
    provider + ' | Wiktionary: https://en.wiktionary.org/wiki/could' +
    ' | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑 | ' + machineSource),
    historicalSource + ' | ' + machineSource];
  const values = sources.map(source => ({ ...entry, word: 'could', translation: '能够', source }));
  const records = values.map((value, index) => ({
    ...value, id: index + 1, categoryIds: [], ...metadata, metadata,
    provider: 'synthetic-provider', dictionaryProvider: 'english-dictionary',
    extra: { metadata, display: { color: 'synthetic-color-only', expanded: true } },
  }));
  const original = structuredClone(records);
  const text = serializeBackup(snapshot(records), exportedAt);
  assert.deepEqual(JSON.parse(text), envelopeV2(unclassified(values).entries));
  for (const ignored of [metadata.category, ...metadata.tags, 'synthetic-color-only']) assert.equal(text.includes(ignored), false);
  for (const field of ['category', 'categoryIds', 'tags', 'metadata', 'provider', 'dictionaryProvider', 'extra', 'display', 'color', 'expanded'])
    assert.equal(text.includes('"' + field + '"'), false);
  assert.deepEqual(parseBackup(text), unclassified(values));
  const legacy = records.map((value, index) => ({
    ...value, categories: [null, {}, ['Undeclared'], 'invalid' + String.fromCharCode(0) + 'name', 1001][index],
    categoryIds: 'not IDs', normalizedName: 'ignored',
  }));
  const originalLegacy = structuredClone(legacy);
  assert.deepEqual(parseBackup(JSON.stringify(envelope(legacy))), unclassified(values));
  assert.deepEqual(parseBackup(JSON.stringify(envelopeV2(records.map(value => ({ ...value, categories: [] }))))), unclassified(values));
  assert.equal(serializeBackup(snapshot(values.map((value, index) => ({ ...value, id: index + 1, categoryIds: [] }))), exportedAt), text);
  assert.deepEqual(legacy, originalLegacy);
  assert.deepEqual(records, original);
});

test('empty notebooks export v2 and accept v1 with a valid default UTC ISO export time', () => {
  assert.deepEqual(parseBackup(serializeBackup(snapshot(), exportedAt)), unclassified());
  assert.deepEqual(parseBackup(JSON.stringify(envelope([]))), unclassified());
  const before = Date.now();
  const backup = JSON.parse(serializeBackup(snapshot()));
  assert.equal(backup.version, 2);
  assert.equal(validateCreated(backup.exportedAt), backup.exportedAt);
  assert.ok(Date.parse(backup.exportedAt) >= before);
  assert.ok(Date.parse(backup.exportedAt) <= Date.now());
});

test('import assigns new IDs while preserving creation times and relative order after restoration', async t => {
  const originals: StoredEntry[] = [
    { ...stored, id: 90, word: 'third', created: '2020-01-01T00:00:00.000Z' },
    { ...stored, id: 4, word: 'first', created: '2025-01-01T00:00:00.000Z' },
    { ...stored, id: 50, word: 'second' },
  ];
  const store = createWordStore({ name: 'restored', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const seed = await store.save(createEntry('existing'));
  const parsed = parseBackup(serializeBackup(snapshot(originals), exportedAt));
  assert.deepEqual(await store.importEntries(parsed), { imported: 3, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 });
  await store.close();
  const restored = await store.list();
  assert.deepEqual(restored.map(value => value.word), ['third', 'second', 'first', 'existing']);
  assert.deepEqual(restored.map(value => value.id), [4, 3, 2, 1]);
  assert.deepEqual(restored.slice(0, 3).map(({ id: _id, categoryIds: _categories, ...value }) => ({ ...value, categories: [] })), [...parsed.entries].reverse());
  assert.deepEqual(restored[3], seed);
  assert.deepEqual(await store.importEntries(parsed), { imported: 0, updated: 0, skipped: 3, classified: 0, categoriesCreated: 0 });
});

test('exports exclude deleted entries and earlier backups restore original fields with new IDs while skipping survivors', async t => {
  const store = createWordStore({ name: 'removed-backup', indexedDB: new IDBFactory(), now: () => new Date(exportedAt) });
  t.after(() => store.close());
  const values: DatedEntry[] = [
    { ...createEntry('first'), translation: '合成首项', created: '2020-01-01T00:00:00.000Z' },
    {
      word: 'removed', phonetic: 'US /rɪˈmuːvd/ · UK /rɪˈmuːvd/', translation: '合成删除项', pos: 'Adjective',
      definition: 'A synthetic definition for backup restoration.', example: 'This is a synthetic removed entry.',
      source: 'Synthetic backup fixture', created,
    },
    { ...createEntry('last'), definition: 'A synthetic surviving entry.', created: exportedAt },
  ];
  assert.deepEqual(await store.importEntries(parseBackup(JSON.stringify(envelope(values)))),
    { imported: 3, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 });
  const originals = await store.list();
  const removed = originals[1];
  const survivors = [originals[0], originals[2]];
  const before = serializeBackup(await store.snapshot(), exportedAt);
  assert.deepEqual(JSON.parse(before), envelopeV2(unclassified(values).entries));

  await store.remove(removed.id);
  await store.close();
  assert.deepEqual(await store.list(), survivors);
  const after = serializeBackup(await store.snapshot(), exportedAt);
  assert.deepEqual(JSON.parse(after), envelopeV2(unclassified([values[0], values[2]]).entries));
  assert.deepEqual(parseBackup(after), unclassified([values[0], values[2]]));

  assert.deepEqual(await store.importEntries(parseBackup(before)), { imported: 1, updated: 0, skipped: 2, classified: 0, categoriesCreated: 0 });
  await store.close();
  const restored = await store.list();
  assert.ok(restored[0].id > originals[0].id);
  assert.deepEqual(restored[0], { ...removed, id: restored[0].id });
  assert.deepEqual(restored.slice(1), survivors);
  assert.deepEqual(await store.importEntries(parseBackup(before)), { imported: 0, updated: 0, skipped: 3, classified: 0, categoriesCreated: 0 });
  assert.deepEqual(await store.list(), restored);
  assert.deepEqual(JSON.parse(serializeBackup(await store.snapshot(), exportedAt)), envelopeV2(unclassified([values[0], values[2], values[1]]).entries));
});

test('a v1 backup overwrites complete fields and opaque sources with stable IDs in DB2, then exports as v2 without IDs', async t => {
  const factory = new IDBFactory();
  const name = 'overwrite-backup';
  const store = createWordStore({ name, indexedDB: factory, now: () => new Date(exportedAt) });
  t.after(() => store.close());
  const temporary = await store.save(createEntry('temporary'));
  await store.remove(temporary.id);
  const original = await store.save({ ...sample, word: 'tomato' });
  const unrelated = await store.save({ ...sample, word: 'unrelated', source: 'Historical attribution | unchanged arbitrary note' });
  const cleared = await store.save({ ...sample, word: 'clear' });
  const replacement: DatedEntry = {
    word: 'tomato', phonetic: 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/', translation: '番茄', pos: 'Noun',
    definition: 'A red fruit used in cooking.', example: 'Slice the tomato for the salad.',
    source: 'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/tomato | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑 | 任意用户备注',
    created,
  };
  const added: DatedEntry = {
    word: 'could', phonetic: '/kʊd/', translation: '能够', pos: 'Verb',
    definition: 'A synthetic imported definition.', example: 'We could preserve every field.',
    source: 'EnglishDictionaryAPI.com | historical source | MyMemory（机器翻译）',
    created: '2020-01-01T00:00:00.000Z',
  };
  const duplicate = { ...entry, word: 'tomato', translation: 'Later duplicate must not replace the first occurrence' };
  const blank: DatedEntry = { ...createEntry('clear'), source: '', created: '2025-01-01T00:00:00.000Z' };
  const document = envelope([
    { ...replacement, word: ' TOMATO ', id: unrelated.id, metadata: { ignored: true } },
    { ...added, id: original.id, provider: 'ignored' },
    duplicate,
    { ...blank, id: -1, extra: ['ignored'] },
  ]);
  const originalDocument = structuredClone(document);
  const text = JSON.stringify(document);
  const parsed = parseBackup(text);
  assert.deepEqual(parsed, unclassified([replacement, added, duplicate, blank]));
  const originalParsed = structuredClone(parsed);
  parsed.entries.forEach(value => { Object.freeze(value.categories); Object.freeze(value); });
  Object.freeze(parsed.categories);
  Object.freeze(parsed.entries);
  Object.freeze(parsed);
  assert.deepEqual(await store.importEntries(parsed, { overwriteExisting: true }),
    { imported: 1, updated: 2, skipped: 1, classified: 0, categoriesCreated: 0 });
  await store.close();
  const reopened = createWordStore({ name, indexedDB: factory });
  t.after(() => reopened.close());
  const restored = await reopened.list();
  const expected = [
    { ...added, id: 5, categoryIds: [] }, { ...blank, id: cleared.id, categoryIds: [] },
    unrelated, { ...replacement, id: original.id, categoryIds: [] },
  ];
  assert.deepEqual(restored, expected);
  assert.deepEqual(restored.map(value => value.id), [5, 4, 3, 2]);
  assert.deepEqual(await factory.databases(), [{ name, version: 2 }]);
  const { id: _id, categoryIds: _categories, ...unrelatedEntry } = unrelated;
  const expectedBatch = unclassified([replacement, unrelatedEntry, blank, added]);
  const serialized = serializeBackup(await reopened.snapshot(), exportedAt);
  assert.deepEqual(JSON.parse(serialized), envelopeV2(expectedBatch.entries));
  assert.deepEqual(parseBackup(serialized), expectedBatch);
  for (const value of JSON.parse(serialized).entries) {
    assert.deepEqual(Object.keys(value).sort(), [...Object.keys(sample), 'created', 'categories'].sort());
    assert.equal('id' in value, false);
    assert.equal('categoryIds' in value, false);
  }
  assert.deepEqual(restored, expected);
  assert.deepEqual(parsed, originalParsed);
  assert.deepEqual(document, originalDocument);
  assert.equal(JSON.stringify(document), text);
});

test('parsing both versions whitelists and normalizes fields while leaving valid duplicates for import to count', () => {
  const values = [
    { ...entry, word: ' APPLE ', translation: ' 苹果 ', id: 123, extra: 'ignored' },
    { ...entry, word: 'apple', translation: '第二条' },
  ];
  const expected = unclassified([
    { ...entry, word: 'apple', translation: '苹果' },
    { ...entry, word: 'apple', translation: '第二条' },
  ]);
  assert.deepEqual(parseBackup(JSON.stringify(envelope(values))), expected);
  assert.deepEqual(parseBackup(JSON.stringify(envelopeV2(unclassified(values).entries))), expected);
});

test('invalid JSON, exact version envelopes, formats and unknown versions are explicitly rejected', () => {
  for (const text of ['', '{', 'not json', '{"format":}'])
    assert.throws(() => parseBackup(text), hasCode('backupInvalidJson'));
  for (const value of [null, [], 'wordbook', 1])
    assert.throws(() => parseBackup(JSON.stringify(value)), hasCode('backupInvalidFormat'));
  for (const value of [{}, { entries: [] }, { ...envelope(), extra: true }, { ...envelope(), categories: [] },
    { ...envelopeV2(), extra: true }, { ...envelopeV2(), categories: undefined }])
    assert.throws(() => parseBackup(JSON.stringify(value)), hasCode('backupInvalidStructure'));
  for (const document of [envelope(), envelopeV2()]) {
    for (const key of Object.keys(document)) {
      const invalid: Record<string, unknown> = { ...document };
      delete invalid[key];
      assert.throws(() => parseBackup(JSON.stringify(invalid)), hasCode('backupInvalidStructure'));
    }
    for (const format of ['Wordbook', 'other', null, 1])
      assert.throws(() => parseBackup(JSON.stringify({ ...document, format })), hasCode('backupWrongFormat'));
    for (const version of [0, 3, '1', '2', null, {}, 1.5])
      assert.throws(() => parseBackup(JSON.stringify({ ...document, version })), hasCode('backupUnsupportedVersion'));
    for (const entries of [null, {}, '[]', 1])
      assert.throws(() => parseBackup(JSON.stringify({ ...document, entries })), hasCode('backupEntriesInvalid'));
  }
});

test('all backup fields and dates must be valid, including entries that would otherwise be skipped as duplicates', () => {
  for (const invalid of [
    null, [], { ...entry, word: 12 }, { ...entry, example: null }, { ...entry, source: 'x'.repeat(2001) },
    { ...entry, created: '2023-02-29T12:34:56.789Z' },
    { ...entry, created: '2024-02-29T12:34:56Z' },
    { ...entry, created: '2024-02-29T12:34:56.789+00:00' },
    { ...entry, created: undefined },
  ]) {
    assert.throws(() => parseBackup(JSON.stringify(envelope([entry, invalid]))));
    const v2Entry = invalid && !Array.isArray(invalid) ? { ...invalid, categories: [] } : invalid;
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: [] }, v2Entry]))));
    assert.throws(() => serializeBackup(snapshot([stored, { ...(invalid as object), id: 2, categoryIds: [] } as unknown as StoredEntry]), exportedAt));
  }
  for (const key of Object.keys(entry)) {
    const invalid: Record<string, unknown> = { ...entry };
    delete invalid[key];
    assert.throws(() => parseBackup(JSON.stringify(envelope([entry, invalid]))), Error, key);
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: [] }, { ...invalid, categories: [] }]))), Error, key);
  }
  for (const date of ['', '2024-02-29', '2024-02-29T12:34:56.789+00:00', 'not a date']) {
    for (const document of [envelope(), envelopeV2()])
      assert.throws(() => parseBackup(JSON.stringify({ ...document, exportedAt: date })), hasCode('invalidCreated'));
    assert.throws(() => serializeBackup(snapshot([stored]), date), hasCode('invalidCreated'));
  }
  for (const id of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
    assert.throws(() => serializeBackup(snapshot([{ ...stored, id } as StoredEntry]), exportedAt), hasCode('backupInvalidId'));
});

test('sparse entry and category arrays cannot export missing or inherited records', () => {
  assert.throws(() => serializeBackup(snapshot(new Array<StoredEntry>(1)), exportedAt), hasCode('invalidEntry'));
  const words = new Array<StoredEntry>(1);
  Object.setPrototypeOf(words, Object.assign(Object.create(Array.prototype), { 0: stored }));
  assert.throws(() => serializeBackup(snapshot(words), exportedAt), hasCode('invalidEntry'));
  const categories = new Array<Category>(1);
  Object.setPrototypeOf(categories, Object.assign(Object.create(Array.prototype), { 0: { id: 1, name: 'Inherited' } }));
  assert.throws(() => serializeBackup(snapshot([], categories), exportedAt), hasCode('invalidCategories'));
});

test('v2 exports a normalized sorted name directory including empty categories and deduplicated references, never local metadata', () => {
  const categories = [
    { id: 91, name: ' Travel ', normalizedName: 'internal-only' },
    { id: 8, name: 'Café', normalizedName: 'internal-only' },
    { id: 42, name: '医学文章', normalizedName: 'internal-only' },
    { id: 99, name: 'Empty', normalizedName: 'internal-only' },
    { id: 76, name: '__proto__', normalizedName: 'internal-only' },
    { id: 81, name: 'constructor', normalizedName: 'internal-only' },
  ];
  const value = snapshot([
    { ...stored, id: 90, word: 'later', categoryIds: [42, 91, 8, 42] },
    { ...stored, id: 4, categoryIds: [81, 76] },
  ], categories);
  const original = structuredClone(value);
  value.words.forEach(word => { Object.freeze(word.categoryIds); Object.freeze(word); });
  value.categories.forEach(Object.freeze);
  Object.freeze(value.words);
  Object.freeze(value.categories);
  Object.freeze(value);
  const text = serializeBackup(value, exportedAt);
  const backup = JSON.parse(text);
  assert.deepEqual(backup.categories, ['__proto__', 'Café', 'constructor', 'Empty', 'Travel', '医学文章']);
  assert.deepEqual(backup.entries.map((word: DatedEntry) => word.word), ['investigation', 'later']);
  assert.deepEqual(backup.entries.map((word: { categories: string[] }) => word.categories),
    [['__proto__', 'constructor'], ['Café', 'Travel', '医学文章']]);
  assert.deepEqual(parseBackup(text), { categories: backup.categories, entries: backup.entries });
  for (const key of ['id', 'categoryIds', 'normalizedName']) assert.equal(text.includes('"' + key + '"'), false);
  assert.equal(text.includes('internal-only'), false);
  assert.deepEqual(value, original);
  assert.equal(serializeBackup(snapshot([...value.words].reverse(), [...value.categories].reverse()), exportedAt), text);
  assert.deepEqual(parseBackup(JSON.stringify(envelopeV2([
    { ...entry, categories: [' TRAVEL ', 'café', 'travel', 'CAFÉ'] },
  ], ['Travel', 'Café', 'Unused']))), {
    categories: ['Travel', 'Café', 'Unused'], entries: [{ ...entry, categories: ['Travel', 'Café'] }],
  });
});

test('portable v2 names resolve to destination IDs and import unions categories independently of lexical overwrite', async t => {
  for (const overwriteExisting of [undefined, false, true]) await t.test(String(overwriteExisting), async t => {
    const store = createWordStore({ name: 'portable-' + overwriteExisting, indexedDB: new IDBFactory(), now: () => new Date(exportedAt) });
    t.after(() => store.close());
    const local = await store.createCategory('Local');
    const travel = await store.createCategory('tRaVeL');
    const selected = await store.createCategory('Selected');
    const existing = await store.save({ ...sample, word: 'ticket' }, [local.id]);
    const unrelated = await store.save({ ...sample, word: 'unrelated' });
    const source = snapshot([
      { ...stored, id: 90, word: 'ticket', translation: '', categoryIds: [100, 200] },
      { ...stored, id: 91, word: 'new', categoryIds: [100] },
      { ...stored, id: 92, word: ' TICKET ', source: 'Later duplicate must not win', categoryIds: [300] },
    ], [
      { id: 100, name: 'Travel' }, { id: 200, name: 'New' },
      { id: 300, name: 'Duplicate only' }, { id: 400, name: 'Empty' },
    ]);
    const batch = parseBackup(serializeBackup(source, exportedAt));
    const options = { overwriteExisting, selectedCategoryIds: [selected.id] };
    assert.deepEqual(await store.importEntries(batch, options), {
      imported: 1, updated: overwriteExisting === true ? 1 : 0, skipped: overwriteExisting === true ? 1 : 2,
      classified: 2, categoriesCreated: 3,
    });
    await store.close();
    const restored = await store.snapshot();
    assert.equal(restored.categories.length, 6);
    assert.deepEqual(restored.categories.find(value => value.id === travel.id), travel);
    const addedCategory = restored.categories.find(value => value.name === 'New')!;
    const duplicateCategory = restored.categories.find(value => value.name === 'Duplicate only')!;
    assert.ok(restored.categories.some(value => value.name === 'Empty'));
    assert.notEqual(addedCategory.id, 200);
    const restoredExisting = restored.words.find(value => value.id === existing.id)!;
    assert.deepEqual(restoredExisting, {
      ...(overwriteExisting === true ? { ...entry, word: 'ticket', translation: '', id: existing.id } : existing),
      categoryIds: [local.id, travel.id, selected.id, addedCategory.id].sort((a, b) => a - b),
    });
    assert.deepEqual(restored.words.find(value => value.word === 'new'), {
      ...entry, word: 'new', id: unrelated.id + 1, categoryIds: [travel.id, selected.id].sort((a, b) => a - b),
    });
    assert.deepEqual(restored.words.find(value => value.id === unrelated.id), unrelated);
    assert.equal(restored.words.some(value => value.categoryIds.includes(duplicateCategory.id)), false);
    assert.deepEqual(restored.words.map(value => value.id), [unrelated.id + 1, unrelated.id, existing.id]);
    assert.deepEqual(await store.importEntries(batch, options), {
      imported: 0, updated: overwriteExisting === true ? 2 : 0, skipped: overwriteExisting === true ? 1 : 3,
      classified: 0, categoriesCreated: 0,
    });
    const exported = parseBackup(serializeBackup(await store.snapshot(), exportedAt));
    assert.deepEqual(exported.categories, ['Duplicate only', 'Empty', 'Local', 'New', 'Selected', 'tRaVeL']);
    assert.deepEqual(exported.entries.find(value => value.word === 'ticket')!.categories, ['Local', 'New', 'Selected', 'tRaVeL']);
  });
});

test('empty categories persist and count independently of words, while restoring an old name is not rename synchronization', async t => {
  const store = createWordStore({ name: 'empty-categories', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const batch = parseBackup(JSON.stringify(envelopeV2([], ['Original'])));
  assert.deepEqual(await store.importEntries(batch), { imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 1 });
  await store.close();
  const initial = await store.snapshot();
  assert.deepEqual(initial.words, []);
  assert.deepEqual(initial.categories.map(value => value.name), ['Original']);
  assert.deepEqual(parseBackup(serializeBackup(initial, exportedAt)), batch);
  assert.deepEqual(await store.importEntries(batch), { imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 });
  await store.renameCategory(initial.categories[0].id, 'Renamed');
  assert.deepEqual(await store.importEntries(batch), { imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 1 });
  assert.deepEqual(parseBackup(serializeBackup(await store.snapshot(), exportedAt)).categories, ['Original', 'Renamed']);
});

test('v1 category-looking entry extras cannot clear or add associations in either import mode', async t => {
  for (const overwriteExisting of [false, true]) await t.test(String(overwriteExisting), async t => {
    const store = createWordStore({ name: 'legacy-categories-' + overwriteExisting, indexedDB: new IDBFactory() });
    t.after(() => store.close());
    const local = await store.createCategory('Local');
    const selected = await store.createCategory('Selected');
    const existing = await store.save(sample, [local.id]);
    const parsed = parseBackup(JSON.stringify(envelope([{ ...entry, categories: ['Undeclared'], categoryIds: [999] }])));
    assert.deepEqual(parsed, unclassified([entry]));
    assert.deepEqual(await store.importEntries(parsed, { overwriteExisting, selectedCategoryIds: [selected.id] }), {
      imported: 0, updated: overwriteExisting ? 1 : 0, skipped: overwriteExisting ? 0 : 1,
      classified: 1, categoriesCreated: 0,
    });
    assert.deepEqual(await store.list(), [{
      ...(overwriteExisting ? { ...entry, id: existing.id } : existing), categoryIds: [local.id, selected.id],
    }]);
    assert.equal((await store.snapshot()).categories.length, 2);
  });
});

test('v2 requires valid names, a unique normalized directory and declared reference arrays on every entry', () => {
  for (const categories of [null, {}, '[]', 1])
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([], categories))), hasCode('invalidCategories'));
  for (const name of [null, {}, 1, '', '  ', 'x'.repeat(MAX_CATEGORY_NAME_LENGTH + 1), 'a' + String.fromCharCode(0) + 'b', 'a\nb', 'a' + String.fromCharCode(127) + 'b'])
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([], [name]))), hasCode('invalidCategoryName'));
  for (const categories of [['Topic', ' topic '], ['Café', 'café'], ['__proto__', '__PROTO__']])
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([], categories))), hasCode('duplicateCategory'));
  for (const categories of [undefined, null, {}, '', 1])
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories }]))), hasCode('invalidCategories'));
  for (const categories of [[null], [1], [''], ['x'.repeat(MAX_CATEGORY_NAME_LENGTH + 1)], ['bad' + String.fromCharCode(0) + 'name']])
    assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories }]))), hasCode('invalidCategoryName'));
  assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: ['Missing'] }], ['Present']))), hasCode('categoryMissing'));
  assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: ['toString'] }]))), hasCode('categoryMissing'));
});

test('invalid references on preserved matches and later duplicate words reject the whole backup without creating categories', async t => {
  const store = createWordStore({ name: 'invalid-reference', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  await store.save(sample);
  const before = await store.snapshot();
  const invalid = { ...entry, categories: ['Undeclared'] };
  for (const entries of [[invalid], [{ ...entry, categories: ['Valid'] }, { ...invalid, word: ' INVESTIGATION ' }]]) {
    for (const overwriteExisting of [false, true]) {
      await assert.rejects(async () => store.importEntries(parseBackup(JSON.stringify(envelopeV2(entries, ['Valid']))), { overwriteExisting }),
        hasCode('categoryMissing'));
      assert.deepEqual(await store.snapshot(), before);
    }
  }
});

test('export rejects malformed category directories, invalid IDs and dangling relationships rather than dropping them', () => {
  for (const categories of [null, {}, [null], new Array(1), [{ id: 1, name: '' }], [{ id: 1, name: 'Topic' }, { id: 2, name: ' topic ' }],
    [{ id: 1, name: 'First' }, { id: 1, name: 'Second' }]])
    assert.throws(() => serializeBackup({ words: [], categories } as unknown as LibrarySnapshot, exportedAt));
  for (const id of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
    assert.throws(() => serializeBackup(snapshot([], [{ id, name: 'Topic' } as Category]), exportedAt), hasCode('invalidCategoryIds'));
  for (const categoryIds of [undefined, null, {}, '[]', [0], [-1], [1.5], ['1'], [NaN], [Number.MAX_SAFE_INTEGER + 1], new Array(1)])
    assert.throws(() => serializeBackup(snapshot([{ ...stored, categoryIds } as StoredEntry]), exportedAt), hasCode('invalidCategoryIds'));
  assert.throws(() => serializeBackup(snapshot([{ ...stored, categoryIds: [1] }]), exportedAt), hasCode('categoryMissing'));
});

test('category directories and each reference array allow 1000 names but reject 1001 without truncation', () => {
  assert.equal(MAX_CATEGORIES, 1000);
  assert.equal(MAX_CATEGORY_NAME_LENGTH, 80);
  const categories = Array.from({ length: MAX_CATEGORIES }, (_, index) => ({ id: index + 1, name: 'Category ' + String(index).padStart(4, '0') }));
  const value = snapshot([{ ...stored, categoryIds: categories.map(category => category.id) }], categories);
  const parsed = parseBackup(serializeBackup(value, exportedAt));
  assert.equal(parsed.categories.length, MAX_CATEGORIES);
  assert.equal(parsed.entries[0].categories.length, MAX_CATEGORIES);
  assert.deepEqual(parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: Array(MAX_CATEGORIES).fill('Category 0000') }], ['Category 0000']))).entries[0].categories,
    ['Category 0000']);
  const tooMany = [...categories, { id: MAX_CATEGORIES + 1, name: 'Overflow' }];
  assert.throws(() => parseBackup(JSON.stringify(envelopeV2([], tooMany.map(category => category.name)))), hasCode('tooManyCategories'));
  assert.throws(() => serializeBackup(snapshot([], tooMany), exportedAt), hasCode('tooManyCategories'));
  assert.throws(() => parseBackup(JSON.stringify(envelopeV2([{ ...entry, categories: Array(MAX_CATEGORIES + 1).fill('Topic') }], ['Topic']))), hasCode('tooManyCategories'));
  assert.throws(() => serializeBackup(snapshot([{ ...stored, categoryIds: Array(MAX_CATEGORIES + 1).fill(1) }], [{ id: 1, name: 'Topic' }]), exportedAt), hasCode('tooManyCategories'));
});

test('both import versions count UTF-8 bytes, accepting exactly 10 MiB and rejecting larger inputs without truncation', () => {
  assert.equal(MAX_BACKUP_BYTES, 10 * 1024 * 1024);
  for (const document of [envelope(), envelopeV2()]) {
    const text = JSON.stringify(document);
    const padded = text + ' '.repeat(MAX_BACKUP_BYTES - Buffer.byteLength(text, 'utf8'));
    assert.equal(Buffer.byteLength(padded, 'utf8'), MAX_BACKUP_BYTES);
    assert.deepEqual(parseBackup(padded), unclassified([entry]));
    assert.throws(() => parseBackup(padded + ' '), hasCode('backupTooLarge'));
  }
  assert.throws(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), hasCode('backupTooLarge'));
});

test('import and export reject multibyte content that exceeds the byte limit', () => {
  const values: StoredEntry[] = Array.from({ length: 2000 }, (_, index) => ({
    ...stored, id: index + 1, translation: '中'.repeat(2000),
  }));
  for (const document of [envelope(values), envelopeV2(unclassified(values).entries)]) {
    const text = JSON.stringify(document);
    assert.ok(text.length < MAX_BACKUP_BYTES);
    assert.ok(Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES);
    assert.throws(() => parseBackup(text), hasCode('backupTooLarge'));
  }
  assert.throws(() => serializeBackup(snapshot(values), exportedAt), hasCode('backupTooLarge'));
});

test('up to 10000 entries round-trip, while 10001 entries are rejected on both import versions and export', () => {
  assert.equal(MAX_BACKUP_ENTRIES, 10000);
  const values = Array.from({ length: MAX_BACKUP_ENTRIES }, (_, index) => ({ ...stored, id: index + 1 }));
  assert.equal(parseBackup(serializeBackup(snapshot(values), exportedAt)).entries.length, MAX_BACKUP_ENTRIES);
  assert.equal(parseBackup(JSON.stringify(envelope(values))).entries.length, MAX_BACKUP_ENTRIES);
  values.push({ ...stored, id: MAX_BACKUP_ENTRIES + 1 });
  for (const document of [envelope(values), envelopeV2(unclassified(values).entries)])
    assert.throws(() => parseBackup(JSON.stringify(document)), hasCode('backupTooManyEntries'));
  assert.throws(() => serializeBackup(snapshot(values), exportedAt), hasCode('backupTooManyEntries'));
});
