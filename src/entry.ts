// Entry types, sample data, and shared validation; drafts and backups use the same field rules.
import { MessageError } from './messages';

export type Entry = {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
  definition: string;
  example: string;
  source: string;
};
export type DatedEntry = Entry & { created: string };
export type StoredEntry = DatedEntry & { id: number };

export const sample: Entry = {
  word: 'investigation',
  phonetic: '/ɪnˌvestɪˈɡeɪʃn/',
  translation: '调查',
  pos: 'Noun',
  definition: 'the work of inquiring into something thoroughly and systematically',
  example: 'The investigation has entered a new phase.',
  source: '用户提供的示例',
};

export function validWord(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z '\-]{0,79}$/.test(value.trim());
}

export function createEntry(word: string): Entry {
  return {
    word: word.trim().toLowerCase(),
    phonetic: '',
    translation: '',
    pos: '',
    definition: '',
    example: '',
    source: '手动填写',
  };
}

export function validateEntry(value: unknown): Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessageError({ code: 'invalidEntry' });
  const v = value as Record<string, unknown>;
  if (!validWord(v.word))
    throw new MessageError({ code: 'invalidWord' });
  const result = createEntry(v.word);
  for (const key of ['phonetic', 'translation', 'pos', 'definition', 'example', 'source'] as const) {
    if (typeof v[key] !== 'string' || v[key].length > 2000)
      throw new MessageError({ code: 'invalidFields' });
    result[key] = v[key].trim();
  }
  return result;
}

export function validateCreated(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 30 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new MessageError({ code: 'invalidCreated' });
  return value;
}

export function validateDatedEntry(value: unknown): DatedEntry {
  const entry = validateEntry(value);
  return { ...entry, created: validateCreated((value as Record<string, unknown>).created) };
}
