import { validateCreated, validateDatedEntry, validateEntry } from './entry';
import type { StoredEntry } from './entry';
import {
  MAX_CATEGORIES, applyCategoryChange, categoryNameKey, normalizeCategoryName,
  validateCategoryChange, validateCategoryIds, validateImportBatch,
  type Category, type CategoryChange, type ImportBatch, type LibrarySnapshot,
} from './categories';
import { MessageError, type Message } from './messages';

type StoreOptions = { name: string; indexedDB?: IDBFactory; now?: () => Date };
type WatchRequest = <T>(request: IDBRequest<T>, success: (value: T) => void) => void;
type CategoryDirectory = Map<number, Category>;

function storageError(error: unknown): Error {
  if (error instanceof MessageError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  let message: Message = { code: 'storageUnavailable' };
  if (name === 'QuotaExceededError')
    message = { code: 'storageQuota' };
  else if (name === 'SecurityError' || name === 'NotAllowedError')
    message = { code: 'storageDenied' };
  else if (name === 'VersionError')
    message = { code: 'storageVersion' };
  else if (name === 'InvalidStateError' || name === 'TransactionInactiveError')
    message = { code: 'storageInactive' };
  else if (name === 'AbortError')
    message = { code: 'storageAborted' };
  else if (name === 'ConstraintError')
    message = { code: 'storageConstraint' };
  return new MessageError(message, { cause: error });
}

function validateId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new MessageError({ code: 'storageInvalidId' });
  return value;
}

function validateWordIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new MessageError({ code: 'storageInvalidId' });
  return [...new Set(Array.from(value, (id, index) => {
    if (!Object.hasOwn(value, index)) throw new MessageError({ code: 'storageInvalidId' });
    return validateId(id);
  }))];
}

function readCategories(store: IDBObjectStore, watch: WatchRequest, ready: (directory: CategoryDirectory) => void) {
  watch(store.getAll(), values => {
    const directory: CategoryDirectory = new Map();
    const names = new Set<string>();
    try {
      if (values.length > MAX_CATEGORIES) throw new Error('Too many stored categories');
      for (const value of values) {
        const id = validateId(value.id);
        const name = normalizeCategoryName(value.name);
        const key = categoryNameKey(name);
        if (name !== value.name || key !== value.normalizedName || names.has(key) || directory.has(id))
          throw new Error('Invalid stored category');
        directory.set(id, { id, name });
        names.add(key);
      }
    } catch (error) {
      throw new MessageError({ code: 'storageInvalidRecord' }, { cause: error });
    }
    ready(directory);
  });
}

function requireCategories(ids: readonly number[], directory: CategoryDirectory) {
  if (ids.some(id => !directory.has(id))) throw new MessageError({ code: 'categoryMissing' });
}

function readWord(value: unknown, directory: CategoryDirectory, primaryKey?: IDBValidKey): StoredEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessageError({ code: 'storageInvalidRecord' });
  const raw = value as Record<string, unknown>;
  const id = validateId(raw.id);
  try {
    if (primaryKey !== undefined && primaryKey !== id) throw new Error('Mismatched stored ID');
    const entry = validateDatedEntry(raw);
    // Only records without the property are legacy records. Never repair them during reads.
    const categoryIds = Object.hasOwn(raw, 'categoryIds') ? validateCategoryIds(raw.categoryIds) : [];
    requireCategories(categoryIds, directory);
    return { ...entry, id, categoryIds };
  } catch (error) {
    throw new MessageError({ code: 'storageInvalidRecord' }, { cause: error });
  }
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function databaseName(pageUrl: string): string {
  return `wordbook:${new URL('.', pageUrl).pathname}`;
}

export function createWordStore(options: StoreOptions) {
  let connection: IDBDatabase | undefined;
  let opening: { promise: Promise<IDBDatabase>; cancel: () => void } | undefined;
  const active = new Set<Promise<unknown>>();
  const now = options.now ?? (() => new Date());

  function release(db: IDBDatabase) {
    if (connection === db) connection = undefined;
    db.close();
  }

  function open(): Promise<IDBDatabase> {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening.promise;
    let resolve!: (db: IDBDatabase) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<IDBDatabase>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let settled = false;
    const pending = {
      promise,
      cancel: () => fail(new MessageError({ code: 'storageClosed' })),
    };
    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      if (opening === pending) opening = undefined;
      reject(storageError(error));
    }
    opening = pending;
    try {
      // Defer browser API access so the page and retry controls can render without IndexedDB.
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory)
        throw new MessageError({ code: 'storageUnsupported' });
      const request = factory.open(options.name, 2);
      const abortUpgrade = () => {
        try {
          request.transaction?.abort();
        } catch {
          // An external close or failure may have already aborted the upgrade transaction.
        }
      };
      request.onupgradeneeded = event => {
        if (settled) {
          abortUpgrade();
          return;
        }
        try {
          if (event.oldVersion < 1) {
            const words = request.result.createObjectStore('words', {
              keyPath: 'id',
              autoIncrement: true,
            });
            words.createIndex('word', 'word', { unique: true });
          }
          if (event.oldVersion < 2) {
            const categories = request.result.createObjectStore('categories', {
              keyPath: 'id',
              autoIncrement: true,
            });
            categories.createIndex('normalizedName', 'normalizedName', { unique: true });
          }
        } catch (error) {
          fail(error);
          abortUpgrade();
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new MessageError({ code: 'storageBlocked' }));
      request.onsuccess = () => {
        const db = request.result;
        // A request may finish after blocked or close; avoid leaking connections or restoring stale caches.
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        if (opening === pending) opening = undefined;
        connection = db;
        db.onversionchange = () => release(db);
        db.onclose = () => {
          if (connection === db) connection = undefined;
        };
        resolve(db);
      };
    } catch (error) {
      fail(error);
    }
    return promise;
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    start: (words: IDBObjectStore, categories: IDBObjectStore, watch: WatchRequest, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await open();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(['words', 'categories'], mode);
    } catch (error) {
      release(db);
      throw storageError(error);
    }
    const operation = new Promise<T>((resolve, reject) => {
      let value: T;
      let hasResult = false;
      let failure: Error | undefined;
      const abort = (error: unknown) => {
        failure ??= storageError(error);
        try {
          transaction.abort();
        } catch {
          // Aborted transactions still fire onabort; oncomplete must never report a failure as success.
        }
      };
      const watch: WatchRequest = (request, success) => {
        request.onsuccess = () => {
          try {
            success(request.result);
          } catch (error) {
            abort(error);
          }
        };
      };
      transaction.onerror = event => abort((event.target as IDBRequest).error);
      transaction.onabort = () => reject(failure ?? storageError(
        transaction.error ?? new DOMException('Aborted', 'AbortError'),
      ));
      // Request success does not guarantee persistence; return results only after the transaction commits.
      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (!hasResult) reject(storageError(new Error('Transaction returned no result')));
        else resolve(value);
      };
      try {
        start(transaction.objectStore('words'), transaction.objectStore('categories'), watch, result => {
          value = result;
          hasResult = true;
        });
      } catch (error) {
        abort(error);
      }
    });
    active.add(operation);
    operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }

  async function snapshot(): Promise<LibrarySnapshot> {
    return transact('readonly', (words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        const entries: StoredEntry[] = [];
        watch(words.openCursor(null, 'prev'), cursor => {
          if (!cursor) {
            result({ words: entries, categories: [...directory.values()] });
            return;
          }
          entries.push(readWord(cursor.value, directory, cursor.primaryKey));
          cursor.continue();
        });
      });
    });
  }

  async function list(): Promise<StoredEntry[]> {
    return (await snapshot()).words;
  }

  async function save(value: unknown, categoryIds: readonly number[] = []): Promise<StoredEntry> {
    const entry = validateEntry(value);
    const ids = validateCategoryIds(categoryIds);
    let created: string;
    try {
      created = validateCreated(now().toISOString());
    } catch (error) {
      throw new MessageError({ code: 'invalidClock' }, { cause: error });
    }
    return transact('readwrite', (words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        requireCategories(ids, directory);
        watch(words.index('word').getKey(entry.word), existing => {
          if (existing !== undefined)
            throw new MessageError({ code: 'duplicateWord', params: { word: entry.word } });
          const dated = { ...entry, created, categoryIds: ids };
          watch(words.add(dated), id => result({ ...dated, id: validateId(id) }));
        });
      });
    });
  }

  async function remove(id: number): Promise<void> {
    validateId(id);
    return transact('readwrite', (words, _categories, watch, result) => {
      watch(words.delete(id), () => result(undefined));
    });
  }

  async function createCategory(value: unknown): Promise<Category> {
    const name = normalizeCategoryName(value);
    const normalizedName = categoryNameKey(name);
    return transact('readwrite', (_words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        if ([...directory.values()].some(category => categoryNameKey(category.name) === normalizedName))
          throw new MessageError({ code: 'duplicateCategory' });
        if (directory.size >= MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
        watch(categories.add({ name, normalizedName }), id => result({ id: validateId(id), name }));
      });
    });
  }

  async function renameCategory(id: number, value: unknown): Promise<Category> {
    validateId(id);
    const name = normalizeCategoryName(value);
    const normalizedName = categoryNameKey(name);
    return transact('readwrite', (_words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        if (!directory.has(id)) throw new MessageError({ code: 'categoryMissing' });
        if ([...directory.values()].some(category => category.id !== id && categoryNameKey(category.name) === normalizedName))
          throw new MessageError({ code: 'duplicateCategory' });
        watch(categories.put({ id, name, normalizedName }), () => result({ id, name }));
      });
    });
  }

  async function deleteCategory(id: number): Promise<void> {
    validateId(id);
    return transact('readwrite', (words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        result(undefined);
        if (!directory.has(id)) return;
        watch(categories.delete(id), () => {
          watch(words.openCursor(), cursor => {
            if (!cursor) return;
            const raw = cursor.value;
            const entry = readWord(raw, directory, cursor.primaryKey);
            if (entry.categoryIds.includes(id)) {
              // Relationship-only writes must not trim or reconstruct historical lexical content.
              watch(cursor.update({ ...raw, categoryIds: entry.categoryIds.filter(value => value !== id) }), () => {});
            }
            cursor.continue();
          });
        });
      });
    });
  }

  async function updateWordCategories(
    wordIds: readonly number[], value: CategoryChange,
  ): Promise<{ changed: number; unchanged: number; missing: number }> {
    const ids = validateWordIds(wordIds);
    const change = validateCategoryChange(value);
    return transact('readwrite', (words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        if (change.mode !== 'clear') requireCategories(change.categoryIds, directory);
        const counts = { changed: 0, unchanged: 0, missing: 0 };
        result(counts);
        for (const id of ids) {
          watch(words.get(id), raw => {
            if (raw === undefined) {
              counts.missing++;
              return;
            }
            const entry = readWord(raw, directory, id);
            const categoryIds = applyCategoryChange(entry.categoryIds, change);
            if (sameIds(categoryIds, entry.categoryIds)) counts.unchanged++;
            else watch(words.put({ ...raw, categoryIds }), () => counts.changed++);
          });
        }
      });
    });
  }

  async function importEntries(
    value: ImportBatch,
    { overwriteExisting = false, selectedCategoryIds = [] }: {
      overwriteExisting?: boolean; selectedCategoryIds?: readonly number[];
    } = {},
  ): Promise<{ imported: number; updated: number; skipped: number; classified: number; categoriesCreated: number }> {
    // Snapshot every record and option before the first await, including later duplicate words.
    const batch = validateImportBatch(value);
    const selected = validateCategoryIds(selectedCategoryIds);
    const overwrite = overwriteExisting === true;
    return transact('readwrite', (words, categories, watch, result) => {
      readCategories(categories, watch, directory => {
        requireCategories(selected, directory);
        const byName = new Map([...directory.values()].map(category => [categoryNameKey(category.name), category.id]));
        const missing = batch.categories.filter(name => !byName.has(categoryNameKey(name)));
        if (directory.size + missing.length > MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
        const counts = { imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 };
        result(counts);
        const importWords = () => {
          const seen = new Set<string>();
          const index = words.index('word');
          for (const { categories: names, ...entry } of batch.entries) {
            if (seen.has(entry.word)) {
              counts.skipped++;
              continue;
            }
            seen.add(entry.word);
            const incoming = validateCategoryIds([...new Set([...selected, ...names.map(name => {
              const id = byName.get(categoryNameKey(name));
              if (id === undefined) throw new MessageError({ code: 'categoryMissing' });
              return id;
            })])]);
            watch(index.get(entry.word), raw => {
              if (raw === undefined) {
                watch(words.add({ ...entry, categoryIds: incoming }), id => {
                  validateId(id);
                  counts.imported++;
                  if (incoming.length) counts.classified++;
                });
                return;
              }
              const existing = readWord(raw, directory);
              const categoryIds = applyCategoryChange(existing.categoryIds, { mode: 'add', categoryIds: incoming });
              const classified = categoryIds.length > existing.categoryIds.length;
              if (overwrite) {
                watch(words.put({ ...entry, id: existing.id, categoryIds }), () => {
                  counts.updated++;
                  if (classified) counts.classified++;
                });
              } else {
                counts.skipped++;
                if (classified) watch(words.put({ ...raw, categoryIds }), () => counts.classified++);
              }
            });
          }
        };
        if (!missing.length) importWords();
        else {
          let remaining = missing.length;
          for (const name of missing) {
            const normalizedName = categoryNameKey(name);
            watch(categories.add({ name, normalizedName }), key => {
              const id = validateId(key);
              directory.set(id, { id, name });
              byName.set(normalizedName, id);
              counts.categoriesCreated++;
              if (--remaining === 0) importWords();
            });
          }
        }
      });
    });
  }

  async function close(): Promise<void> {
    opening?.cancel();
    if (connection) release(connection);
    await Promise.allSettled([...active]);
  }

  return {
    snapshot, list, save, remove, createCategory, renameCategory, deleteCategory,
    updateWordCategories, importEntries, close,
  };
}
