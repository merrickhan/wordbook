import { validateCreated, validateDatedEntry } from './entry';
import type { DatedEntry, StoredEntry } from './entry';
import { MessageError } from './messages';

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

export function parseBackup(text: string): DatedEntry[] {
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
  if (Object.keys(backup).length !== fields.length || fields.some(key => !Object.hasOwn(backup, key)))
    throw new MessageError({ code: 'backupInvalidStructure' });
  if (backup.format !== 'wordbook') throw new MessageError({ code: 'backupWrongFormat' });
  if (backup.version !== 1) throw new MessageError({ code: 'backupUnsupportedVersion' });
  validateCreated(backup.exportedAt);
  checkEntries(backup.entries);
  return backup.entries.map(validateDatedEntry);
}

export function serializeBackup(entries: readonly StoredEntry[], exportedAt = new Date().toISOString()): string {
  checkEntries(entries);
  validateCreated(exportedAt);
  // 本地 ID 只决定备份顺序，不进入文件；恢复时重新分配 ID。
  const ordered = Array.from(entries, value => {
    const entry = validateDatedEntry(value);
    if (!Number.isSafeInteger(value.id) || value.id <= 0)
      throw new MessageError({ code: 'backupInvalidId' });
    return { id: value.id, entry };
  }).sort((a, b) => a.id - b.id).map(value => value.entry);
  const text = JSON.stringify({ format: 'wordbook', version: 1, exportedAt, entries: ordered }, null, 2);
  checkSize(text);
  return text;
}
