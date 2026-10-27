import { validateDatedEntry, type DatedEntry, type StoredEntry } from './entry.js';
import { MessageError } from './messages.js';

export type Category = { id: number; name: string };
export type LibrarySnapshot = { words: StoredEntry[]; categories: Category[] };
export type ImportEntry = DatedEntry & { categories: readonly string[] };
export type ImportBatch = { categories: readonly string[]; entries: readonly ImportEntry[] };
export type CategoryChange =
  | { mode: 'add' | 'remove' | 'replace'; categoryIds: readonly number[] }
  | { mode: 'clear' };
export type CategoryFilter = 'all' | 'uncategorized' | number;

export const MAX_CATEGORIES = 1000;
export const MAX_CATEGORY_NAME_LENGTH = 80;

export function normalizeCategoryName(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value))
    throw new MessageError({ code: 'invalidCategoryName' });
  const name = value.trim().normalize('NFC');
  if (!name || name.length > MAX_CATEGORY_NAME_LENGTH)
    throw new MessageError({ code: 'invalidCategoryName' });
  return name;
}

export function categoryNameKey(name: string): string {
  return normalizeCategoryName(name).toLowerCase().normalize('NFC');
}

export function validateCategoryIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new MessageError({ code: 'invalidCategoryIds' });
  if (value.length > MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
  const ids = new Set<number>();
  for (let index = 0; index < value.length; index++) {
    const id: unknown = value[index];
    if (!Object.hasOwn(value, index) || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      throw new MessageError({ code: 'invalidCategoryIds' });
    ids.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}

function categoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new MessageError({ code: 'invalidCategories' });
  if (value.length > MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
  return Array.from(value, (name, index) => {
    if (!Object.hasOwn(value, index)) throw new MessageError({ code: 'invalidCategories' });
    return normalizeCategoryName(name);
  });
}

export function validateImportBatch(value: unknown): ImportBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessageError({ code: 'invalidImportBatch' });
  const batch = value as Record<string, unknown>;
  if (!Array.isArray(batch.entries)) throw new MessageError({ code: 'invalidImportBatch' });
  const values = batch.entries;
  const categories = categoryNames(batch.categories);
  const directory = new Map<string, string>();
  for (const name of categories) {
    const key = categoryNameKey(name);
    if (directory.has(key)) throw new MessageError({ code: 'duplicateCategory' });
    directory.set(key, name);
  }
  // Validate even later duplicate words, before storage chooses the first occurrence.
  const entries = Array.from(values, (value, index) => {
    if (!Object.hasOwn(values, index)) throw new MessageError({ code: 'invalidImportBatch' });
    const entry = validateDatedEntry(value);
    const references = categoryNames((value as Record<string, unknown>).categories);
    const names = new Set<string>();
    for (const reference of references) {
      const name = directory.get(categoryNameKey(reference));
      if (name === undefined) throw new MessageError({ code: 'categoryMissing' });
      names.add(name);
    }
    return { ...entry, categories: [...names] };
  });
  return { categories, entries };
}

export function validateCategoryChange(value: unknown): CategoryChange {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessageError({ code: 'invalidCategoryChange' });
  const change = value as Record<string, unknown>;
  if (change.mode === 'clear') return { mode: 'clear' };
  if (change.mode !== 'add' && change.mode !== 'remove' && change.mode !== 'replace')
    throw new MessageError({ code: 'invalidCategoryChange' });
  const categoryIds = validateCategoryIds(change.categoryIds);
  if (!categoryIds.length) throw new MessageError({ code: 'invalidCategoryChange' });
  return { mode: change.mode, categoryIds };
}

export function applyCategoryChange(current: readonly number[], change: CategoryChange): number[] {
  switch (change.mode) {
    case 'clear': return [];
    case 'replace': return validateCategoryIds(change.categoryIds);
    case 'add': return validateCategoryIds([...new Set([...current, ...change.categoryIds])]);
    case 'remove': {
      const removed = new Set(change.categoryIds);
      return validateCategoryIds(current.filter(id => !removed.has(id)));
    }
  }
}
