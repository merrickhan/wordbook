import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredEntry } from '../src/entry';
import { LIBRARY_PAGE_SIZE, paginateLibraryEntries, selectLibraryEntries, type LibrarySort } from '../src/library';

function entry(id: number, word: string, translation = '', categoryIds: number[] = []): StoredEntry {
  return {
    id, word, translation, categoryIds,
    phonetic: '/synthetic-phonetic/',
    pos: 'Synthetic part of speech',
    definition: 'Synthetic definition only',
    example: 'Synthetic example only',
    source: 'Synthetic source only',
    created: '2024-02-29T12:34:56.789Z',
  };
}

const ids = (entries: readonly StoredEntry[]) => entries.map(value => value.id);
const sorts: LibrarySort[] = ['recent', 'alphabetical'];

test('empty libraries and trimmed empty searches return independent sorted arrays', () => {
  const empty = Object.freeze([]);
  const values = Object.freeze([Object.freeze(entry(1, 'zulu')), Object.freeze(entry(2, 'alpha'))]);
  for (const sort of sorts) {
    const result = selectLibraryEntries(empty, ' anything ', sort);
    assert.deepEqual(result, []);
    assert.notEqual(result, empty);
    for (const query of ['', ' ', '\t\n', '  　']) {
      const selected = selectLibraryEntries(values, query, sort);
      assert.deepEqual(ids(selected), [2, 1]);
      assert.notEqual(selected, values);
      assert.equal(selected[0], values[1]);
    }
  }
});

test('search trims and lowercases a literal substring of the word OR translation, and nothing else', () => {
  const values = [entry(1, 'APPLE', '苹果'), entry(4, 'pineapple', 'Fruit'), entry(2, 'pear', 'An APPLE alternative')];
  for (const sort of sorts) {
    assert.deepEqual(new Set(ids(selectLibraryEntries(values, '  ApPlE\n', sort))), new Set([1, 4, 2]));
    assert.deepEqual(ids(selectLibraryEntries(values, ' 苹果 ', sort)), [1]);
    assert.deepEqual(ids(selectLibraryEntries(values, 'rUi', sort)), [4]);
    for (const query of ['synthetic', 'phonetic', 'part of speech', 'definition', 'example', 'source', '2024', 'not found'])
      assert.deepEqual(selectLibraryEntries(values, query, sort), [], query);
  }
});

test('search punctuation is literal even when it is invalid as a dictionary lookup or regular expression', () => {
  const values = [
    entry(1, 'well-known', 'a familiar phrase'),
    entry(2, "don't", 'do not'),
    entry(3, 'literal.*[value]?', '+(x)|^$\\/{a}'),
    entry(4, 'ordinary', 'plain text'),
  ];
  for (const sort of sorts) {
    for (const query of ['.*', '[', '[value]', '?', '+', '(x)', '|', '^', '$', '\\', '/', '{a}'])
      assert.deepEqual(ids(selectLibraryEntries(values, query, sort)), [3], query);
    assert.deepEqual(ids(selectLibraryEntries(values, '-', sort)), [1]);
    assert.deepEqual(ids(selectLibraryEntries(values, "'", sort)), [2]);
    assert.deepEqual(selectLibraryEntries(values, '[missing]', sort), []);
    assert.deepEqual(selectLibraryEntries(values, '.*plain', sort), []);
  }
});

test('multilingual search does not normalize accents, width, punctuation, or internal whitespace', () => {
  const values = [
    entry(1, 'café', 'CAFÉ; 调查研究'),
    entry(2, 'decomposed', 'café'),
    entry(3, 'width', 'ＡＢＣ'),
    entry(4, 'street', 'Straße'),
    entry(5, 'ice  cream', 'two  spaces'),
    entry(6, 'quote', 'curly ’ apostrophe'),
  ];
  for (const [query, expected] of [
    ['café', [1]], ['CAFÉ', [2]], ['cafe', [2]], ['调查', [1]], ['研究', [1]],
    ['ａｂｃ', [3]], ['abc', []], ['straße', [4]], ['STRASSE', []],
    ['ice cream', []], [' ice  cream ', [5]], ['two spaces', []], ["'", []], ['’', [6]],
  ] as const) {
    for (const sort of sorts)
      assert.deepEqual(ids(selectLibraryEntries(values, query, sort)), expected, query);
  }
});

test('category views intersect literal word or translation searches and default to all memberships', () => {
  const values = [
    entry(1, 'orchard', 'APPLE meaning', [11]),
    entry(2, 'apple', 'Fruit', [22]),
    entry(3, 'pineapple', 'FRUIT', [11, 22]),
    entry(4, 'pear', 'An apple substitute'),
    entry(5, 'bracket', 'literal.*[value]?', [11]),
    entry(6, 'plain', 'APPLE taste'),
    entry(7, 'other', 'No matching text', [9001]),
  ];
  for (const sort of sorts) {
    assert.deepEqual(selectLibraryEntries(values, 'apple', sort), selectLibraryEntries(values, 'apple', sort, 'all'));
    assert.deepEqual(selectLibraryEntries(values, '', sort, 'all'), selectLibraryEntries(values, '', sort));
    for (const [category, query, expected] of [
      ['all', '  ApPlE\n', [1, 2, 3, 4, 6]],
      ['uncategorized', '', [4, 6]], ['uncategorized', ' APPLE ', [4, 6]],
      [11, '', [1, 3, 5]], [11, ' APPLE ', [1, 3]], [22, ' APPLE ', [2, 3]],
      [11, 'fruit', [3]], [22, 'fruit', [2, 3]],
      [11, '[value]', [5]], [11, '.*', [5]], [22, '[value]', []],
      [1234, '', []], [9001, '9001', []], ['all', '9001', []],
    ] as const) {
      assert.deepEqual(new Set(ids(selectLibraryEntries(values, query, sort, category))), new Set(expected), `${category}: ${query}`);
    }
    assert.deepEqual(selectLibraryEntries([], '', sort, 'uncategorized'), []);
    assert.deepEqual(selectLibraryEntries([], '', sort, 11), []);
  }
});

test('recent ordering uses descending numeric IDs, not creation dates, import order, or words', () => {
  const values = [
    { ...entry(7, 'zulu'), created: '2026-09-28T08:00:00.000Z' },
    { ...entry(99, 'middle'), created: '2000-01-01T00:00:00.000Z' },
    { ...entry(44, 'alpha'), created: '2024-02-29T12:34:56.789Z' },
  ];
  assert.deepEqual(ids(selectLibraryEntries(values, '', 'recent')), [99, 44, 7]);
  assert.deepEqual(ids(selectLibraryEntries(values, 'l', 'recent')), [99, 44, 7]);
});

test('alphabetical ordering uses fixed English base collation with descending IDs for ties', () => {
  const values = [
    entry(7, 'Zulu'), entry(2, 'éclair'), entry(90, 'Echo'), entry(3, 'alpha'),
    entry(20, 'ALPHA'), entry(12, 'Éclair'), entry(4, 'eclair'), entry(1, 'äble'),
  ];
  const expected = [1, 20, 3, 90, 12, 4, 2, 7];
  assert.deepEqual(ids(selectLibraryEntries(values, '', 'alphabetical')), expected);
  assert.deepEqual(ids(selectLibraryEntries([...values].reverse(), '', 'alphabetical')), expected);
  assert.deepEqual(ids(selectLibraryEntries(values, 'alpha', 'alphabetical')), [20, 3]);
});

test('filtering and both sorts never mutate the input array, entry contents or category memberships', () => {
  const values = Object.freeze([
    entry(3, 'zulu', '  Full translation\n  ', [2, 7]),
    entry(1, ' ALPHA ', 'Mixed CASE', [7]),
    entry(2, 'beta', ''),
  ].map(value => {
    Object.freeze(value.categoryIds);
    return Object.freeze(value);
  }));
  const before = structuredClone(values);
  for (const sort of sorts) {
    for (const query of ['', 'full', 'case', 'no match']) {
      for (const category of ['all', 'uncategorized', 2, 7, 999] as const) {
        const selected = selectLibraryEntries(values, query, sort, category);
        for (const value of selected) assert.equal(value, values.find(original => original.id === value.id));
        selected.reverse();
        selected.length = 0;
        assert.deepEqual(values, before);
      }
    }
  }
});

const paginationCases = [
  [0, [[0, 0]]],
  [1, [[1, 1]]],
  [20, [[1, 20]]],
  [21, [[1, 20], [21, 21]]],
  [40, [[1, 20], [21, 40]]],
  [41, [[1, 20], [21, 40], [41, 41]]],
] as const;

for (const [size, ranges] of paginationCases) {
  test(`pagination of ${size} entries keeps fixed twenty-entry pages, inclusive ranges, references and coverage`, () => {
    assert.equal(LIBRARY_PAGE_SIZE, 20);
    const values = Object.freeze(Array.from({ length: size }, (_, index) => Object.freeze(entry(index + 1, `word ${index + 1}`))));
    const before = structuredClone(values);
    const covered: StoredEntry[] = [];
    for (const [index, [start, end]] of ranges.entries()) {
      const result = paginateLibraryEntries(values, index + 1);
      const offset = start ? start - 1 : 0;
      assert.deepEqual(result, {
        page: index + 1, pageCount: ranges.length, start, end,
        entries: values.slice(offset, end),
      });
      assert.notEqual(result.entries, values);
      result.entries.forEach((value, index) => assert.equal(value, values[offset + index]));
      covered.push(...result.entries);
      result.entries.reverse();
      result.entries.length = 0;
      assert.deepEqual(values, before);
    }
    assert.deepEqual(covered, values);
    assert.equal(new Set(ids(covered)).size, size);

    for (const requestedPage of [-Number.MAX_VALUE, -1, 0, 1, 2, 3, 4, Number.MAX_VALUE]) {
      const page = Math.max(1, Math.min(requestedPage, ranges.length));
      const [start, end] = ranges[page - 1];
      assert.deepEqual(paginateLibraryEntries(values, requestedPage), {
        page, pageCount: ranges.length, start, end,
        entries: values.slice(start ? start - 1 : 0, end),
      });
    }
  });
}

test('noninteger and nonfinite requested pages normalize to the first page', () => {
  const values = Array.from({ length: 41 }, (_, index) => entry(index + 1, `word ${index + 1}`));
  for (const requestedPage of [NaN, Infinity, -Infinity, -1.5, 0.5, 1.5, 2.9, Number.MIN_VALUE]) {
    assert.deepEqual(paginateLibraryEntries(values, requestedPage), {
      page: 1, pageCount: 3, start: 1, end: 20, entries: values.slice(0, 20),
    });
    assert.deepEqual(paginateLibraryEntries([], requestedPage), {
      page: 1, pageCount: 1, start: 0, end: 0, entries: [],
    });
  }
});

for (const sort of sorts) {
  test(`pagination slices the globally filtered and ${sort}-sorted result with complete page coverage`, () => {
    const matches = Array.from({ length: 41 }, (_, index) => {
      const id = index + 1;
      return entry(id, `term ${String(id).padStart(2, '0')}${id % 2 ? ' needle' : ''}`, id % 2 ? 'meaning' : 'NEEDLE translation');
    });
    const excluded = Array.from({ length: 22 }, (_, index) => entry(index + 100, `unrelated ${index}`, 'not a match'));
    const values = Object.freeze([...excluded, ...matches.slice(20), ...matches.slice(0, 20)].map(value => Object.freeze(value)));
    const before = structuredClone(values);
    const selected = selectLibraryEntries(values, '  NeEdLe\n', sort);
    const expected = Array.from({ length: 41 }, (_, index) => sort === 'recent' ? 41 - index : index + 1);
    assert.deepEqual(ids(selected), expected);
    const covered: StoredEntry[] = [];
    for (const page of [1, 2, 3]) {
      const result = paginateLibraryEntries(selected, page);
      assert.equal(result.pageCount, 3);
      assert.deepEqual(ids(result.entries), expected.slice((page - 1) * 20, page * 20));
      covered.push(...result.entries);
    }
    assert.deepEqual(ids(covered), expected);
    assert.equal(new Set(ids(covered)).size, matches.length);
    covered.forEach((value, index) => assert.equal(value, selected[index]));
    assert.deepEqual(selected, covered);
    assert.deepEqual(values, before);
  });
}

for (const category of ['uncategorized', 7] as const) {
  for (const sort of sorts) {
    test(`category ${category} and search intersect before ${sort} ordering and pagination`, () => {
      const categoryIds = category === 'uncategorized' ? [] : [category, 9];
      const matches = Array.from({ length: 41 }, (_, index) => {
        const id = index + 1;
        return entry(id, `term ${String(id).padStart(2, '0')}${id % 2 ? ' needle' : ''}`,
          id % 2 ? 'meaning' : 'NEEDLE translation', [...categoryIds]);
      });
      const wrongText = Array.from({ length: 22 }, (_, index) => entry(index + 100, `unrelated ${index}`, 'not a match', [...categoryIds]));
      const wrongCategory = Array.from({ length: 22 }, (_, index) => entry(index + 200,
        index % 2 ? `needle ${index}` : `unrelated ${index}`, index % 2 ? 'meaning' : 'NEEDLE translation', [9]));
      const values = Object.freeze([...wrongText, ...matches.slice(20), ...wrongCategory, ...matches.slice(0, 20)].map(value => {
        Object.freeze(value.categoryIds);
        return Object.freeze(value);
      }));
      const before = structuredClone(values);
      const selected = selectLibraryEntries(values, '  NeEdLe\n', sort, category);
      const expected = Array.from({ length: 41 }, (_, index) => sort === 'recent' ? 41 - index : index + 1);
      assert.deepEqual(ids(selected), expected);
      const covered: StoredEntry[] = [];
      for (const page of [1, 2, 3]) {
        const result = paginateLibraryEntries(selected, page);
        assert.equal(result.pageCount, 3);
        assert.deepEqual(ids(result.entries), expected.slice((page - 1) * 20, page * 20));
        covered.push(...result.entries);
      }
      assert.deepEqual(ids(covered), expected);
      assert.equal(new Set(ids(covered)).size, matches.length);
      covered.forEach((value, index) => assert.equal(value, selected[index]));
      assert.deepEqual(values, before);
    });
  }
}
