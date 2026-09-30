// Query public dictionaries in the browser; keep drafts without inventing missing meanings.
import { createEntry, sample, validWord, type Entry } from './entry';
import { MessageError, type Message } from './messages';
import { DEFAULT_DICTIONARY_PROVIDER, dictionaryProviders, type DictionaryProvider } from './dictionary-providers';
import { formatPhonetics } from './phonetics';

const MYMEMORY_SOURCE = 'MyMemory（机器翻译）';

export function hasMyMemorySource(source: string): boolean {
  return source.split(' | ').includes(MYMEMORY_SOURCE);
}

type LookupResult = { entry: Entry; warnings: Message[] };
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
export const DICTIONARY_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function wiktionaryUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000 || /\s/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === 'en.wiktionary.org' &&
      !url.username && !url.password && !url.search &&
      url.pathname.startsWith('/wiki/') && url.pathname.length > 6 && url.href.length <= 1000
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function collectSenses(value: unknown): Record<string, unknown>[] {
  const pending = [...array(value)];
  const senses: Record<string, unknown>[] = [];
  for (let index = 0; index < pending.length; index++) {
    const sense = record(pending[index]);
    senses.push(sense);
    for (const child of array(sense.subsenses)) pending.push(child);
  }
  return senses;
}

type DictionaryContent = {
  fields: Omit<Entry, 'word' | 'source'>;
  sourceUrl: string;
  phoneticOmitted: boolean;
};

function matchesWord(value: unknown, word: string): boolean {
  return validWord(value) && value.trim().toLowerCase() === word;
}

function partOfSpeech(value: unknown): string {
  const pos = text(value);
  return pos ? pos[0].toUpperCase() + pos.slice(1) : '';
}

function freeDictionaryContent(value: unknown, word: string): DictionaryContent | undefined {
  const dictionary = record(value);
  const source = record(dictionary.source);
  const license = record(source.license);
  const sourceUrl = wiktionaryUrl(source.url);
  if (!matchesWord(dictionary.word, word) || !sourceUrl ||
    license.name !== 'CC BY-SA 4.0' || license.url !== DICTIONARY_LICENSE_URL) return;

  const meanings = array(dictionary.entries).map(record)
    .filter((entry) => record(entry.language).code === 'en')
    .map((entry) => ({ entry, senses: collectSenses(entry.senses) }));
  const selected = meanings.find((meaning) => meaning.senses.some((sense) => text(sense.definition))) || meanings[0];
  const meaning = selected?.entry || {};
  const definitions = selected?.senses || [];
  const definition = definitions.find((sense) =>
    text(sense.definition) && array(sense.examples).some((example) => text(example)),
  ) || definitions.find((sense) => text(sense.definition)) || {};
  const pronunciations = array(meaning.pronunciations).map(record)
    .filter((pronunciation) => pronunciation.type === 'ipa')
    .map((pronunciation) => ({ text: pronunciation.text, tags: pronunciation.tags }));
  const { phonetic, omitted } = formatPhonetics(pronunciations);
  const translations = array(definition.translations).map(record)
    .filter((translation) => ['cmn', 'zh'].includes(text(record(translation.language).code)))
    .map((translation) => text(translation.word)).filter((translation) => /[㐀-鿿]/.test(translation));
  return {
    fields: {
      phonetic,
      pos: partOfSpeech(meaning.partOfSpeech),
      definition: text(definition.definition),
      example: text(array(definition.examples).find((example) => text(example))),
      translation: text([...new Set(translations)].join('；')),
    },
    sourceUrl,
    phoneticOmitted: omitted,
  };
}

function englishDictionaryContent(value: unknown, word: string): DictionaryContent | undefined {
  const dictionary = record(value);
  if (!matchesWord(dictionary.word, word)) return;
  // This provider documents English Wiktionary / CC BY-SA 4.0, without per-entry source fields.
  const sourceUrl = wiktionaryUrl('https://en.wiktionary.org/wiki/' + encodeURIComponent(word));
  if (!sourceUrl) return;

  const meanings = array(dictionary.partsOfSpeech).map(record)
    .map((entry) => ({ entry, senses: array(entry.senses).map(record) }));
  const selected = meanings.find((meaning) => meaning.senses.some((sense) => text(sense.definition)));
  const definitions = selected?.senses || [];
  const definition = definitions.find((sense) => text(sense.definition) && text(sense.example)) ||
    definitions.find((sense) => text(sense.definition)) || {};
  const { phonetic, omitted } = formatPhonetics([{ text: record(dictionary.pronunciation).ipa }]);
  return {
    fields: {
      phonetic,
      pos: partOfSpeech(selected?.entry.partOfSpeech),
      definition: text(definition.definition),
      example: text(definition.example),
      translation: '',
    },
    sourceUrl,
    phoneticOmitted: omitted,
  };
}

export async function lookup(
  raw: unknown,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  provider: DictionaryProvider = DEFAULT_DICTIONARY_PROVIDER,
): Promise<LookupResult> {
  if (!validWord(raw)) throw new MessageError({ code: 'invalidWord' });
  if (signal?.aborted) throw signal.reason;
  const word = raw.trim().toLowerCase();
  if (word === sample.word) return { entry: { ...sample }, warnings: [] };

  async function request(url: string): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Lookup timed out', 'TimeoutError')),
      30000,
    );
    try {
      if (signal?.aborted) cancel();
      const response = await fetcher(url, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Lookup service is temporarily unavailable');
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }

  const dictionaryUrl = provider === 'english-dictionary'
    ? 'https://englishdictionaryapi.com/api/v1/words/' + encodeURIComponent(word)
    : 'https://freedictionaryapi.com/api/v1/entries/en/' + encodeURIComponent(word) + '?translations=true';
  async function translate(): Promise<string> {
    const response = record(await request(
      'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en%7Czh-CN',
    ));
    const translatedText = text(record(response.responseData).translatedText);
    return Number(response.responseStatus) === 200 && /[㐀-鿿]/.test(translatedText) ? translatedText : '';
  }
  const [dict, trans] = await Promise.allSettled([request(dictionaryUrl), translate()]);
  if (signal?.aborted) throw signal.reason;

  const entry = createEntry(word);
  const sources: string[] = [];
  const warnings: Message[] = [];
  if (dict.status === 'fulfilled') {
    const content = provider === 'english-dictionary'
      ? englishDictionaryContent(dict.value, word)
      : freeDictionaryContent(dict.value, word);
    if (content) {
      Object.assign(entry, content.fields);
      if (content.phoneticOmitted) warnings.push({ code: 'phoneticOmitted' });
      if (Object.values(content.fields).some(Boolean)) {
        sources.push(
          dictionaryProviders[provider].name + ' | Wiktionary: ' + content.sourceUrl +
          ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑',
        );
      }
    }
  }
  if (!entry.phonetic && !entry.definition && !entry.pos)
    warnings.push({ code: 'dictionaryUnavailable' });

  if (!entry.translation && trans.status === 'fulfilled' && trans.value) {
    entry.translation = trans.value;
    sources.push(MYMEMORY_SOURCE);
  }
  entry.source = sources.join(' | ') || '手动填写';
  if (!entry.translation) warnings.push({ code: 'missingTranslation' });
  if (!entry.example) warnings.push({ code: 'missingExample' });
  if (!entry.phonetic) warnings.push({ code: 'missingPhonetic' });
  return { entry, warnings };
}
