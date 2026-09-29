import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntry, sample, validWord, validateCreated, validateDatedEntry, validateEntry } from '../src/entry';

const created = '2024-02-29T12:34:56.789Z';

test('词条只保留七个业务字段，统一 trim 和单词大小写', () => {
  const input = {
    ...sample,
    word: '  Well-KNOWN  ',
    phonetic: ' /test/ ',
    translation: ' 测试 ',
    pos: ' Noun ',
    definition: '\nA test.\t',
    example: ' A test example. ',
    source: ' 手动填写 ',
    id: 900,
    created: 'not a date',
    extra: 'ignored',
  };
  assert.deepEqual(validateEntry(input), {
    word: 'well-known',
    phonetic: '/test/',
    translation: '测试',
    pos: 'Noun',
    definition: 'A test.',
    example: 'A test example.',
    source: '手动填写',
  });
  assert.equal(input.word, '  Well-KNOWN  ');
  const validated = validateEntry(JSON.parse(JSON.stringify({ ...input, __proto__: null })));
  assert.deepEqual(Object.keys(validated).sort(), Object.keys(sample).sort());
});

test('createEntry 返回可编辑、相互独立的合法草稿', () => {
  const entry = createEntry('  Apple  ');
  assert.deepEqual(entry, {
    word: 'apple', phonetic: '', translation: '', pos: '', definition: '', example: '', source: '手动填写',
  });
  assert.deepEqual(validateEntry(entry), entry);
  entry.translation = '苹果';
  assert.equal(createEntry('apple').translation, '');
  assert.deepEqual(validateEntry(sample), sample);
});

test('单词字符和长度边界统一校验', () => {
  for (const word of ['apple', '  Apple  ', "don't", 'well-known', 'ice cream', 'a'.repeat(80)])
    assert.equal(validWord(word), true, word);
  for (const word of ['', '  ', 'a'.repeat(81), '123', 'apple1', '中文', 'café', 'a_b', 'a/b', 'a\nb', '-apple', "'apple", null, 5, {}]) {
    assert.equal(validWord(word), false, String(word));
    assert.throws(() => validateEntry({ ...sample, word }), /英语单词或短语/);
  }
});

test('所有字段必填且必须为 string，正文长度不超过 2000', () => {
  for (const value of [null, undefined, [], '', 1])
    assert.throws(() => validateEntry(value), /内容无效/);
  for (const key of Object.keys(sample)) {
    const missing: Record<string, unknown> = { ...sample };
    delete missing[key];
    assert.throws(() => validateEntry(missing), Error, `missing ${key}`);
    for (const value of [undefined, null, 42, false, [], {}])
      assert.throws(() => validateEntry({ ...sample, [key]: value }), Error, key);
  }
  for (const key of ['phonetic', 'translation', 'pos', 'definition', 'example', 'source'] as const) {
    assert.equal(validateEntry({ ...sample, [key]: 'x'.repeat(2000) })[key].length, 2000);
    assert.equal(validateEntry({ ...sample, [key]: '' })[key], '');
    assert.throws(() => validateEntry({ ...sample, [key]: 'x'.repeat(2001) }), /内容无效或过长/);
    assert.throws(() => validateEntry({ ...sample, [key]: ' '.repeat(2001) }), /内容无效或过长/);
  }
});

test('日期只接受能严格往返的 UTC ISO 字符串', () => {
  for (const value of [created, '1970-01-01T00:00:00.000Z', '2026-09-28T08:00:00.000Z'])
    assert.equal(validateCreated(value), value);
  for (const value of [
    '', null, undefined, 0, new Date(created), 'not a date',
    '2024-02-29', '2024-02-29T12:34:56Z', '2024-02-29T12:34:56.789+00:00',
    '2024-02-29T20:34:56.789+08:00', '2023-02-29T12:34:56.789Z',
    '2024-02-30T12:34:56.789Z', '2024-13-01T00:00:00.000Z',
    '2024-02-29T24:00:00.000Z', ` ${created}`, `${created} `, 'x'.repeat(31),
  ]) assert.throws(() => validateCreated(value), /创建时间无效/, String(value));
});

test('备份词条复用业务校验和日期校验，丢弃本地 ID 及未知字段', () => {
  assert.deepEqual(validateDatedEntry({ ...sample, word: ' APPLE ', created, id: 99, extra: true }), {
    ...sample, word: 'apple', created,
  });
  assert.throws(() => validateDatedEntry(sample), /创建时间无效/);
  assert.throws(() => validateDatedEntry({ ...sample, created, example: null }), /内容无效/);
  assert.throws(() => validateDatedEntry({ ...sample, created: '2024-01-01' }), /创建时间无效/);
});
