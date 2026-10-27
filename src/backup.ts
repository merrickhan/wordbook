import { validateCreated, validateDatedEntry } from './entry.js';
import {
  MAX_CATEGORIES, categoryNameKey, normalizeCategoryName, validateCategoryIds, validateImportBatch,
} from './categories.js';
import type { ImportBatch, LibrarySnapshot } from './categories.js';
import { MessageError } from './messages.js';

export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 10000;

function checkSize(text: string) {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES)
    throw new MessageError({ code: 'backupTooLarge' });
}

function checkEntries(entries: unknown): asserts entries is readonly unknown[] {
  if (!Array.isArray(entries)) throw new MessageError({ code: 'backupEntriesInvalid' });
  if (entries.length > MAX_BACKUP_ENTRIES)
    throw new MessageError({ code: 'backupTooManyEntries' });
}

export function parseBackup(text: string): ImportBatch {
  checkSize(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new MessageError({ code: 'backupInvalidJson' }, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessageError({ code: 'backupInvalidFormat' });
  const backup = value as Record<string, unknown>;
  const fields = ['format', 'version', 'exportedAt', 'entries'];
  if (fields.some(key => !Object.hasOwn(backup, key)))
    throw new MessageError({ code: 'backupInvalidStructure' });
  if (backup.format !== 'wordbook') throw new MessageError({ code: 'backupWrongFormat' });
  if (backup.version !== 1 && backup.version !== 2)
    throw new MessageError({ code: 'backupUnsupportedVersion' });
  if (backup.version === 2) fields.push('categories');
  if (Object.keys(backup).length !== fields.length || fields.some(key => !Object.hasOwn(backup, key)))
    throw new MessageError({ code: 'backupInvalidStructure' });
  validateCreated(backup.exportedAt);
  checkEntries(backup.entries);
  if (backup.version === 1) {
    // Legacy entry extras, including category-looking fields, retain their old ignored semantics.
    return { categories: [], entries: backup.entries.map(value => ({ ...validateDatedEntry(value), categories: [] })) };
  }
  return validateImportBatch({ categories: backup.categories, entries: backup.entries });
}

function compareCategoryNames(a: string, b: string): number {
  const left = categoryNameKey(a);
  const right = categoryNameKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function serializeBackup(snapshot: LibrarySnapshot, exportedAt = new Date().toISOString()): string {
  checkEntries(snapshot.words);
  validateCreated(exportedAt);
  if (!Array.isArray(snapshot.categories)) throw new MessageError({ code: 'invalidCategories' });
  if (snapshot.categories.length > MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
  const namesById = new Map<number, string>();
  const names = Array.from(snapshot.categories, (category, index) => {
    if (!Object.hasOwn(snapshot.categories, index) || !category || typeof category !== 'object' || Array.isArray(category))
      throw new MessageError({ code: 'invalidCategories' });
    const [id] = validateCategoryIds([category.id]);
    if (namesById.has(id)) throw new MessageError({ code: 'invalidCategories' });
    const name = normalizeCategoryName(category.name);
    namesById.set(id, name);
    return name;
  });
  // Validate the complete directory, including unused categories and normalized-name collisions.
  const categories = [...validateImportBatch({ categories: names, entries: [] }).categories].sort(compareCategoryNames);
  // Local IDs only determine entry order and resolve references; neither kind of ID is exported.
  const entries = Array.from(snapshot.words, (value, index) => {
    if (!Object.hasOwn(snapshot.words, index)) throw new MessageError({ code: 'invalidEntry' });
    const entry = validateDatedEntry(value);
    if (!Number.isSafeInteger(value.id) || value.id <= 0)
      throw new MessageError({ code: 'backupInvalidId' });
    const references = validateCategoryIds(value.categoryIds).map(id => {
      const name = namesById.get(id);
      if (name === undefined) throw new MessageError({ code: 'categoryMissing' });
      return name;
    }).sort(compareCategoryNames);
    return { id: value.id, entry: { ...entry, categories: references } };
  }).sort((a, b) => a.id - b.id).map(value => value.entry);
  const text = JSON.stringify({ format: 'wordbook', version: 2, exportedAt, categories, entries }, null, 2);
  checkSize(text);
  return text;
}
