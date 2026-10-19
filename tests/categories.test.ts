import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CATEGORIES, MAX_CATEGORY_NAME_LENGTH, applyCategoryChange, categoryNameKey,
  normalizeCategoryName, validateCategoryChange, validateCategoryIds, validateImportBatch,
} from '../src/categories';
import { createEntry, validateEntry } from '../src/entry';

const created = '2024-02-29T12:34:56.789Z';
const entry = (word = 'example') => ({ ...createEntry(word), created, categories: [] as string[] });
const code = (value: string) => ({ name: 'MessageError', detail: { code: value } });

test('category names trim and normalize NFC without translating, folding accents or collapsing internal spaces', () => {
  assert.equal(normalizeCategoryName('　 医学文章  '), '医学文章');
  assert.equal(normalizeCategoryName('  Café  '), 'Café');
  assert.equal(normalizeCategoryName('Travel  Notes'), 'Travel  Notes');
  assert.equal(categoryNameKey('CAFÉ'), categoryNameKey('Café'));
  assert.notEqual(categoryNameKey('cafe'), categoryNameKey('café'));
  assert.notEqual(categoryNameKey('Travel Notes'), categoryNameKey('Travel  Notes'));
  assert.equal(categoryNameKey('I'), 'i');
  assert.notEqual(categoryNameKey('I'), categoryNameKey('ı'));
  for (const name of ['__proto__', 'constructor', '<script>not executable</script>'])
    assert.equal(normalizeCategoryName(name), name);
});

test('category names use normalized UTF-16 length limits and reject controls or nonstrings', () => {
  assert.equal(MAX_CATEGORY_NAME_LENGTH, 80);
  assert.equal(normalizeCategoryName('a'.repeat(80)).length, 80);
  assert.equal(normalizeCategoryName('😀'.repeat(40)).length, 80);
  assert.equal(normalizeCategoryName('é'.repeat(80)).length, 80);
  for (const value of [null, undefined, 1, true, {}, [], '', '　 ', 'a'.repeat(81), '😀'.repeat(41)])
    assert.throws(() => normalizeCategoryName(value), code('invalidCategoryName'));
  for (const character of ['\0', '\t', '\n', '\r', '', '', '', '']) {
    for (const value of [character + 'valid', 'va' + character + 'lid', 'valid' + character])
      assert.throws(() => normalizeCategoryName(value), code('invalidCategoryName'));
  }
});

test('category ID arrays are copied, deduplicated and numerically sorted with positive safe IDs', () => {
  const input = Object.freeze([20, 2, Number.MAX_SAFE_INTEGER, 1, 2]);
  const output = validateCategoryIds(input);
  assert.deepEqual(output, [1, 2, 20, Number.MAX_SAFE_INTEGER]);
  output.push(3);
  assert.deepEqual(input, [20, 2, Number.MAX_SAFE_INTEGER, 1, 2]);
  assert.deepEqual(validateCategoryIds([]), []);
  assert.equal(validateCategoryIds(Array.from({ length: MAX_CATEGORIES }, (_, index) => index + 1)).length, 1000);
  assert.throws(() => validateCategoryIds(Array(1001).fill(1)), code('tooManyCategories'));
  for (const value of [null, undefined, 1, '1', {}, new Set([1]), [null], [undefined], [0], [-1],
    [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ['1'], [1n], new Array(1), [1, , 2]])
    assert.throws(() => validateCategoryIds(value), code('invalidCategoryIds'));
  const inherited = Object.assign(new Array(1), {});
  Object.setPrototypeOf(inherited, { 0: 1 });
  assert.throws(() => validateCategoryIds(inherited), code('invalidCategoryIds'));
});

test('category changes require nonempty targets except clear and do not mutate any input array', () => {
  const current = Object.freeze([1, 3]);
  const target = Object.freeze([3, 2, 2]);
  for (const [mode, expected] of [
    ['add', [1, 2, 3]], ['remove', [1]], ['replace', [2, 3]],
  ] as const) {
    const change = validateCategoryChange({ mode, categoryIds: target });
    assert.deepEqual(applyCategoryChange(current, change), expected);
  }
  assert.deepEqual(applyCategoryChange(current, validateCategoryChange({ mode: 'clear' })), []);
  assert.deepEqual(current, [1, 3]);
  assert.deepEqual(target, [3, 2, 2]);
  for (const mode of ['add', 'remove', 'replace'])
    assert.throws(() => validateCategoryChange({ mode, categoryIds: [] }), code('invalidCategoryChange'));
  for (const value of [null, undefined, [], 'clear', {}, { mode: 'invalid' }])
    assert.throws(() => validateCategoryChange(value), code('invalidCategoryChange'));
  assert.throws(() => validateCategoryChange({ mode: 'add', categoryIds: [0] }), code('invalidCategoryIds'));
  const all = Array.from({ length: MAX_CATEGORIES }, (_, index) => index + 1);
  assert.deepEqual(applyCategoryChange(all, { mode: 'add', categoryIds: all }), all);
  assert.throws(() => applyCategoryChange(all, { mode: 'add', categoryIds: [1001] }), code('tooManyCategories'));
});

test('import validation snapshots names and every lexical record, strips metadata and resolves references with Map keys', () => {
  const input = {
    categories: ['  Café ', '__proto__', 'constructor', 'Empty'],
    entries: [{
      ...entry(' WORD '), word: ' WORD ', source: ' Historical attribution ',
      categories: ['CAFÉ', 'café', '__proto__', 'CONSTRUCTOR'],
      id: 100, categoryIds: [200], normalizedName: 'ignored', dictionaryProvider: 'ignored', extra: true,
    }],
    extra: 'ignored',
  };
  const batch = validateImportBatch(input);
  assert.deepEqual(batch, {
    categories: ['Café', '__proto__', 'constructor', 'Empty'],
    entries: [{ ...entry('word'), source: 'Historical attribution', categories: ['Café', '__proto__', 'constructor'] }],
  });
  input.categories[0] = 'mutated';
  input.entries[0].categories.length = 0;
  input.entries[0].source = 'mutated';
  input.entries.push({ ...input.entries[0] });
  assert.equal(batch.categories[0], 'Café');
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.entries[0].source, 'Historical attribution');
  assert.deepEqual(batch.entries[0].categories, ['Café', '__proto__', 'constructor']);
  assert.deepEqual(validateEntry({ ...entry(), categories: ['Ignored'], categoryIds: [1] }), createEntry('example'));
});

test('import validation requires dense directory, entries and reference arrays, and rejects normalized directory collisions', () => {
  for (const value of [null, undefined, [], 1, {}, { categories: [] }, { entries: {} }, { categories: [], entries: new Array(1) }])
    assert.throws(() => validateImportBatch(value));
  for (const categories of [undefined, null, 'Travel', {}, new Array(1)]) {
    assert.throws(() => validateImportBatch({ categories, entries: [] }));
    assert.throws(() => validateImportBatch({ categories: [], entries: [{ ...entry(), categories }] }));
  }
  for (const categories of [['Topic', ' TOPIC '], ['Café', 'Café'], ['__proto__', '__proto__']])
    assert.throws(() => validateImportBatch({ categories, entries: [] }), code('duplicateCategory'));
  assert.throws(() => validateImportBatch({ categories: ['Topic'], entries: [{ ...entry(), categories: ['Missing'] }] }), code('categoryMissing'));
  assert.throws(() => validateImportBatch({ categories: [], entries: [{ ...entry(), categories: [1] }] }), code('invalidCategoryName'));
  assert.throws(() => validateImportBatch({ categories: [], entries: [{ ...entry(), categories: Array(1001).fill('Topic') }] }), code('tooManyCategories'));
  assert.throws(() => validateImportBatch({ categories: Array.from({ length: 1001 }, (_, index) => `Topic ${index}`), entries: [] }), code('tooManyCategories'));
});

test('every later duplicate word is fully validated instead of discarding its invalid content or references', () => {
  const first = entry('example');
  for (const invalid of [
    { ...entry('example'), source: null }, { ...entry('example'), created: 'bad' },
    { ...entry('example'), categories: undefined }, { ...entry('example'), categories: ['Missing'] },
    { ...entry('example'), categories: new Array(1) },
  ]) assert.throws(() => validateImportBatch({ categories: [], entries: [first, invalid] }));
  assert.equal(validateImportBatch({ categories: ['Later only'], entries: [first, { ...first, categories: ['Later only'] }] }).entries.length, 2);
});

test('import-batch validation has category limits but no backup byte or entry-count limits', () => {
  const entries = Array.from({ length: 10001 }, () => ({ ...entry(), source: 'x'.repeat(2000) }));
  const batch = validateImportBatch({ categories: [], entries });
  assert.equal(batch.entries.length, 10001);
  assert.equal(batch.entries[10000].source.length, 2000);
});
