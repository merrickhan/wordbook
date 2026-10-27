// Browser client for the notebook API. Method names and results mirror the former IndexedDB store,
// so the page keeps the same operations while the server owns validation and persistence.
import type { StoredEntry } from './entry.js';
import { validateDatedEntry } from './entry.js';
import {
  normalizeCategoryName, validateCategoryIds,
  type Category, type CategoryChange, type ImportBatch, type LibrarySnapshot,
} from './categories.js';
import { MessageError, parseMessage, type Message } from './messages.js';

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ImportCounts = { imported: number; updated: number; skipped: number; classified: number; categoriesCreated: number };
export type ClassificationCounts = { changed: number; unchanged: number; missing: number };

type ApiOptions = {
  fetch?: ApiFetch;
  /** Prefix for API paths. Relative by default so the page's own origin is used. */
  base?: string;
  /** Called whenever the server reports that the session is missing or expired. */
  onUnauthorized?: () => void;
};

const GZIP_UPLOAD_THRESHOLD = 64 * 1024;

function invalidRecord(cause?: unknown): MessageError {
  return new MessageError({ code: 'storageInvalidRecord' }, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalidRecord();
  return value;
}

function readEntry(value: unknown): StoredEntry {
  if (!isRecord(value)) throw invalidRecord();
  try {
    return { ...validateDatedEntry(value), id: positiveId(value.id), categoryIds: validateCategoryIds(value.categoryIds) };
  } catch (error) {
    throw invalidRecord(error);
  }
}

function readCategory(value: unknown): Category {
  if (!isRecord(value)) throw invalidRecord();
  try {
    return { id: positiveId(value.id), name: normalizeCategoryName(value.name) };
  } catch (error) {
    throw invalidRecord(error);
  }
}

function readSnapshot(value: unknown): LibrarySnapshot {
  if (!isRecord(value) || !Array.isArray(value.words) || !Array.isArray(value.categories)) throw invalidRecord();
  return { words: value.words.map(readEntry), categories: value.categories.map(readCategory) };
}

function readCounts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> {
  if (!isRecord(value)) throw invalidRecord();
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalidRecord();
    result[key] = count;
  }
  return result;
}

async function gzip(text: string): Promise<ArrayBuffer | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  try {
    return await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  } catch {
    return undefined;
  }
}

export function createApiStore(options: ApiOptions = {}) {
  const fetcher: ApiFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = options.base ?? 'api/';

  async function request(method: string, path: string, body?: unknown, compress = false): Promise<unknown> {
    const headers: Record<string, string> = { 'X-Wordbook': '1', Accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      const text = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      const zipped = compress && text.length > GZIP_UPLOAD_THRESHOLD ? await gzip(text) : undefined;
      if (zipped) headers['X-Wordbook-Encoding'] = 'gzip';
      payload = zipped ?? text;
    }
    let response: Response;
    try {
      response = await fetcher(base + path, {
        method, headers, body: payload, credentials: 'same-origin', cache: 'no-store',
      });
    } catch (error) {
      throw new MessageError({ code: 'serverUnreachable' }, { cause: error });
    }
    let data: unknown;
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch (error) {
        if (response.ok) throw invalidRecord(error);
      }
    }
    if (response.status === 401) options.onUnauthorized?.();
    if (!response.ok) {
      const fallback: Message = response.status === 401 ? { code: 'authRequired' }
        : response.status >= 500 ? { code: 'storageUnavailable' } : { code: 'operationFailed' };
      throw new MessageError((isRecord(data) && parseMessage(data.error)) || fallback);
    }
    return data;
  }

  return {
    async session(): Promise<boolean> {
      const data = await request('GET', 'session');
      return isRecord(data) && data.authenticated === true;
    },
    async login(password: string): Promise<void> {
      await request('POST', 'session', { password });
    },
    async logout(): Promise<void> {
      await request('DELETE', 'session');
    },
    async snapshot(): Promise<LibrarySnapshot> {
      return readSnapshot(await request('GET', 'library'));
    },
    async list(): Promise<StoredEntry[]> {
      return readSnapshot(await request('GET', 'library')).words;
    },
    async save(entry: unknown, categoryIds: readonly number[] = []): Promise<StoredEntry> {
      return readEntry(await request('POST', 'words', { entry, categoryIds: [...categoryIds] }));
    },
    async remove(id: number): Promise<void> {
      if (!Number.isSafeInteger(id) || id <= 0) throw new MessageError({ code: 'storageInvalidId' });
      await request('DELETE', `words/${id}`);
    },
    async createCategory(name: unknown): Promise<Category> {
      return readCategory(await request('POST', 'categories', { name }));
    },
    async renameCategory(id: number, name: unknown): Promise<Category> {
      if (!Number.isSafeInteger(id) || id <= 0) throw new MessageError({ code: 'storageInvalidId' });
      return readCategory(await request('PATCH', `categories/${id}`, { name }));
    },
    async deleteCategory(id: number): Promise<void> {
      if (!Number.isSafeInteger(id) || id <= 0) throw new MessageError({ code: 'storageInvalidId' });
      await request('DELETE', `categories/${id}`);
    },
    async updateWordCategories(wordIds: readonly number[], change: CategoryChange): Promise<ClassificationCounts> {
      return readCounts(await request('POST', 'word-categories', { wordIds: [...wordIds], change }),
        ['changed', 'unchanged', 'missing'] as const);
    },
    async importEntries(
      batch: ImportBatch,
      { overwriteExisting = false, selectedCategoryIds = [] }: { overwriteExisting?: boolean; selectedCategoryIds?: readonly number[] } = {},
    ): Promise<ImportCounts> {
      const body = { batch, overwriteExisting: overwriteExisting === true, selectedCategoryIds: [...selectedCategoryIds] };
      return readCounts(await request('POST', 'import', body, true),
        ['imported', 'updated', 'skipped', 'classified', 'categoriesCreated'] as const);
    },
  };
}

export type ApiStore = ReturnType<typeof createApiStore>;
