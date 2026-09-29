import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTIONARY_LICENSE_URL, lookup, wiktionaryUrl } from '../src/vocabulary';
import { sample, validateEntry } from '../src/entry';
import { parseBackup, serializeBackup } from '../src/backup';
import { MessageError } from '../src/messages';

const dictionary = {
  word: 'could',
  entries: [
    {
      language: { code: 'en', name: 'English' },
      partOfSpeech: 'verb',
      pronunciations: [{ type: 'ipa', text: '/kʊd/' }],
      senses: [
        { definition: 'first meaning' },
        { definition: 'paired meaning', examples: ['A paired example.'] },
      ],
    },
  ],
  source: {
    url: 'https://en.wiktionary.org/wiki/could',
    license: { name: 'CC BY-SA 4.0', url: DICTIONARY_LICENSE_URL },
  },
};
const translation = { responseStatus: 200, responseData: { translatedText: '能够' } };
const json = (value: unknown) => new Response(JSON.stringify(value));
const isDictionary = (url: string) => new URL(url).hostname === 'freedictionaryapi.com';
const respond = (dict: unknown = dictionary, trans: unknown = translation) =>
  async (url: string) => json(isDictionary(url) ? dict : trans);

const withSenses = (senses: unknown[], overrides: Record<string, unknown> = {}) => ({
  ...dictionary,
  entries: [{ ...dictionary.entries[0], senses, ...overrides }],
});

test('new endpoint keeps dictionary meaning and example paired with Chinese translation', async () => {
  const calls: string[] = [];
  const result = await lookup(' COULD ', async (url, options) => {
    calls.push(url);
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    return respond()(url);
  });
  assert.equal(calls[0], 'https://freedictionaryapi.com/api/v1/entries/en/could?translations=true');
  assert.equal(new URL(calls[1]).hostname, 'api.mymemory.translated.net');
  assert.equal(new URL(calls[1]).searchParams.get('q'), 'could');
  assert.equal(new URL(calls[1]).searchParams.get('langpair'), 'en|zh-CN');
  assert.equal(result.entry.word, 'could');
  assert.equal(result.entry.definition, 'paired meaning');
  assert.equal(result.entry.example, 'A paired example.');
  assert.equal(result.entry.translation, '能够');
  assert.equal(result.entry.pos, 'Verb');
  assert.equal(result.entry.phonetic, '/kʊd/');
  assert.match(result.entry.source, /FreeDictionaryAPI\.com/);
  assert.match(result.entry.source, /MyMemory（机器翻译）/);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 2);
});

test('same-sense Chinese translations take priority over MyMemory and are deduplicated', async () => {
  const dict = withSenses([{
    definition: 'paired meaning', examples: ['A paired example.'],
    translations: [
      { language: { code: 'cmn' }, word: ' 能够 ' },
      { language: { code: 'zh' }, word: '可以' },
      { language: { code: 'cmn' }, word: '能够' },
      { language: { code: 'fr' }, word: '错误语言' },
      { language: { code: 'cmn' }, word: 'English only' },
      { language: { code: 'cmn' }, word: {} },
    ],
  }]);
  const result = await lookup('could', respond(dict, {
    responseStatus: 200, responseData: { translatedText: '不应采用的机器译文' },
  }));
  assert.equal(result.entry.translation, '能够；可以');
  assert.doesNotMatch(result.entry.source, /MyMemory/);
  assert.deepEqual(result.warnings, []);
});

test('Chinese from another sense is not paired with the selected definition', async () => {
  const dict = withSenses([
    { definition: 'first', translations: [{ language: { code: 'cmn' }, word: '另一个义项' }] },
    { definition: 'paired', examples: ['Paired example.'] },
  ]);
  const result = await lookup('could', respond(dict));
  assert.equal(result.entry.definition, 'paired');
  assert.equal(result.entry.example, 'Paired example.');
  assert.equal(result.entry.translation, '能够');
  assert.match(result.entry.source, /MyMemory/);
});

test('nested senses keep their own definition, example and Chinese translation', async () => {
  const dict = withSenses([{
    translations: [{ language: { code: 'cmn' }, word: '不能拼入的父义项' }],
    subsenses: [{
      definition: 'child meaning', examples: ['Child example.'],
      translations: [{ language: { code: 'cmn' }, word: '子义项' }],
    }],
  }]);
  const result = await lookup('could', respond(dict));
  assert.equal(result.entry.definition, 'child meaning');
  assert.equal(result.entry.example, 'Child example.');
  assert.equal(result.entry.translation, '子义项');
  assert.doesNotMatch(result.entry.source, /MyMemory/);
});

test('only an exact word and English entries can populate dictionary fields', async () => {
  for (const dict of [
    { ...dictionary, word: 'would' },
    { ...dictionary, entries: [{ ...dictionary.entries[0], language: { code: 'fr' } }] },
    { ...dictionary, entries: [null, { senses: 'invalid' }] },
  ]) {
    const result = await lookup('could', respond(dict));
    assert.equal(result.entry.definition, '');
    assert.equal(result.entry.phonetic, '');
    assert.equal(result.entry.translation, '能够');
    assert.equal(result.entry.source, 'MyMemory（机器翻译）');
  }
  const dict = {
    ...dictionary,
    entries: [
      { ...dictionary.entries[0], language: { code: 'fr' }, senses: [{ definition: 'wrong language' }] },
      ...dictionary.entries,
    ],
  };
  assert.equal((await lookup('could', respond(dict))).entry.definition, 'paired meaning');
});

test('only nonempty IPA is used for phonetics', async () => {
  const dict = withSenses([{ definition: 'meaning' }], {
    pronunciations: [
      { type: 'audio', text: 'not phonetic' },
      { type: 'ipa', text: {} },
      { type: 'ipa', text: ' /kʊd/ ' },
    ],
  });
  assert.equal((await lookup('could', respond(dict))).entry.phonetic, '/kʊd/');
});

test('invalid or missing attribution does not populate uncredited dictionary content', async () => {
  for (const source of [
    null,
    { ...dictionary.source, url: 'javascript:alert(1)' },
    { ...dictionary.source, url: 'https://en.wiktionary.org.evil.example/wiki/could' },
    { ...dictionary.source, license: { name: 'unknown', url: DICTIONARY_LICENSE_URL } },
    { ...dictionary.source, license: { name: 'CC BY-SA 4.0', url: 'https://example.com/license' } },
  ]) {
    const result = await lookup('could', respond({ ...dictionary, source }));
    assert.equal(result.entry.definition, '');
    assert.equal(result.entry.source, 'MyMemory（机器翻译）');
  }
});

test('Wiktionary source links accept only bounded HTTPS article URLs', () => {
  assert.equal(wiktionaryUrl(dictionary.source.url), dictionary.source.url);
  assert.equal(wiktionaryUrl(dictionary.source.url + '#English'), dictionary.source.url + '#English');
  for (const url of [
    null, {}, 'javascript:alert(1)', 'http://en.wiktionary.org/wiki/could',
    'https://en.wiktionary.org.evil.example/wiki/could',
    'https://user:password@en.wiktionary.org/wiki/could',
    'https://en.wiktionary.org:8443/wiki/could',
    'https://en.wiktionary.org/w/index.php?title=could',
    'https://en.wiktionary.org/wiki/', 'https://en.wiktionary.org/wiki/could?redirect=elsewhere',
    'https://en.wiktionary.org/wiki/co\nuld', 'https://en.wiktionary.org/wiki/' + 'a'.repeat(1000),
  ]) assert.equal(wiktionaryUrl(url), '');
});

test('edited word and backup round trip retain the original dictionary attribution', async () => {
  const result = await lookup('could', respond());
  const edited = validateEntry({ ...result.entry, word: 'would' });
  const created = '2026-09-29T00:00:00.000Z';
  const restored = parseBackup(serializeBackup([{ ...edited, id: 1, created }], created));
  assert.equal(restored[0].word, 'would');
  assert.equal(restored[0].source, result.entry.source);
  assert.ok(restored[0].source.includes(dictionary.source.url));
  assert.ok(restored[0].source.includes(DICTIONARY_LICENSE_URL));
  assert.doesNotMatch(restored[0].source, /wiki\/would/);
});

test('empty successful responses do not receive dictionary attribution', async () => {
  const result = await lookup('could', respond({ ...dictionary, entries: [] }, {}));
  assert.equal(result.entry.source, '手动填写');
  assert.equal(result.warnings.length, 4);
});

test('upstream failure leaves an editable draft and missing-content warnings', async () => {
  const result = await lookup('curious', async () => { throw new Error('unavailable'); });
  assert.equal(result.entry.word, 'curious');
  assert.equal(result.entry.definition, '');
  assert.equal(result.entry.example, '');
  assert.equal(result.entry.source, '手动填写');
  assert.equal(result.warnings.length, 4);
  assert.deepEqual(result.warnings, [
    { code: 'dictionaryUnavailable' }, { code: 'missingTranslation' },
    { code: 'missingExample' }, { code: 'missingPhonetic' },
  ]);
  assert.deepEqual(validateEntry(result.entry), result.entry);
});

test('one failed upstream does not discard the other result', async () => {
  const result = await lookup('could', async (url) =>
    isDictionary(url) ? new Response('', { status: 522 }) : json(translation),
  );
  assert.equal(result.entry.translation, '能够');
  assert.equal(result.entry.definition, '');
  assert.equal(result.entry.source, 'MyMemory（机器翻译）');
  assert.deepEqual(result.warnings, [
    { code: 'dictionaryUnavailable' }, { code: 'missingExample' }, { code: 'missingPhonetic' },
  ]);
  const dictionaryOnly = await lookup('could', async (url) =>
    isDictionary(url) ? json(dictionary) : new Response('', { status: 429 }),
  );
  assert.equal(dictionaryOnly.entry.definition, 'paired meaning');
  assert.equal(dictionaryOnly.entry.translation, '');
  assert.doesNotMatch(dictionaryOnly.entry.source, /MyMemory/);
  assert.deepEqual(dictionaryOnly.warnings, [{ code: 'missingTranslation' }]);
});

test('missing examples fall back to the first valid definition', async () => {
  const result = await lookup('could', respond(
    withSenses([{ definition: 'first' }, { definition: 'second' }]),
    { responseStatus: 403, responseData: { translatedText: '错误信息' } },
  ));
  assert.equal(result.entry.definition, 'first');
  assert.equal(result.entry.example, '');
  assert.equal(result.entry.translation, '');
});

test('malformed upstream data cannot populate non-string fields', async () => {
  const result = await lookup('could', respond(
    withSenses([null, { definition: {}, examples: [{}], translations: [null] }], {
      pronunciations: [{ type: 'ipa', text: {} }], partOfSpeech: [],
    }),
    { responseStatus: 200, responseData: { translatedText: ['中文'] } },
  ));
  assert.deepEqual(validateEntry(result.entry), result.entry);
  assert.equal(result.entry.translation, '');
  assert.equal(result.entry.source, '手动填写');
  assert.equal(result.warnings.length, 4);
});

test('invalid JSON and non-Chinese translations become editable missing fields', async () => {
  const result = await lookup('word', async (url) =>
    isDictionary(url) ? new Response('not JSON') : json({ responseStatus: 200, responseData: { translatedText: 'word' } }),
  );
  assert.equal(result.entry.translation, '');
  assert.equal(result.warnings.length, 4);
});

test('invalid input never reaches an external service', async () => {
  await assert.rejects(lookup('../invalid', async () => { assert.fail('must not fetch'); }), error => {
    assert.ok(error instanceof MessageError);
    assert.match(error.message, /有效的英语/);
    assert.deepEqual(error.detail, { code: 'invalidWord' });
    return true;
  });
});

test('the explicit sample remains available without network requests', async () => {
  const result = await lookup('Investigation', async () => { assert.fail('sample does not need a network request'); });
  assert.deepEqual(result, { entry: sample, warnings: [] });
  assert.notEqual(result.entry, sample);
});

test('cancelling a lookup aborts both requests and does not return a stale draft', async () => {
  const controller = new AbortController();
  let aborted = 0;
  const promise = lookup(
    'curious',
    async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(options.signal?.reason);
      });
    }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(aborted, 2);
});

test('a pre-cancelled lookup does not fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lookup('word', undefined, controller.signal), { name: 'AbortError' });
});

test('30-second timeouts abort both upstreams and return an editable draft', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = 0;
  const promise = lookup('curious', async (_url, options) =>
    new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(options.signal?.reason);
      });
    }),
  );
  context.mock.timers.tick(29999);
  assert.equal(aborted, 0);
  context.mock.timers.tick(1);
  const result = await promise;
  assert.equal(aborted, 2);
  assert.equal(result.entry.word, 'curious');
  assert.equal(result.warnings.length, 4);
});
