import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTIONARY_LICENSE_URL, lookup, wiktionaryUrl, type TranslationOptions } from '../src/vocabulary';
import { sample, validateEntry } from '../src/entry';
import { parseBackup, serializeBackup } from '../src/backup';
import { MessageError, type Message } from '../src/messages';

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
const englishDictionary = {
  word: 'could',
  pronunciation: {
    ipa: ' /kʊd/ ', enpr: 'ko͝od',
    audioUrl: 'https://audio.example/en-us-could.ogg',
  },
  partsOfSpeech: [{
    partOfSpeech: 'verb',
    senses: [
      { definition: 'first meaning', example: null },
      { definition: 'paired meaning', example: 'A paired example.' },
    ],
  }],
};
const providers = ['free-dictionary', 'english-dictionary'] as const;
const fixtures = { 'free-dictionary': dictionary, 'english-dictionary': englishDictionary };
const providerNames = { 'free-dictionary': 'FreeDictionaryAPI.com', 'english-dictionary': 'EnglishDictionaryAPI.com' };
const endpoints = {
  'free-dictionary': (word: string) => 'https://freedictionaryapi.com/api/v1/entries/en/' + encodeURIComponent(word) + '?translations=true',
  'english-dictionary': (word: string) => 'https://englishdictionaryapi.com/api/v1/words/' + encodeURIComponent(word),
};
const translationUrl = (word: string) =>
  'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en%7Czh-CN';
const missingWarnings = [
  { code: 'dictionaryUnavailable' }, { code: 'missingTranslation' },
  { code: 'missingExample' }, { code: 'missingPhonetic' },
];
const translation = { responseStatus: 200, responseData: { translatedText: '能够' } };
const baiduCredentials = Object.freeze({ appid: '123456789', key: 'synthetic-key-only' });
const baiduSource = 'Baidu（机器翻译）';
const baiduTranslation = (word = 'could') => ({ from: 'en', to: 'zh', trans_result: [{ src: word, dst: '能够' }] });
const baiduOptions = { provider: 'baidu', credentials: baiduCredentials } satisfies TranslationOptions;
const privateDiagnostic = 'Synthetic credential diagnostic: ' + JSON.stringify(baiduCredentials);
const baiduFailures: {
  code: Message['code'];
  credentials: TranslationOptions['credentials'];
  transport: NonNullable<TranslationOptions['transport']>;
  calls: number;
}[] = [
  { code: 'baiduNotConfigured', credentials: undefined, transport: async () => baiduTranslation(), calls: 0 },
  { code: 'baiduNotConfigured', credentials: null, transport: async () => baiduTranslation(), calls: 0 },
  { code: 'baiduInvalidCredentials', credentials: { ...baiduCredentials, appid: '' }, transport: async () => baiduTranslation(), calls: 0 },
  ...([
    ['baiduAuthFailed', '54001'], ['baiduRateLimited', '54003'], ['baiduQuota', '54004'],
    ['baiduIpBlocked', '58000'], ['baiduUnavailable', '52002'],
  ] as const).map(([code, error_code]) => ({
    code, credentials: baiduCredentials, calls: 1,
    transport: async () => ({ error_code, error_msg: privateDiagnostic }),
  })),
  {
    code: 'baiduInvalidResponse', credentials: baiduCredentials, calls: 1,
    transport: async () => baiduTranslation('would'),
  },
  {
    code: 'baiduUnavailable', credentials: baiduCredentials, calls: 1,
    transport: async (url) => { throw new Error(url + ' ' + privateDiagnostic); },
  },
  {
    code: 'baiduTimedOut', credentials: baiduCredentials, calls: 1,
    transport: async () => { throw new MessageError({ code: 'baiduTimedOut' }, { cause: new Error(privateDiagnostic) }); },
  },
];
function assertNoBaiduSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(serialized);
  for (const secret of Object.values(baiduCredentials)) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /(?:appid|salt|sign|key)=/);
}
const json = (value: unknown) => new Response(JSON.stringify(value));
const isDictionary = (url: string) => ['freedictionaryapi.com', 'englishdictionaryapi.com'].includes(new URL(url).hostname);
const respond = (dict: unknown = dictionary, trans: unknown = translation) =>
  async (url: string) => {
    if (isDictionary(url)) return json(dict);
    assert.equal(new URL(url).hostname, 'api.mymemory.translated.net');
    return json(trans);
  };
const unavailable = [
  { name: 'network rejection', response: async (): Promise<Response> => { throw new Error('unavailable'); } },
  { name: 'HTTP 429', response: async () => new Response('', { status: 429 }) },
  { name: 'HTTP 522', response: async () => new Response('', { status: 522 }) },
  { name: 'invalid JSON', response: async () => new Response('not JSON') },
];

const withSenses = (senses: unknown[], overrides: Record<string, unknown> = {}) => ({
  ...dictionary,
  entries: [{ ...dictionary.entries[0], senses, ...overrides }],
});
const withEnglishSenses = (senses: unknown[], overrides: Record<string, unknown> = {}) => ({
  ...englishDictionary,
  partsOfSpeech: [{ ...englishDictionary.partsOfSpeech[0], senses, ...overrides }],
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

test('same-sense dictionary Chinese wins over Baidu without hiding Baidu failures', async (context) => {
  const dict = withSenses([{
    definition: 'paired meaning', examples: ['A paired example.'],
    translations: [
      { language: { code: 'cmn' }, word: '词典译文' },
      { language: { code: 'zh' }, word: '词典译文' },
    ],
  }]);
  const source = 'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/could' +
    ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑';
  const cases = [{ ...baiduOptions, transport: async () => baiduTranslation(), calls: 1, code: undefined }, ...baiduFailures];
  for (const failure of cases) {
    const calls: string[] = [];
    const transport = context.mock.fn(failure.transport);
    const result = await lookup('could', async (url) => {
      calls.push(url);
      return json(dict);
    }, undefined, 'free-dictionary', { ...baiduOptions, credentials: failure.credentials, transport });
    assert.deepEqual(calls, [endpoints['free-dictionary']('could')]);
    assert.equal(transport.mock.callCount(), failure.calls);
    assert.deepEqual(result.entry, {
      word: 'could', phonetic: '/kʊd/', pos: 'Verb', definition: 'paired meaning',
      example: 'A paired example.', translation: '词典译文', source,
    });
    assert.deepEqual(result.warnings, failure.code ? [{ code: failure.code }] : []);
    assertNoBaiduSecrets(result);
  }
});

test('Baidu fills the selected sense rather than borrowing another sense’s Chinese', async (context) => {
  const dict = withSenses([
    { definition: 'first', translations: [{ language: { code: 'cmn' }, word: '另一个义项' }] },
    { definition: 'paired', examples: ['Paired example.'] },
  ]);
  const transport = context.mock.fn(async () => baiduTranslation());
  const result = await lookup('could', respond(dict), undefined, 'free-dictionary', { ...baiduOptions, transport });
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(result.entry.definition, 'paired');
  assert.equal(result.entry.example, 'Paired example.');
  assert.equal(result.entry.translation, '能够');
  assert.equal(result.entry.source.split(' | ').at(-1), baiduSource);
  assert.doesNotMatch(result.entry.source, /MyMemory/);
  assert.deepEqual(result.warnings, []);
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

test('US and UK IPA are ordered and labeled without changing the selected sense', async () => {
  const dict = {
    ...withSenses([{
      definition: 'A round edible fruit.', examples: ['Slice the tomato.'],
      translations: [{ language: { code: 'cmn' }, word: '番茄' }],
    }], {
      partOfSpeech: 'noun',
      pronunciations: [
        { type: 'ipa', text: '/təˈmɑː.təʊ/', tags: ['General Australian', 'Received Pronunciation'] },
        { type: 'ipa', text: '/təˈmeɪ.toʊ/', tags: ['US'] },
      ],
    }),
    word: 'tomato',
    source: { ...dictionary.source, url: 'https://en.wiktionary.org/wiki/tomato' },
  };
  const result = await lookup('tomato', respond(dict));
  assert.equal(result.entry.phonetic, 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/');
  assert.equal(result.entry.pos, 'Noun');
  assert.equal(result.entry.definition, 'A round edible fruit.');
  assert.equal(result.entry.example, 'Slice the tomato.');
  assert.equal(result.entry.translation, '番茄');
  assert.equal(result.entry.source,
    'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/tomato' +
    ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑');
  assert.deepEqual(result.warnings, []);
});

test('General American IPA takes priority over untagged IPA and accepts other coexisting tags', async () => {
  const dict = {
    ...withSenses([{ definition: 'A timetable.' }], {
      pronunciations: [
        { type: 'ipa', text: '/ˈʃɛd͡ʒuːl/', tags: [] },
        { type: 'ipa', text: '/ˈskɛd͡ʒʊl/', tags: ['General American', 'Philippines'] },
      ],
    }),
    word: 'schedule',
    source: { ...dictionary.source, url: 'https://en.wiktionary.org/wiki/schedule' },
  };
  assert.equal((await lookup('schedule', respond(dict))).entry.phonetic, 'US /ˈskɛd͡ʒʊl/');
});

test('accent tags are trimmed and case-insensitive while malformed tag values are ignored', async () => {
  for (const tags of [[' us '], [' gEnErAl AmErIcAn '], [null, {}, 1, ['US'], 'US']]) {
    const dict = withSenses([{ definition: 'meaning' }], {
      pronunciations: [
        { type: 'ipa', text: '/first/', tags: [' rEcEiVeD pRoNuNcIaTiOn '] },
        { type: 'ipa', text: ' /preferred/ ', tags },
      ],
    });
    assert.equal((await lookup('could', respond(dict))).entry.phonetic, 'US /preferred/ · UK /first/');
  }
});

test('equivalent accent tags preserve upstream order within each accent', async () => {
  for (const tags of [['US', 'General American'], ['General American', 'US']]) {
    const dict = withSenses([{ definition: 'meaning' }], {
      pronunciations: [
        { type: 'ipa', text: '/first-british/', tags: ['UK'] },
        { type: 'ipa', text: '/first-american/', tags: [tags[0]] },
        { type: 'ipa', text: '/second-american/', tags: [tags[1]] },
        { type: 'ipa', text: '/second-british/', tags: ['Received Pronunciation'] },
      ],
    });
    assert.equal((await lookup('could', respond(dict))).entry.phonetic, 'US /first-american/ · UK /first-british/');
  }
});

test('missing or invalid American tags cannot supplement or replace a known UK accent', async () => {
  for (const tags of [undefined, null, 'US', { region: 'US' }, [], [null, 42, {}, ['US']], ['UK'], ['Latin American'], ['US English']]) {
    const dict = withSenses([{ definition: 'meaning' }], {
      pronunciations: [
        { type: 'ipa', text: '/first/', tags: ['Received Pronunciation'] },
        { type: 'ipa', text: '/later/', tags },
        { type: 'ipa', text: '/untagged/' },
      ],
    });
    assert.equal((await lookup('could', respond(dict))).entry.phonetic, 'UK /first/');
  }
});

test('only unknown accents retain raw IPA, while identical IPA with both tags retains both labels', async () => {
  for (const tags of [null, 'US', ['US English', 'UK English'], ['General Australian'], [42, ['UK']]]) {
    const dict = withSenses(dictionary.entries[0].senses, {
      pronunciations: [{ type: 'ipa', text: ' /raw/ ', tags }, { type: 'ipa', text: '/later/' }],
    });
    assert.equal((await lookup('could', respond(dict))).entry.phonetic, '/raw/');
  }
  const dict = withSenses(dictionary.entries[0].senses, {
    pronunciations: [{ type: 'ipa', text: '/same/', tags: ['US', 'UK'] }],
  });
  assert.equal((await lookup('could', respond(dict))).entry.phonetic, 'US /same/ · UK /same/');
});

test('American tags cannot promote empty, malformed or non-IPA pronunciations', async () => {
  const invalid = [
    null,
    { type: 'ipa', text: ' ', tags: ['US'] },
    { type: 'ipa', text: {}, tags: ['US'] },
    { type: 'enpr', text: 'not IPA', tags: ['US'] },
    { type: 'audio', text: 'not IPA', tags: ['General American'] },
  ];
  for (const pronunciations of [
    [...invalid, { type: 'ipa', text: '/fallback/', tags: ['UK'] }],
    [...invalid, { type: 'ipa', text: '/fallback/', tags: ['UK'] }, { type: 'ipa', text: '/american/', tags: ['US'] }],
  ]) {
    const dict = withSenses([{ definition: 'meaning' }], { pronunciations });
    const expected = pronunciations.length === invalid.length + 1 ? 'UK /fallback/' : 'US /american/ · UK /fallback/';
    assert.equal((await lookup('could', respond(dict))).entry.phonetic, expected);
  }
  const result = await lookup('could', respond(withSenses([{ definition: 'meaning' }], { pronunciations: invalid })));
  assert.equal(result.entry.phonetic, '');
  assert.ok(result.warnings.some((warning) => warning.code === 'missingPhonetic'));
});

test('American IPA from another entry cannot replace or supplement the selected entry pronunciation', async () => {
  const selected = {
    ...dictionary.entries[0],
    pronunciations: [{ type: 'ipa', text: '/selected/', tags: ['UK'] }],
  };
  const american = {
    ...dictionary.entries[0],
    partOfSpeech: 'noun',
    pronunciations: [{ type: 'ipa', text: '/other/', tags: ['US'] }],
    senses: [{ definition: 'another meaning', examples: ['Another example.'] }],
  };
  for (const entries of [
    [selected, american],
    [{ ...american, senses: [] }, selected],
    [{ ...american, language: { code: 'fr', name: 'French' } }, selected],
  ]) {
    const result = await lookup('could', respond({ ...dictionary, entries }));
    assert.equal(result.entry.phonetic, 'UK /selected/');
    assert.equal(result.entry.pos, 'Verb');
    assert.equal(result.entry.definition, 'paired meaning');
    assert.equal(result.entry.example, 'A paired example.');
  }
  const result = await lookup('could', respond({
    ...dictionary, entries: [{ ...selected, pronunciations: [] }, american],
  }));
  assert.equal(result.entry.phonetic, '');
});

test('lookup respects the 2000-character phonetic limit without truncating IPA or labels', async () => {
  const long = '/' + 'a'.repeat(1985) + '/';
  for (const [pronunciations, expected, omitted] of [
    [[{ type: 'ipa', text: '/us/', tags: ['US'] }, { type: 'ipa', text: long, tags: ['UK'] }], 'US /us/ · UK ' + long, false],
    [[{ type: 'ipa', text: '/us/', tags: ['US'] }, { type: 'ipa', text: long + 'a', tags: ['UK'] }], 'US /us/', true],
    [[{ type: 'ipa', text: 'a'.repeat(1997), tags: ['US'] }], 'US ' + 'a'.repeat(1997), false],
    [[{ type: 'ipa', text: 'a'.repeat(1998), tags: ['US'] }, { type: 'ipa', text: '/uk/', tags: ['UK'] }], 'UK /uk/', true],
    [[{ type: 'ipa', text: 'a'.repeat(2000) }], 'a'.repeat(2000), false],
    [[{ type: 'ipa', text: 'a'.repeat(2001) }], '', true],
  ] as const) {
    const result = await lookup('could', respond(withSenses(dictionary.entries[0].senses, { pronunciations })));
    assert.equal(result.entry.phonetic, expected);
    assert.equal(result.warnings.some((warning) => warning.code === 'phoneticOmitted'), omitted);
    assert.equal(result.warnings.some((warning) => warning.code === 'missingPhonetic'), !expected);
    assert.deepEqual(validateEntry(result.entry), result.entry);
  }
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

test('FreeDictionary missing examples fall back to the first valid definition', async () => {
  const result = await lookup('could', respond(
    withSenses([{ definition: 'first' }, { definition: 'second' }]),
    { responseStatus: 403, responseData: { translatedText: '错误信息' } },
  ));
  assert.equal(result.entry.definition, 'first');
  assert.equal(result.entry.example, '');
  assert.equal(result.entry.translation, '');
});

test('FreeDictionary malformed upstream data cannot populate non-string fields', async () => {
  const result = await lookup('could', respond(
    withSenses([null, { definition: {}, examples: [{}], translations: [null] }], {
      pronunciations: [{ type: 'ipa', text: {} }], partOfSpeech: [],
    }),
    { responseStatus: 200, responseData: { translatedText: ['中文'] } },
  ));
  assert.deepEqual(validateEntry(result.entry), result.entry);
  assert.equal(result.entry.source, '手动填写');
  assert.deepEqual(result.warnings, missingWarnings);
});

test('EnglishDictionary selects the first usable POS and a paired singular example', async () => {
  const dict = {
    ...englishDictionary,
    partsOfSpeech: [
      null,
      { partOfSpeech: 'adjective', senses: [null, { definition: ' ', example: 'Wrong POS.' }] },
      ...englishDictionary.partsOfSpeech,
      { partOfSpeech: 'noun', senses: [{ definition: 'later POS', example: 'Later example.' }] },
    ],
  };
  const result = await lookup('could', respond(dict), undefined, 'english-dictionary');
  assert.equal(result.entry.pos, 'Verb');
  assert.equal(result.entry.definition, 'paired meaning');
  assert.equal(result.entry.example, 'A paired example.');
  assert.equal(result.entry.phonetic, '/kʊd/');
  const first = {
    ...dict,
    partsOfSpeech: [{ partOfSpeech: 'adverb', senses: [{ definition: 'first POS without example' }] }, ...dict.partsOfSpeech],
  };
  const fallback = await lookup('could', respond(first), undefined, 'english-dictionary');
  assert.equal(fallback.entry.pos, 'Adverb');
  assert.equal(fallback.entry.definition, 'first POS without example');
  assert.equal(fallback.entry.example, '');
  assert.deepEqual(fallback.warnings, [{ code: 'missingExample' }]);
});

test('EnglishDictionary never borrows an example from an undefined sense or an examples array', async () => {
  for (const example of [undefined, null, {}, [], ['Not a singular example.'], 7, '', ' ']) {
    const dict = withEnglishSenses([
      null, { definition: null, example: 'Not this sense.' },
      { definition: 'first' },
      { definition: 'second', example, examples: ['Wrong schema.'] },
    ]);
    const result = await lookup('could', respond(dict), undefined, 'english-dictionary');
    assert.equal(result.entry.definition, 'first');
    assert.equal(result.entry.example, '');
    assert.deepEqual(result.warnings, [{ code: 'missingExample' }]);
  }
  const result = await lookup('could', respond(withEnglishSenses([
    { definition: 'first', example: [] },
    { definition: ' paired ', example: ' A singular example. ' },
    { definition: 'later', example: 'Later example.' },
  ])), undefined, 'english-dictionary');
  assert.equal(result.entry.definition, 'paired');
  assert.equal(result.entry.example, 'A singular example.');
});

test('EnglishDictionary reads only root IPA and never infers accents from tags, enpr or audio filenames', async () => {
  for (const pronunciation of [null, [], '/not-an-object/', { ipa: null }, { ipa: {} }, { ipa: [] }, { ipa: ' ' },
    { enpr: 'ko͝od', audioUrl: 'https://audio.example/en-us-could.ogg' }]) {
    const dict = {
      ...withEnglishSenses(englishDictionary.partsOfSpeech[0].senses, {
        pronunciation: { ipa: '/wrong-level/' }, pronunciations: [{ type: 'ipa', text: '/wrong-schema/', tags: ['US'] }],
      }),
      pronunciation,
    };
    const result = await lookup('could', respond(dict), undefined, 'english-dictionary');
    assert.equal(result.entry.phonetic, '');
    assert.equal(result.entry.definition, 'paired meaning');
    assert.deepEqual(result.warnings, [{ code: 'missingPhonetic' }]);
  }
  const result = await lookup('could', respond({
    ...englishDictionary, pronunciation: { ipa: ' /raw/ ', tags: ['US', 'UK'], audioUrl: 'https://audio.example/en-uk-could.ogg' },
  }), undefined, 'english-dictionary');
  assert.equal(result.entry.phonetic, '/raw/');
});

test('EnglishDictionary malformed collections remain editable and ignore unrelated schema fields', async () => {
  for (const partsOfSpeech of [null, {}, 'verb', [null, [], { partOfSpeech: [], senses: [null, { definition: {} }] }],
    [{ partOfSpeech: 'noun', senses: 'meaning' }], [{ partOfSpeech: 'verb', definitions: [{ definition: 'wrong schema' }] }]]) {
    const result = await lookup('could', respond({ ...englishDictionary, pronunciation: null, partsOfSpeech }, {}), undefined, 'english-dictionary');
    assert.deepEqual(result.warnings, missingWarnings);
    assert.equal(result.entry.source, '手动填写');
    assert.deepEqual(validateEntry(result.entry), result.entry);
  }
  const result = await lookup('could', respond(withEnglishSenses([
    { definition: 'a'.repeat(2001), example: 'b'.repeat(2001) },
  ], { partOfSpeech: {} })), undefined, 'english-dictionary');
  assert.equal(result.entry.pos, '');
  assert.equal(result.entry.definition.length, 2000);
  assert.equal(result.entry.example.length, 2000);
  assert.deepEqual(validateEntry(result.entry), result.entry);
});

test('EnglishDictionary uses documented attribution, not upstream URLs, licensing claims or Chinese fields', async () => {
  const dict = {
    ...withEnglishSenses([{ definition: 'meaning', example: 'Example.', translations: [{ language: { code: 'zh' }, word: '错误字段' }] }]),
    source: { url: 'javascript:alert(1)', license: { name: 'other', url: 'https://evil.example/' } },
    translation: '错误字段',
  };
  const result = await lookup('could', respond(dict), undefined, 'english-dictionary');
  assert.equal(result.entry.translation, '能够');
  assert.equal(result.entry.source,
    'EnglishDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/could' +
    ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑 | MyMemory（机器翻译）');
});

test('EnglishDictionary root IPA is credited only when actually retained, with whole-value length limits', async () => {
  for (const [ipa, expected, omitted] of [
    ['/root/', '/root/', false], ['a'.repeat(2000), 'a'.repeat(2000), false], ['a'.repeat(2001), '', true],
  ] as const) {
    const result = await lookup('could', respond({
      ...englishDictionary, partsOfSpeech: [], pronunciation: { ipa },
    }, {}), undefined, 'english-dictionary');
    assert.equal(result.entry.phonetic, expected);
    assert.equal(result.warnings.some((warning) => warning.code === 'phoneticOmitted'), omitted);
    assert.equal(result.warnings.some((warning) => warning.code === 'missingPhonetic'), !expected);
    assert.equal(result.entry.source.includes('EnglishDictionaryAPI.com'), Boolean(expected));
    assert.deepEqual(validateEntry(result.entry), result.entry);
  }
});

for (const provider of providers) {
  const fixture = fixtures[provider];
  const source = providerNames[provider] + ' | Wiktionary: https://en.wiktionary.org/wiki/could' +
    ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑';

  test(`${provider}: only the selected dictionary and MyMemory are requested`, async () => {
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const result = await lookup(' COULD ', async (url, options) => {
      calls.push(url);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.referrerPolicy, 'no-referrer');
      assert.ok(options?.signal);
      signals.push(options.signal);
      return respond({ ...fixture, word: ' COULD ' })(url);
    }, undefined, provider);
    assert.deepEqual(calls, [endpoints[provider]('could'), translationUrl('could')]);
    assert.notEqual(signals[0], signals[1]);
    assert.deepEqual(result.entry, {
      word: 'could', phonetic: '/kʊd/', pos: 'Verb', definition: 'paired meaning',
      example: 'A paired example.', translation: '能够', source: source + ' | MyMemory（机器翻译）',
    });
    assert.deepEqual(result.warnings, []);
  });

  test(`${provider}: default and explicit MyMemory options never invoke Baidu`, async (context) => {
    for (const translationProvider of [undefined, 'mymemory'] as const) {
      const calls: string[] = [];
      const transport = context.mock.fn(async () => baiduTranslation());
      const result = await lookup('could', async (url) => {
        calls.push(url);
        return respond(fixture)(url);
      }, undefined, provider, { provider: translationProvider, credentials: baiduCredentials, transport });
      assert.deepEqual(calls, [endpoints[provider]('could'), translationUrl('could')]);
      assert.equal(transport.mock.callCount(), 0);
      assert.equal(result.entry.translation, '能够');
      assert.equal(result.entry.source, source + ' | MyMemory（机器翻译）');
      assert.deepEqual(result.warnings, []);
      assertNoBaiduSecrets(result);
    }
  });

  test(`${provider}: only the selected dictionary and Baidu start in parallel`, async () => {
    const calls: string[] = [];
    const words: (string | null)[] = [];
    const pending: (() => void)[] = [];
    const promise = lookup(' COULD ', async (url, options) => {
      calls.push(url);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.referrerPolicy, 'no-referrer');
      return new Promise<Response>((resolve) => pending.push(() => resolve(json(fixture))));
    }, undefined, provider, {
      ...baiduOptions,
      transport: async (url) => {
        words.push(new URL(url).searchParams.get('q'));
        return new Promise((resolve) => pending.push(() => resolve(baiduTranslation())));
      },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, [endpoints[provider]('could')]);
      assert.deepEqual(words, ['could']);
      assert.equal(pending.length, 2, 'neither route waits for the other route to finish');
    } finally {
      pending.forEach((resolve) => resolve());
    }
    const result = await promise;
    assert.deepEqual(result.entry, {
      word: 'could', phonetic: '/kʊd/', pos: 'Verb', definition: 'paired meaning',
      example: 'A paired example.', translation: '能够', source: source + ' | ' + baiduSource,
    });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(validateEntry(result.entry), result.entry);
    const created = '2026-09-30T00:00:00.000Z';
    const backup = serializeBackup([{ ...result.entry, id: 1, created }], created);
    assert.equal(parseBackup(backup)[0].source, result.entry.source);
    assertNoBaiduSecrets({ result, backup });
  });

  test(`${provider}: Baidu failures retain the dictionary and expose only safe warning codes`, async (context) => {
    for (const failure of baiduFailures) {
      const calls: string[] = [];
      const transport = context.mock.fn(failure.transport);
      const result = await lookup('could', async (url) => {
        calls.push(url);
        return json(fixture);
      }, undefined, provider, { ...baiduOptions, credentials: failure.credentials, transport });
      assert.deepEqual(calls, [endpoints[provider]('could')], failure.code);
      assert.equal(transport.mock.callCount(), failure.calls, failure.code);
      assert.deepEqual(result.entry, {
        word: 'could', phonetic: '/kʊd/', pos: 'Verb', definition: 'paired meaning',
        example: 'A paired example.', translation: '', source,
      });
      assert.deepEqual(result.warnings.filter((warning) => warning.code === failure.code), [{ code: failure.code }]);
      assert.deepEqual(result.warnings.filter((warning) => warning.code !== failure.code), [{ code: 'missingTranslation' }]);
      assert.deepEqual(validateEntry(result.entry), result.entry);
      const created = '2026-09-30T00:00:00.000Z';
      assertNoBaiduSecrets({ result, backup: serializeBackup([{ ...result.entry, id: 1, created }], created) });
    }
  });

  test(`${provider}: dictionary failures preserve Baidu without retry or MyMemory fallback`, async (context) => {
    for (const failure of unavailable) {
      const calls: string[] = [];
      const transport = context.mock.fn(async () => baiduTranslation());
      const result = await lookup('could', async (url) => {
        calls.push(url);
        return failure.response();
      }, undefined, provider, { ...baiduOptions, transport });
      assert.deepEqual(calls, [endpoints[provider]('could')], failure.name);
      assert.equal(transport.mock.callCount(), 1);
      assert.deepEqual(result.entry, {
        word: 'could', phonetic: '', pos: '', definition: '', example: '', translation: '能够', source: baiduSource,
      });
      assert.deepEqual(result.warnings, [
        { code: 'dictionaryUnavailable' }, { code: 'missingExample' }, { code: 'missingPhonetic' },
      ]);
      assert.deepEqual(validateEntry(result.entry), result.entry);
    }
  });

  test(`${provider}: failure of both selected routes retains all missing-field warnings`, async (context) => {
    const calls: string[] = [];
    const transport = context.mock.fn(async () => { throw new Error(privateDiagnostic); });
    const result = await lookup('could', async (url) => {
      calls.push(url);
      throw new Error(privateDiagnostic);
    }, undefined, provider, { ...baiduOptions, transport });
    assert.deepEqual(calls, [endpoints[provider]('could')]);
    assert.equal(transport.mock.callCount(), 1);
    assert.deepEqual(result.entry, {
      word: 'could', phonetic: '', pos: '', definition: '', example: '', translation: '', source: '手动填写',
    });
    assert.deepEqual(result.warnings.filter((warning) => warning.code === 'baiduUnavailable'), [{ code: 'baiduUnavailable' }]);
    assert.deepEqual(result.warnings.filter((warning) => warning.code !== 'baiduUnavailable'), missingWarnings);
    assert.deepEqual(validateEntry(result.entry), result.entry);
    assertNoBaiduSecrets(result);
  });

  test(`${provider}: invalid words, the built-in sample and pre-cancelled Baidu lookups never fetch or sign`, async (context) => {
    const fetcher = context.mock.fn(async (): Promise<Response> => { assert.fail('must not fetch'); });
    const transport = context.mock.fn(async () => { assert.fail('must not invoke Baidu transport'); });
    const signingSalt = context.mock.method(globalThis.crypto, 'getRandomValues', () => { assert.fail('must not create a signing salt'); });
    let credentialReads = 0;
    const options: TranslationOptions = {
      provider: 'baidu', transport,
      get credentials() { credentialReads++; return baiduCredentials; },
    };
    for (const raw of ['../invalid', 'https://example.com', '', 'a'.repeat(81), null, {}, ['could']]) {
      await assert.rejects(lookup(raw, fetcher, undefined, provider, options), (error) => {
        assert.ok(error instanceof MessageError);
        assert.deepEqual(error.detail, { code: 'invalidWord' });
        assertNoBaiduSecrets(error);
        return true;
      });
    }
    const result = await lookup(' Investigation ', fetcher, undefined, provider, options);
    assert.deepEqual(result, { entry: sample, warnings: [] });
    assert.notEqual(result.entry, sample);
    const controller = new AbortController();
    const reason = new DOMException('Synthetic cancellation', 'AbortError');
    controller.abort(reason);
    for (const word of ['could', 'investigation'])
      await assert.rejects(lookup(word, fetcher, controller.signal, provider, options), (error) => error === reason);
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(transport.mock.callCount(), 0);
    assert.equal(credentialReads, 0);
    assert.equal(signingSalt.mock.callCount(), 0);
  });

  test(`${provider}: cancellation aborts the dictionary and Baidu with the original reason`, async (context) => {
    for (const reason of [new DOMException('Synthetic cancellation', 'AbortError'), Object.freeze({ cancelled: true })]) {
      const controller = new AbortController();
      const calls: string[] = [];
      const reasons: unknown[] = [];
      const waitForAbort = (signal?: AbortSignal | null) => new Promise<never>((_resolve, reject) => {
        assert.ok(signal);
        signal.addEventListener('abort', () => {
          reasons.push(signal.reason);
          reject(signal.reason);
        }, { once: true });
      });
      const transport = context.mock.fn(async (_url: string, signal?: AbortSignal) => waitForAbort(signal));
      const promise = lookup('could', async (url, options) => {
        calls.push(url);
        return waitForAbort(options?.signal);
      }, controller.signal, provider, { ...baiduOptions, transport });
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(reason);
      await assert.rejects(promise, (error) => error === reason);
      assert.deepEqual(calls, [endpoints[provider]('could')]);
      assert.equal(transport.mock.callCount(), 1);
      assert.equal(reasons.length, 2);
      reasons.forEach((value) => assert.equal(value, reason));
    }
  });

  test(`${provider}: late dictionary and Baidu responses cannot return a cancelled draft`, async (context) => {
    const controller = new AbortController();
    const pending: (() => void)[] = [];
    const transport = context.mock.fn(async () => new Promise<unknown>((resolve) => {
      pending.push(() => resolve(baiduTranslation()));
    }));
    const promise = lookup('could', async () => new Promise<Response>((resolve) => {
      pending.push(() => resolve(json(fixture)));
    }), controller.signal, provider, { ...baiduOptions, transport });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    pending.forEach((resolve) => resolve());
    await assert.rejects(promise, (error) => error === controller.signal.reason);
    assert.equal(pending.length, 2);
    assert.equal(transport.mock.callCount(), 1);
  });

  test(`${provider}: dictionary deadlines and Baidu transport timeouts preserve partial successes`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const timedOut of ['dictionary', 'baidu', 'both']) {
      const dictionaryTimedOut = timedOut !== 'baidu';
      const baiduTimedOut = timedOut !== 'dictionary';
      const calls: string[] = [];
      const reasons: unknown[] = [];
      let baiduTimeouts = 0;
      const waitForTimeout = (signal?: AbortSignal | null) => new Promise<never>((_resolve, reject) => {
        assert.ok(signal);
        signal.addEventListener('abort', () => {
          reasons.push(signal.reason);
          reject(signal.reason);
        }, { once: true });
      });
      // The injected transport owns its deadline, just like the real JSONP transport.
      const transport = context.mock.fn(async () => {
        if (!baiduTimedOut) return baiduTranslation();
        return new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            baiduTimeouts++;
            reject(new MessageError({ code: 'baiduTimedOut' }));
          }, 30000);
        });
      });
      const promise = lookup('could', async (url, options) => {
        calls.push(url);
        return dictionaryTimedOut ? waitForTimeout(options?.signal) : json(fixture);
      }, undefined, provider, { ...baiduOptions, transport });
      await new Promise<void>((resolve) => setImmediate(resolve));
      context.mock.timers.tick(29999);
      assert.equal(reasons.length, 0);
      assert.equal(baiduTimeouts, 0);
      context.mock.timers.tick(1);
      const result = await promise;
      assert.deepEqual(calls, [endpoints[provider]('could')]);
      assert.equal(transport.mock.callCount(), 1);
      assert.equal(reasons.length, dictionaryTimedOut ? 1 : 0);
      assert.equal(baiduTimeouts, baiduTimedOut ? 1 : 0);
      assert.ok(reasons.every((reason) => reason instanceof DOMException && reason.name === 'TimeoutError'));
      assert.equal(result.entry.definition, dictionaryTimedOut ? '' : 'paired meaning');
      assert.equal(result.entry.example, dictionaryTimedOut ? '' : 'A paired example.');
      assert.equal(result.entry.phonetic, dictionaryTimedOut ? '' : '/kʊd/');
      assert.equal(result.entry.translation, baiduTimedOut ? '' : '能够');
      assert.equal(result.entry.source, timedOut === 'both' ? '手动填写' : dictionaryTimedOut ? baiduSource : source);
      assert.deepEqual(result.warnings.filter((warning) => warning.code === 'baiduTimedOut'), baiduTimedOut ? [{ code: 'baiduTimedOut' }] : []);
      assert.deepEqual(result.warnings.filter((warning) => warning.code !== 'baiduTimedOut'), [
        ...(dictionaryTimedOut ? [{ code: 'dictionaryUnavailable' }] : []),
        ...(baiduTimedOut ? [{ code: 'missingTranslation' }] : []),
        ...(dictionaryTimedOut ? [{ code: 'missingExample' }, { code: 'missingPhonetic' }] : []),
      ]);
      assert.deepEqual(validateEntry(result.entry), result.entry);
      assertNoBaiduSecrets(result);
    }
  });

  test(`${provider}: endpoints and attribution encode the exact normalized query`, async () => {
    for (const raw of [' Ice Cream ', " Mother's-in-law "]) {
      const word = raw.trim().toLowerCase();
      const url = 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word);
      const calls: string[] = [];
      const result = await lookup(raw, async (url) => {
        calls.push(url);
        return respond({ ...fixture, word: raw.toUpperCase(), source: { ...dictionary.source, url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) } })(url);
      }, undefined, provider);
      assert.deepEqual(calls, [endpoints[provider](word), translationUrl(word)]);
      assert.equal(new URL(calls[1]).searchParams.get('q'), word);
      assert.equal(result.entry.word, word);
      assert.ok(result.entry.source.includes('Wiktionary: ' + url + ' | CC BY-SA 4.0: '));
      assert.equal(wiktionaryUrl(url), url);
    }
  });

  test(`${provider}: wrong, malformed or overlong returned words contribute nothing`, async () => {
    for (const word of ['would', 'could/extra', 'could?redirect=other', 'could' + 'a'.repeat(2000), null, {}, ['could'], '']) {
      const result = await lookup('could', respond({ ...fixture, word }), undefined, provider);
      assert.equal(result.entry.definition, '');
      assert.equal(result.entry.example, '');
      assert.equal(result.entry.phonetic, '');
      assert.equal(result.entry.pos, '');
      assert.equal(result.entry.translation, '能够');
      assert.equal(result.entry.source, 'MyMemory（机器翻译）');
    }
  });

  test(`${provider}: malformed and empty successful responses receive no attribution`, async () => {
    const empty = { ...fixture, entries: [], partsOfSpeech: [], pronunciation: null };
    for (const dict of [null, [], {}, 'not an object', empty]) {
      const result = await lookup('could', respond(dict, {}), undefined, provider);
      assert.equal(result.entry.source, '手动填写');
      assert.deepEqual(result.warnings, missingWarnings);
      assert.deepEqual(validateEntry(result.entry), result.entry);
    }
  });

  test(`${provider}: edited words and backup round trips preserve original attribution`, async () => {
    const result = await lookup('could', respond(fixture), undefined, provider);
    const edited = validateEntry({ ...result.entry, word: 'would' });
    const created = '2026-09-29T00:00:00.000Z';
    const restored = parseBackup(serializeBackup([{ ...edited, id: 1, created }], created));
    assert.equal(restored[0].word, 'would');
    assert.equal(restored[0].source, result.entry.source);
    assert.ok(restored[0].source.includes(dictionary.source.url));
    assert.ok(restored[0].source.includes(DICTIONARY_LICENSE_URL));
    assert.doesNotMatch(restored[0].source, /wiki\/would/);
  });

  test(`${provider}: upstream failures leave an editable draft without retry or fallback`, async () => {
    for (const failure of unavailable) {
      const calls: string[] = [];
      const result = await lookup('curious', async (url) => {
        calls.push(url);
        return failure.response();
      }, undefined, provider);
      assert.deepEqual(calls, [endpoints[provider]('curious'), translationUrl('curious')], failure.name);
      assert.equal(result.entry.word, 'curious');
      assert.equal(result.entry.source, '手动填写');
      assert.equal(result.entry.definition, '');
      assert.equal(result.entry.example, '');
      assert.deepEqual(result.warnings, missingWarnings, failure.name);
      assert.deepEqual(validateEntry(result.entry), result.entry);
    }
  });

  test(`${provider}: dictionary failures preserve MyMemory, and MyMemory failures preserve the dictionary`, async () => {
    for (const failure of unavailable) {
      for (const dictionaryFailed of [true, false]) {
        const calls: string[] = [];
        const result = await lookup('could', async (url) => {
          calls.push(url);
          return isDictionary(url) === dictionaryFailed ? failure.response() : respond(fixture)(url);
        }, undefined, provider);
        assert.deepEqual(calls, [endpoints[provider]('could'), translationUrl('could')], failure.name);
        assert.equal(result.entry.definition, dictionaryFailed ? '' : 'paired meaning');
        assert.equal(result.entry.example, dictionaryFailed ? '' : 'A paired example.');
        assert.equal(result.entry.phonetic, dictionaryFailed ? '' : '/kʊd/');
        assert.equal(result.entry.translation, dictionaryFailed ? '能够' : '');
        assert.equal(result.entry.source, dictionaryFailed ? 'MyMemory（机器翻译）' : source);
        assert.deepEqual(result.warnings, dictionaryFailed
          ? [{ code: 'dictionaryUnavailable' }, { code: 'missingExample' }, { code: 'missingPhonetic' }]
          : [{ code: 'missingTranslation' }], failure.name);
      }
    }
  });

  test(`${provider}: malformed, rejected or non-Chinese translations receive no credit`, async () => {
    for (const trans of [null, [], { responseStatus: 403, responseData: { translatedText: '错误信息' } },
      { responseStatus: 200, responseData: { translatedText: ['中文'] } },
      { responseStatus: 200, responseData: { translatedText: 'English only' } }]) {
      const result = await lookup('could', respond(fixture, trans), undefined, provider);
      assert.equal(result.entry.translation, '');
      assert.equal(result.entry.source, source);
      assert.deepEqual(result.warnings, [{ code: 'missingTranslation' }]);
    }
  });

  test(`${provider}: invalid input and the explicit sample never fetch`, async () => {
    const noFetch = async (): Promise<Response> => { assert.fail('must not fetch'); };
    for (const raw of ['../invalid', 'https://example.com', '', 'a'.repeat(81), null, {}, ['could']]) {
      await assert.rejects(lookup(raw, noFetch, undefined, provider), (error) => {
        assert.ok(error instanceof MessageError);
        assert.match(error.message, /有效的英语/);
        assert.deepEqual(error.detail, { code: 'invalidWord' });
        return true;
      });
    }
    const result = await lookup(' Investigation ', noFetch, undefined, provider);
    assert.deepEqual(result, { entry: sample, warnings: [] });
    assert.notEqual(result.entry, sample);
  });

  test(`${provider}: cancellation aborts both routes with the original reason`, async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled lookup', 'AbortError');
    const calls: string[] = [];
    let aborted = 0;
    const promise = lookup('could', async (url, options) => {
      calls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted++;
          reject(options.signal?.reason);
        });
      });
    }, controller.signal, provider);
    controller.abort(reason);
    await assert.rejects(promise, (error) => error === reason);
    assert.equal(aborted, 2);
    assert.deepEqual(calls, [endpoints[provider]('could'), translationUrl('could')]);
  });

  test(`${provider}: late responses after cancellation cannot return a stale draft`, async () => {
    const controller = new AbortController();
    const pending: (() => void)[] = [];
    const promise = lookup('could', async (url) => new Promise<Response>((resolve) => {
      pending.push(() => resolve(json(isDictionary(url) ? fixture : translation)));
    }), controller.signal, provider);
    assert.equal(pending.length, 2);
    controller.abort();
    pending.forEach((resolve) => resolve());
    await assert.rejects(promise, (error) => error === controller.signal.reason);
  });

  test(`${provider}: pre-cancelled queries and samples do not fetch`, async () => {
    const controller = new AbortController();
    controller.abort();
    for (const word of ['could', 'investigation']) {
      await assert.rejects(lookup(word, async () => { assert.fail('must not fetch'); }, controller.signal, provider),
        (error) => error === controller.signal.reason);
    }
  });

  test(`${provider}: both routes have a 30-second timeout and return an editable draft`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const calls: string[] = [];
    const reasons: unknown[] = [];
    const promise = lookup('curious', async (url, options) => {
      calls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reasons.push(options.signal?.reason);
          reject(options.signal?.reason);
        });
      });
    }, undefined, provider);
    context.mock.timers.tick(29999);
    assert.equal(reasons.length, 0);
    context.mock.timers.tick(1);
    const result = await promise;
    assert.equal(reasons.length, 2);
    assert.ok(reasons.every((reason) => reason instanceof DOMException && reason.name === 'TimeoutError'));
    assert.deepEqual(calls, [endpoints[provider]('curious'), translationUrl('curious')]);
    assert.equal(result.entry.word, 'curious');
    assert.deepEqual(result.warnings, missingWarnings);
    assert.deepEqual(validateEntry(result.entry), result.entry);
  });

  test(`${provider}: a timed-out route does not discard the completed route`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const dictionaryTimedOut of [true, false]) {
      const promise = lookup('could', async (url, options) => {
        if (isDictionary(url) !== dictionaryTimedOut) return respond(fixture)(url);
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
      }, undefined, provider);
      await new Promise<void>((resolve) => setImmediate(resolve));
      context.mock.timers.tick(30000);
      const result = await promise;
      assert.equal(result.entry.definition, dictionaryTimedOut ? '' : 'paired meaning');
      assert.equal(result.entry.translation, dictionaryTimedOut ? '能够' : '');
      assert.equal(result.entry.source, dictionaryTimedOut ? 'MyMemory（机器翻译）' : source);
    }
  });
}
