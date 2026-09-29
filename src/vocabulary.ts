// 浏览器直接查询公开词典；失败时保留草稿，不伪造缺失的释义。
import { createEntry, sample, validWord, type Entry } from './entry';
import { MessageError, type Message } from './messages';

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

export async function lookup(
  raw: unknown,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
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
      () => controller.abort(new DOMException('查询超时', 'TimeoutError')),
      30000,
    );
    try {
      if (signal?.aborted) cancel();
      const response = await fetcher(url, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('查询服务暂时不可用');
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }

  const [dict, trans] = await Promise.allSettled([
    request('https://freedictionaryapi.com/api/v1/entries/en/' + encodeURIComponent(word) + '?translations=true'),
    request(
      'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(word) +
        '&langpair=en%7Czh-CN',
    ),
  ]);
  if (signal?.aborted) throw signal.reason;

  const entry = createEntry(word);
  const sources: string[] = [];
  const warnings: Message[] = [];
  if (dict.status === 'fulfilled') {
    const dictionary = record(dict.value);
    const source = record(dictionary.source);
    const license = record(source.license);
    const sourceUrl = wiktionaryUrl(source.url);
    if (
      text(dictionary.word).toLowerCase() === word && sourceUrl &&
      license.name === 'CC BY-SA 4.0' && license.url === DICTIONARY_LICENSE_URL
    ) {
      const meanings = array(dictionary.entries).map(record)
        .filter((value) => record(value.language).code === 'en')
        .map((value) => ({ value, senses: collectSenses(value.senses) }));
      const selected = meanings.find((value) => value.senses.some((sense) => text(sense.definition))) || meanings[0];
      const meaning = selected?.value || {};
      const definitions = selected?.senses || [];
      const definition = definitions.find((value) =>
        text(value.definition) && array(value.examples).some((example) => text(example)),
      ) || definitions.find((value) => text(value.definition)) || {};
      const phonetic = record(array(meaning.pronunciations).find((value) =>
        record(value).type === 'ipa' && text(record(value).text),
      ));
      entry.phonetic = text(phonetic.text);
      const pos = text(meaning.partOfSpeech);
      entry.pos = pos ? pos[0].toUpperCase() + pos.slice(1) : '';
      entry.definition = text(definition.definition);
      entry.example = text(array(definition.examples).find((value) => text(value)));
      const translations = array(definition.translations).map(record)
        .filter((value) => ['cmn', 'zh'].includes(text(record(value.language).code)))
        .map((value) => text(value.word)).filter((value) => /[㐀-鿿]/.test(value));
      entry.translation = text([...new Set(translations)].join('；'));
      if (entry.phonetic || entry.pos || entry.definition || entry.example || entry.translation) {
        sources.push(
          'FreeDictionaryAPI.com | Wiktionary: ' + sourceUrl +
          ' | CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL + ' | 词典摘录，可经编辑',
        );
      }
    }
  }
  if (!entry.phonetic && !entry.definition && !entry.pos)
    warnings.push({ code: 'dictionaryUnavailable' });

  if (!entry.translation && trans.status === 'fulfilled') {
    const translation = record(trans.value);
    const translatedText = text(record(translation.responseData).translatedText);
    if (Number(translation.responseStatus) === 200 && /[㐀-鿿]/.test(translatedText)) {
      entry.translation = translatedText;
      sources.push('MyMemory（机器翻译）');
    }
  }
  entry.source = sources.join(' | ') || '手动填写';
  if (!entry.translation) warnings.push({ code: 'missingTranslation' });
  if (!entry.example) warnings.push({ code: 'missingExample' });
  if (!entry.phonetic) warnings.push({ code: 'missingPhonetic' });
  return { entry, warnings };
}
