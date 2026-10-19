import type { CategoryFilter } from './categories';
import type { StoredEntry } from './entry';

export type LibrarySort = 'recent' | 'alphabetical';

const alphabetical = new Intl.Collator('en', { sensitivity: 'base' });

export function selectLibraryEntries(
  entries: readonly StoredEntry[],
  query: string,
  sort: LibrarySort,
  category: CategoryFilter = 'all',
): StoredEntry[] {
  const search = query.trim().toLowerCase();
  const selected = entries.filter(entry =>
    (category === 'all' || (category === 'uncategorized' ? entry.categoryIds.length === 0 : entry.categoryIds.includes(category)))
    && (entry.word.toLowerCase().includes(search) || entry.translation.toLowerCase().includes(search)),
  );
  return selected.sort((left, right) =>
    (sort === 'alphabetical' ? alphabetical.compare(left.word, right.word) : 0) || right.id - left.id,
  );
}

export const LIBRARY_PAGE_SIZE = 20;

export function paginateLibraryEntries(
  entries: readonly StoredEntry[],
  requestedPage: number,
): { page: number; pageCount: number; start: number; end: number; entries: StoredEntry[] } {
  const pageCount = Math.max(1, Math.ceil(entries.length / LIBRARY_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number.isInteger(requestedPage) ? requestedPage : 1));
  const offset = (page - 1) * LIBRARY_PAGE_SIZE;
  const end = Math.min(offset + LIBRARY_PAGE_SIZE, entries.length);
  return {
    page, pageCount,
    start: entries.length ? offset + 1 : 0,
    end,
    entries: entries.slice(offset, end),
  };
}
