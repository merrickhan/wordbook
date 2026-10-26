// Postgres-backed notebook with the same contracts the former IndexedDB store provided.
import { validateCreated, validateDatedEntry, validateEntry, type DatedEntry, type StoredEntry } from '../src/entry.js';
import {
  MAX_CATEGORIES, applyCategoryChange, categoryNameKey, normalizeCategoryName,
  validateCategoryChange, validateCategoryIds, validateImportBatch,
  type Category, type CategoryChange, type ImportBatch, type LibrarySnapshot,
} from '../src/categories.js';
import { MAX_BACKUP_ENTRIES } from '../src/backup.js';
import { MessageError, type Message } from '../src/messages.js';
import { sqlState, type Database, type Queryable } from './db.js';
import { WRITE_LOCK, ensureSchema } from './schema.js';

export type ImportCounts = { imported: number; updated: number; skipped: number; classified: number; categoriesCreated: number };
export type ClassificationCounts = { changed: number; unchanged: number; missing: number };
export type ImportOptions = { overwriteExisting?: unknown; selectedCategoryIds?: unknown };

type CategoryDirectory = Map<number, Category>;
type WordRow = {
  id: unknown; word: unknown; phonetic: unknown; translation: unknown; pos: unknown;
  definition: unknown; example: unknown; source: unknown; created: unknown; category_ids: unknown;
};

function storageError(error: unknown): Error {
  if (error instanceof MessageError) return error;
  const state = sqlState(error);
  const message: Message = state === '23505' || state === '23503' || state === '23514'
    ? { code: 'storageConstraint' }
    : { code: 'storageUnavailable' };
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

function requireCategories(ids: readonly number[], directory: CategoryDirectory) {
  if (ids.some(id => !directory.has(id))) throw new MessageError({ code: 'categoryMissing' });
}

async function readDirectory(tx: Queryable): Promise<CategoryDirectory> {
  const { rows } = await tx.query<{ id: unknown; name: unknown; normalized_name: unknown }>(
    'SELECT id, name, normalized_name FROM categories ORDER BY id',
  );
  const directory: CategoryDirectory = new Map();
  try {
    if (rows.length > MAX_CATEGORIES) throw new Error('Too many stored categories');
    for (const row of rows) {
      const id = validateId(row.id);
      const name = normalizeCategoryName(row.name);
      if (name !== row.name || categoryNameKey(name) !== row.normalized_name) throw new Error('Invalid stored category');
      directory.set(id, { id, name });
    }
  } catch (error) {
    throw new MessageError({ code: 'storageInvalidRecord' }, { cause: error });
  }
  return directory;
}

const WORD_COLUMNS = `w.id, w.word, w.phonetic, w.translation, w.pos, w.definition, w.example, w.source, w.created,
  COALESCE(array_agg(wc.category_id ORDER BY wc.category_id) FILTER (WHERE wc.category_id IS NOT NULL), '{}'::integer[]) AS category_ids`;

async function selectWords(tx: Queryable, where: string, params: readonly unknown[]): Promise<WordRow[]> {
  const { rows } = await tx.query<WordRow>(
    `SELECT ${WORD_COLUMNS} FROM words w LEFT JOIN word_categories wc ON wc.word_id = w.id
     ${where} GROUP BY w.id ORDER BY w.id DESC`,
    params,
  );
  return rows;
}

function readWord(row: WordRow, directory: CategoryDirectory): StoredEntry {
  try {
    const id = validateId(row.id);
    const entry = validateDatedEntry(row);
    if (entry.word !== row.word) throw new Error('Stored word is not normalized');
    const categoryIds = validateCategoryIds(row.category_ids);
    requireCategories(categoryIds, directory);
    return { ...entry, id, categoryIds };
  } catch (error) {
    throw new MessageError({ code: 'storageInvalidRecord' }, { cause: error });
  }
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function link(tx: Queryable, pairs: readonly (readonly [number, number])[]) {
  if (!pairs.length) return;
  await tx.query(
    `INSERT INTO word_categories (word_id, category_id)
     SELECT * FROM unnest($1::integer[], $2::integer[]) ON CONFLICT DO NOTHING`,
    [pairs.map(([word]) => word), pairs.map(([, category]) => category)],
  );
}

const lexicalFields = ['word', 'phonetic', 'translation', 'pos', 'definition', 'example', 'source', 'created'] as const;
const lexicalRecord = lexicalFields.map(field => `${field} text`).join(', ');

export function createLibraryStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  async function run<T>(mode: 'read' | 'write', work: (tx: Queryable) => Promise<T>): Promise<T> {
    try {
      await ensureSchema(db);
      return await db.transaction(mode, async tx => {
        // Serialize every writer, like an IndexedDB readwrite transaction spanning both stores.
        if (mode === 'write') await tx.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
        return work(tx);
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  async function snapshot(): Promise<LibrarySnapshot> {
    return run('read', async tx => {
      const directory = await readDirectory(tx);
      const words = (await selectWords(tx, '', [])).map(row => readWord(row, directory));
      return { words, categories: [...directory.values()] };
    });
  }

  async function list(): Promise<StoredEntry[]> {
    return (await snapshot()).words;
  }

  async function save(value: unknown, categoryIds: unknown = []): Promise<StoredEntry> {
    const entry = validateEntry(value);
    const ids = validateCategoryIds(categoryIds);
    let created: string;
    try {
      created = validateCreated(now().toISOString());
    } catch (error) {
      throw new MessageError({ code: 'invalidClock' }, { cause: error });
    }
    return run('write', async tx => {
      requireCategories(ids, await readDirectory(tx));
      // Writers are serialized, so checking first avoids consuming an identity value on duplicates.
      if ((await tx.query('SELECT 1 FROM words WHERE word = $1', [entry.word])).rows.length)
        throw new MessageError({ code: 'duplicateWord', params: { word: entry.word } });
      const { rows } = await tx.query<{ id: unknown }>(
        `INSERT INTO words (word, phonetic, translation, pos, definition, example, source, created)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [entry.word, entry.phonetic, entry.translation, entry.pos, entry.definition, entry.example, entry.source, created],
      );
      const id = validateId(rows[0].id);
      await link(tx, ids.map(category => [id, category] as const));
      return { ...entry, created, categoryIds: ids, id };
    });
  }

  async function remove(id: unknown): Promise<void> {
    const wordId = validateId(id);
    await run('write', async tx => {
      await tx.query('DELETE FROM words WHERE id = $1::bigint', [wordId]);
    });
  }

  async function createCategory(value: unknown): Promise<Category> {
    const name = normalizeCategoryName(value);
    const normalizedName = categoryNameKey(name);
    return run('write', async tx => {
      const directory = await readDirectory(tx);
      if ([...directory.values()].some(category => categoryNameKey(category.name) === normalizedName))
        throw new MessageError({ code: 'duplicateCategory' });
      if (directory.size >= MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
      const { rows } = await tx.query<{ id: unknown }>(
        'INSERT INTO categories (name, normalized_name) VALUES ($1, $2) RETURNING id', [name, normalizedName],
      );
      return { id: validateId(rows[0].id), name };
    });
  }

  async function renameCategory(id: unknown, value: unknown): Promise<Category> {
    const categoryId = validateId(id);
    const name = normalizeCategoryName(value);
    const normalizedName = categoryNameKey(name);
    return run('write', async tx => {
      const directory = await readDirectory(tx);
      if (!directory.has(categoryId)) throw new MessageError({ code: 'categoryMissing' });
      if ([...directory.values()].some(category => category.id !== categoryId && categoryNameKey(category.name) === normalizedName))
        throw new MessageError({ code: 'duplicateCategory' });
      await tx.query('UPDATE categories SET name = $2, normalized_name = $3 WHERE id = $1', [categoryId, name, normalizedName]);
      return { id: categoryId, name };
    });
  }

  async function deleteCategory(id: unknown): Promise<void> {
    const categoryId = validateId(id);
    // Relationships cascade in the same statement; every word is kept. Missing IDs are idempotent.
    await run('write', async tx => {
      await tx.query('DELETE FROM categories WHERE id = $1::bigint', [categoryId]);
    });
  }

  async function updateWordCategories(wordIds: unknown, value: unknown): Promise<ClassificationCounts> {
    const ids = validateWordIds(wordIds);
    const change: CategoryChange = validateCategoryChange(value);
    return run('write', async tx => {
      const directory = await readDirectory(tx);
      if (change.mode !== 'clear') requireCategories(change.categoryIds, directory);
      const counts = { changed: 0, unchanged: 0, missing: 0 };
      if (!ids.length) return counts;
      const current = new Map((await selectWords(tx, 'WHERE w.id = ANY($1::bigint[])', [ids]))
        .map(row => readWord(row, directory))
        .map(entry => [entry.id, entry]));
      const replaced: number[] = [];
      const pairs: [number, number][] = [];
      for (const id of ids) {
        const entry = current.get(id);
        if (!entry) {
          counts.missing++;
          continue;
        }
        const categoryIds = applyCategoryChange(entry.categoryIds, change);
        if (sameIds(categoryIds, entry.categoryIds)) {
          counts.unchanged++;
          continue;
        }
        counts.changed++;
        replaced.push(id);
        for (const category of categoryIds) pairs.push([id, category]);
      }
      // Relationship rows are separate from lexical columns, so stored word content is never rewritten.
      if (replaced.length) await tx.query('DELETE FROM word_categories WHERE word_id = ANY($1::integer[])', [replaced]);
      await link(tx, pairs);
      return counts;
    });
  }

  async function importEntries(value: unknown, options: ImportOptions = {}): Promise<ImportCounts> {
    // Validate and copy the complete batch and options before any database work.
    const batch: ImportBatch = validateImportBatch(value);
    if (batch.entries.length > MAX_BACKUP_ENTRIES) throw new MessageError({ code: 'backupTooManyEntries' });
    const selected = validateCategoryIds(options?.selectedCategoryIds ?? []);
    const overwrite = options?.overwriteExisting === true;
    return run('write', async tx => {
      const directory = await readDirectory(tx);
      requireCategories(selected, directory);
      const byName = new Map([...directory.values()].map(category => [categoryNameKey(category.name), category.id]));
      const missing = batch.categories.filter(name => !byName.has(categoryNameKey(name)));
      if (directory.size + missing.length > MAX_CATEGORIES) throw new MessageError({ code: 'tooManyCategories' });
      const counts: ImportCounts = { imported: 0, updated: 0, skipped: 0, classified: 0, categoriesCreated: 0 };

      if (missing.length) {
        const { rows } = await tx.query<{ id: unknown; normalized_name: unknown }>(
          `INSERT INTO categories (name, normalized_name)
           SELECT name, normalized_name FROM unnest($1::text[], $2::text[], $3::integer[]) AS t(name, normalized_name, ord)
           ORDER BY ord RETURNING id, normalized_name`,
          [missing, missing.map(categoryNameKey), missing.map((_, index) => index)],
        );
        for (const row of rows) {
          byName.set(String(row.normalized_name), validateId(row.id));
          counts.categoriesCreated++;
        }
      }

      // First occurrence wins for content and references; later duplicates are validated but skipped.
      const seen = new Set<string>();
      const firsts: { entry: DatedEntry; incoming: number[] }[] = [];
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
        firsts.push({ entry, incoming });
      }
      if (!firsts.length) return counts;

      const existing = new Map((await selectWords(tx, 'WHERE w.word = ANY($1::text[])', [firsts.map(({ entry }) => entry.word)]))
        .map(row => readWord(row, directory))
        .map(entry => [entry.word, entry]));
      const additions: { entry: DatedEntry; incoming: number[] }[] = [];
      const overwrites: (DatedEntry & { id: number })[] = [];
      const pairs: [number, number][] = [];
      for (const item of firsts) {
        const current = existing.get(item.entry.word);
        if (!current) {
          additions.push(item);
          continue;
        }
        const categoryIds = applyCategoryChange(current.categoryIds, { mode: 'add', categoryIds: item.incoming });
        if (categoryIds.length > current.categoryIds.length) {
          counts.classified++;
          for (const id of categoryIds) if (!current.categoryIds.includes(id)) pairs.push([current.id, id]);
        }
        if (overwrite) {
          // Overwrite replaces every lexical field and the date but keeps the local ID and recency.
          overwrites.push({ ...item.entry, id: current.id });
          counts.updated++;
        } else counts.skipped++;
      }

      if (additions.length) {
        const { rows } = await tx.query<{ id: unknown; word: unknown }>(
          `INSERT INTO words (${lexicalFields.join(', ')})
           SELECT ${lexicalFields.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(ord integer, ${lexicalRecord})
           ORDER BY ord RETURNING id, word`,
          [JSON.stringify(additions.map(({ entry }, ord) => ({ ord, ...entry })))],
        );
        const added = new Map(rows.map(row => [String(row.word), validateId(row.id)]));
        for (const { entry, incoming } of additions) {
          const id = added.get(entry.word);
          if (id === undefined) throw new Error('Inserted word was not returned');
          counts.imported++;
          if (incoming.length) {
            counts.classified++;
            for (const category of incoming) pairs.push([id, category]);
          }
        }
      }
      if (overwrites.length) {
        await tx.query(
          `UPDATE words SET phonetic = x.phonetic, translation = x.translation, pos = x.pos,
             definition = x.definition, example = x.example, source = x.source, created = x.created
           FROM jsonb_to_recordset($1::jsonb) AS x(id integer, ${lexicalRecord})
           WHERE words.id = x.id`,
          [JSON.stringify(overwrites)],
        );
      }
      await link(tx, pairs);
      return counts;
    });
  }

  return {
    snapshot, list, save, remove, createCategory, renameCategory, deleteCategory,
    updateWordCategories, importEntries,
  };
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;
