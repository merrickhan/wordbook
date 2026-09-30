import { validateCreated, validateDatedEntry, validateEntry } from './entry';
import type { DatedEntry, StoredEntry } from './entry';
import { MessageError, type Message } from './messages';

type StoreOptions = { name: string; indexedDB?: IDBFactory; now?: () => Date };
type WatchRequest = <T>(request: IDBRequest<T>, success: (value: T) => void) => void;

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
      const request = factory.open(options.name, 1);
      const abortUpgrade = () => {
        try {
          request.transaction?.abort();
        } catch {
          // An external close or failure may have already aborted the upgrade transaction.
        }
      };
      request.onupgradeneeded = () => {
        if (settled) {
          abortUpgrade();
          return;
        }
        try {
          const words = request.result.createObjectStore('words', {
            keyPath: 'id',
            autoIncrement: true,
          });
          words.createIndex('word', 'word', { unique: true });
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
    start: (words: IDBObjectStore, watch: WatchRequest, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await open();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction('words', mode);
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
        start(transaction.objectStore('words'), watch, result => {
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

  async function list(): Promise<StoredEntry[]> {
    return transact<StoredEntry[]>('readonly', (words, watch, result) => {
      const entries: StoredEntry[] = [];
      watch(words.openCursor(null, 'prev'), cursor => {
        if (!cursor) {
          result(entries);
          return;
        }
        const id = cursor.primaryKey;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
          throw new MessageError({ code: 'storageInvalidRecord' });
        entries.push({ ...validateDatedEntry(cursor.value), id });
        cursor.continue();
      });
    });
  }

  async function save(value: unknown): Promise<StoredEntry> {
    const entry = validateEntry(value);
    let created: string;
    try {
      created = validateCreated(now().toISOString());
    } catch (error) {
      throw new MessageError({ code: 'invalidClock' }, { cause: error });
    }
    return transact<StoredEntry>('readwrite', (words, watch, result) => {
      watch(words.index('word').getKey(entry.word), existing => {
        if (existing !== undefined)
          throw new MessageError({ code: 'duplicateWord', params: { word: entry.word } });
        const dated = { ...entry, created };
        watch(words.add(dated), id => {
          if (typeof id !== 'number') throw new MessageError({ code: 'storageInvalidId' });
          result({ ...dated, id });
        });
      });
    });
  }

  async function remove(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new MessageError({ code: 'storageInvalidId' });
    return transact<void>('readwrite', (words, watch, result) => {
      watch(words.delete(id), () => result(undefined));
    });
  }

  async function importEntries(values: readonly DatedEntry[]): Promise<{ imported: number; skipped: number }> {
    if (!Array.isArray(values)) throw new MessageError({ code: 'importEntriesInvalid' });
    // Validate the entire batch, including duplicates, before starting a single readwrite transaction.
    const entries = Array.from(values, validateDatedEntry);
    return transact('readwrite', (words, watch, result) => {
      const counts = { imported: 0, skipped: 0 };
      const seen = new Set<string>();
      const index = words.index('word');
      result(counts);
      for (const entry of entries) {
        if (seen.has(entry.word)) {
          counts.skipped++;
          continue;
        }
        seen.add(entry.word);
        watch(index.getKey(entry.word), existing => {
          if (existing !== undefined) counts.skipped++;
          else watch(words.add(entry), () => counts.imported++);
        });
      }
    });
  }

  async function close(): Promise<void> {
    opening?.cancel();
    if (connection) release(connection);
    await Promise.allSettled([...active]);
  }

  return { list, save, remove, importEntries, close };
}
