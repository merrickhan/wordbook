import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MAX_BACKUP_BYTES, MAX_BACKUP_ENTRIES, parseBackup, serializeBackup } from '../src/backup';
import { createEntry, sample, validateCreated } from '../src/entry';
import type { DatedEntry, StoredEntry } from '../src/entry';
import { createWordStore } from '../src/storage';

const exportedAt = '2026-09-28T08:00:00.000Z';
const created = '2024-02-29T12:34:56.789Z';
const entry: DatedEntry = { ...sample, created };
const stored: StoredEntry = { ...entry, id: 1 };
const envelope = (entries: unknown = [entry]) => ({ format: 'wordbook', version: 1, exportedAt, entries });

test('backup envelopes, business fields and dates round-trip in ascending ID order without exporting IDs', () => {
  const values = [
    { ...stored, word: 'third', id: 90, created: '2020-01-01T00:00:00.000Z' },
    { ...stored, word: 'first', id: 4, created: '2025-01-01T00:00:00.000Z' },
    { ...stored, word: 'second', id: 50, extra: 'ignored' },
  ];
  const original = structuredClone(values);
  const text = serializeBackup(values, exportedAt);
  const backup = JSON.parse(text);
  assert.deepEqual(Object.keys(backup), ['format', 'version', 'exportedAt', 'entries']);
  assert.equal(backup.format, 'wordbook');
  assert.equal(backup.version, 1);
  assert.equal(backup.exportedAt, exportedAt);
  assert.deepEqual(backup.entries.map((value: DatedEntry) => value.word), ['first', 'second', 'third']);
  for (const value of backup.entries) {
    assert.deepEqual(Object.keys(value).sort(), [...Object.keys(sample), 'created'].sort());
    assert.equal('id' in value, false);
    assert.equal('extra' in value, false);
  }
  assert.deepEqual(parseBackup(text), backup.entries);
  assert.deepEqual(parseBackup(text)[1], { ...entry, word: 'second' });
  assert.deepEqual(values, original);
});

test('v1 export and import preserve all seven fields, dates and sources for dual, single and unmarked accents', async t => {
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
    ...value, id: index + 1, provider: 'english-dictionary', dictionaryProvider: 'free-dictionary',
  }));
  const text = serializeBackup(originals, exportedAt);
  assert.deepEqual(JSON.parse(text), envelope(values));
  const parsed = parseBackup(text);
  assert.deepEqual(parsed, values);
  const store = createWordStore({ name: 'phonetic-backup', indexedDB: new IDBFactory(), now: () => new Date(created) });
  t.after(() => store.close());
  assert.deepEqual(await store.importEntries(parsed), { imported: 5, skipped: 0 });
  await store.close();
  const restored = await store.list();
  assert.deepEqual(restored, values.map((value, index) => ({ ...value, id: index + 1 })).reverse());
  assert.equal(serializeBackup(restored, exportedAt), text);
});

test('v1 backups preserve opaque sources while excluding unrelated nested fields without mutating inputs', () => {
  const metadata = { category: 'synthetic-category-only', tags: ['synthetic-tag-only'] };
  const machineSource = 'MyMemory（机器翻译）';
  const historicalSource = 'Historical source: an arbitrary imported note';
  const sources = [machineSource, historicalSource, ...['FreeDictionaryAPI.com', 'EnglishDictionaryAPI.com'].map(provider =>
    provider + ' | Wiktionary: https://en.wiktionary.org/wiki/could' +
    ' | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑 | ' + machineSource),
    historicalSource + ' | ' + machineSource];
  const values = sources.map(source => ({ ...entry, word: 'could', translation: '能够', source }));
  const records = values.map((value, index) => ({
    ...value, id: index + 1, ...metadata, metadata,
    provider: 'synthetic-provider', dictionaryProvider: 'english-dictionary',
    extra: { metadata, display: { color: 'synthetic-color-only', expanded: true } },
  }));
  const original = structuredClone(records);
  const text = serializeBackup(records, exportedAt);
  assert.deepEqual(JSON.parse(text), envelope(values));
  for (const ignored of [metadata.category, ...metadata.tags, 'synthetic-color-only']) assert.equal(text.includes(ignored), false);
  for (const field of ['category', 'tags', 'metadata', 'provider', 'dictionaryProvider', 'extra', 'display', 'color', 'expanded'])
    assert.equal(text.includes('"' + field + '"'), false);
  assert.deepEqual(parseBackup(text), values);
  assert.deepEqual(parseBackup(JSON.stringify(envelope(records))), values);
  assert.equal(serializeBackup(parseBackup(text).map((value, index) => ({ ...value, id: index + 1 })), exportedAt), text);
  assert.deepEqual(records, original);
});

test('empty notebooks can be exported and imported with a valid default UTC ISO export time', () => {
  assert.deepEqual(parseBackup(serializeBackup([], exportedAt)), []);
  const before = Date.now();
  const backup = JSON.parse(serializeBackup([]));
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
  const parsed = parseBackup(serializeBackup(originals, exportedAt));
  assert.deepEqual(await store.importEntries(parsed), { imported: 3, skipped: 0 });
  await store.close();
  const restored = await store.list();
  assert.deepEqual(restored.map(value => value.word), ['third', 'second', 'first', 'existing']);
  assert.deepEqual(restored.map(value => value.id), [4, 3, 2, 1]);
  assert.deepEqual(restored.slice(0, 3).map(({ id: _id, ...value }) => value), [...parsed].reverse());
  assert.deepEqual(restored[3], seed);
  assert.deepEqual(await store.importEntries(parsed), { imported: 0, skipped: 3 });
});

test('v1 backups exclude deleted entries and earlier backups restore original fields with new IDs while skipping survivors', async t => {
  const store = createWordStore({ name: 'removed-backup', indexedDB: new IDBFactory(), now: () => new Date(exportedAt) });
  t.after(() => store.close());
  const values: DatedEntry[] = [
    { ...createEntry('first'), translation: '合成首项', created: '2020-01-01T00:00:00.000Z' },
    {
      word: 'removed',
      phonetic: 'US /rɪˈmuːvd/ · UK /rɪˈmuːvd/',
      translation: '合成删除项',
      pos: 'Adjective',
      definition: 'A synthetic definition for backup restoration.',
      example: 'This is a synthetic removed entry.',
      source: 'Synthetic backup fixture',
      created,
    },
    { ...createEntry('last'), definition: 'A synthetic surviving entry.', created: exportedAt },
  ];
  assert.deepEqual(await store.importEntries(values), { imported: 3, skipped: 0 });
  const originals = await store.list();
  const removed = originals[1];
  const survivors = [originals[0], originals[2]];
  const before = serializeBackup(originals, exportedAt);
  assert.deepEqual(JSON.parse(before), envelope(values));

  await store.remove(removed.id);
  await store.close();
  assert.deepEqual(await store.list(), survivors);
  const after = serializeBackup(await store.list(), exportedAt);
  assert.deepEqual(JSON.parse(after), envelope([values[0], values[2]]));
  assert.deepEqual(parseBackup(after), [values[0], values[2]]);

  assert.deepEqual(await store.importEntries(parseBackup(before)), { imported: 1, skipped: 2 });
  await store.close();
  const restored = await store.list();
  assert.ok(restored[0].id > originals[0].id);
  assert.deepEqual(restored[0], { ...removed, id: restored[0].id });
  assert.deepEqual(restored.slice(1), survivors);
  assert.deepEqual(await store.importEntries(parseBackup(before)), { imported: 0, skipped: 3 });
  assert.deepEqual(await store.list(), restored);
  assert.deepEqual(JSON.parse(serializeBackup(restored, exportedAt)), envelope([values[0], values[2], values[1]]));
});

test('parsing whitelists and normalizes fields while leaving valid duplicates for import to count', () => {
  const values = [
    { ...entry, word: ' APPLE ', translation: ' 苹果 ', id: 123, extra: 'ignored' },
    { ...entry, word: 'apple', translation: '第二条' },
  ];
  assert.deepEqual(parseBackup(JSON.stringify(envelope(values))), [
    { ...entry, word: 'apple', translation: '苹果' },
    { ...entry, word: 'apple', translation: '第二条' },
  ]);
});

test('invalid JSON, structures, formats and unknown versions are explicitly rejected', () => {
  for (const text of ['', '{', 'not json', '{"format":}'])
    assert.throws(() => parseBackup(text), /JSON/);
  for (const value of [null, [], 'wordbook', 1, {}, { entries: [] }, { ...envelope(), extra: true }])
    assert.throws(() => parseBackup(JSON.stringify(value)), /格式|结构/);
  for (const format of ['Wordbook', 'other', null, 1])
    assert.throws(() => parseBackup(JSON.stringify({ ...envelope(), format })), /不是 Wordbook/);
  for (const version of [0, 2, '1', null, {}, 1.5])
    assert.throws(() => parseBackup(JSON.stringify({ ...envelope(), version })), /版本/);
  for (const entries of [null, {}, '[]', 1])
    assert.throws(() => parseBackup(JSON.stringify(envelope(entries))), /数组/);
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
    assert.throws(() => serializeBackup([stored, { ...(invalid as object), id: 2 } as StoredEntry], exportedAt));
  }
  for (const key of Object.keys(entry)) {
    const invalid: Record<string, unknown> = { ...entry };
    delete invalid[key];
    assert.throws(() => parseBackup(JSON.stringify(envelope([entry, invalid]))), Error, key);
  }
  for (const date of ['', '2024-02-29', '2024-02-29T12:34:56.789+00:00', 'not a date']) {
    assert.throws(() => parseBackup(JSON.stringify({ ...envelope(), exportedAt: date })), /时间无效/);
    assert.throws(() => serializeBackup([stored], date), /时间无效/);
  }
  for (const id of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
    assert.throws(() => serializeBackup([{ ...stored, id } as StoredEntry], exportedAt), /编号无效/);
});

test('sparse entry arrays cannot be exported as null entries that cannot be reimported', () => {
  assert.throws(() => serializeBackup(new Array<StoredEntry>(1), exportedAt), /内容无效/);
});

test('import limits count UTF-8 bytes, accepting exactly 10 MiB and rejecting larger inputs without truncation', () => {
  assert.equal(MAX_BACKUP_BYTES, 10 * 1024 * 1024);
  const text = JSON.stringify(envelope());
  const padded = text + ' '.repeat(MAX_BACKUP_BYTES - Buffer.byteLength(text, 'utf8'));
  assert.equal(Buffer.byteLength(padded, 'utf8'), MAX_BACKUP_BYTES);
  assert.deepEqual(parseBackup(padded), [entry]);
  assert.throws(() => parseBackup(padded + ' '), /10 MiB/);
  assert.throws(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), /10 MiB/);
});

test('import and export reject multibyte content that exceeds the byte limit', () => {
  const values: StoredEntry[] = Array.from({ length: 2000 }, (_, index) => ({
    ...stored, id: index + 1, translation: '中'.repeat(2000),
  }));
  const text = JSON.stringify(envelope(values));
  assert.ok(text.length < MAX_BACKUP_BYTES);
  assert.ok(Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES);
  assert.throws(() => parseBackup(text), /10 MiB/);
  assert.throws(() => serializeBackup(values, exportedAt), /10 MiB/);
});

test('up to 10000 entries round-trip, while 10001 entries are rejected on both import and export', () => {
  assert.equal(MAX_BACKUP_ENTRIES, 10000);
  const values = Array.from({ length: MAX_BACKUP_ENTRIES }, (_, index) => ({ ...stored, id: index + 1 }));
  assert.equal(parseBackup(serializeBackup(values, exportedAt)).length, MAX_BACKUP_ENTRIES);
  values.push({ ...stored, id: MAX_BACKUP_ENTRIES + 1 });
  assert.throws(() => parseBackup(JSON.stringify(envelope(values))), /10,000 条/);
  assert.throws(() => serializeBackup(values, exportedAt), /10,000 条/);
});
