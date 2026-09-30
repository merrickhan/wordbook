import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { defaultMessages, errorMessage, MessageError, type Message } from '../src/messages';
import { formatDate, formatMessage, messages, readLocale, sourceLabel, ui, writeLocale } from '../src/i18n';
import { createEntry, sample, validateCreated, validateEntry } from '../src/entry';
import { parseBackup, serializeBackup } from '../src/backup';
import { createWordStore, databaseName } from '../src/storage';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function hasMessage(detail: Message, cause?: unknown) {
  return (error: unknown) => {
    assert.ok(error instanceof MessageError);
    assert.deepEqual(error.detail, detail);
    if (cause !== undefined) assert.equal(error.cause, cause);
    assert.equal(error.message, formatMessage('zh-CN', detail));
    assert.notEqual(formatMessage('en', error.detail), error.message);
    return true;
  };
}

test('both locales have complete UI and message catalogs with matching value types', () => {
  assert.deepEqual(Object.keys(ui.en).sort(), Object.keys(ui['zh-CN']).sort());
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(defaultMessages).sort());
  assert.equal(messages['zh-CN'], defaultMessages);
  for (const key of Object.keys(ui.en) as (keyof typeof ui.en)[]) {
    assert.equal(typeof ui.en[key], typeof ui['zh-CN'][key]);
    assert.ok(ui.en[key]);
    assert.ok(ui['zh-CN'][key]);
  }
  for (const code of Object.keys(defaultMessages) as (keyof typeof defaultMessages)[]) {
    assert.equal(typeof messages.en[code], typeof defaultMessages[code]);
    if (typeof defaultMessages[code] !== 'string') continue;
    const message = { code } as Message;
    assert.equal(formatMessage('zh-CN', message), defaultMessages[code]);
    assert.ok(formatMessage('en', message).length > 0);
    assert.doesNotMatch(formatMessage('en', message), /[㐀-鿿]/);
  }
  assert.equal(ui.en.speak('apple'), 'Pronounce apple');
  assert.equal(ui['zh-CN'].speak('apple'), '朗读 apple');
});

test('compact dictionary hints and source-aware disclosure labels are localized', () => {
  assert.equal(ui['zh-CN'].dictionaryHint, '切换会取消当前查询，保留已完成草稿。');
  assert.equal(ui.en.dictionaryHint, 'Switching cancels active lookups; completed drafts stay.');
  assert.equal(ui['zh-CN'].dictionaryAccentHint, '此词典不标注口音。');
  assert.equal(ui.en.dictionaryAccentHint, 'Accents are not labeled.');
  assert.equal(ui['zh-CN'].entryDetails, '详情与来源');
  assert.equal(ui.en.entryDetails, 'Details & source');
});

test('duplicate word parameters are preserved and formatted only at display time', () => {
  const message: Message = { code: 'duplicateWord', params: { word: "don't" } };
  const before = structuredClone(message);
  assert.equal(formatMessage('zh-CN', message), '“don\'t” 已在词本中，原词条已保留。');
  assert.equal(formatMessage('en', message), '“don\'t” is already in your notebook. The original entry was kept.');
  assert.deepEqual(message, before);
});

test('deletion labels, confirmation and structured feedback preserve the word in both locales', () => {
  const word = "don't";
  assert.equal(ui['zh-CN'].deleteWord(word), '删除 don\'t');
  assert.equal(ui.en.deleteWord(word), 'Delete don\'t');
  assert.equal(ui['zh-CN'].confirmDelete(word), '确定删除“don\'t”吗？此操作无法撤销。');
  assert.equal(ui.en.confirmDelete(word), 'Delete “don\'t”? This cannot be undone.');
  const message: Message = { code: 'deleted', params: { word } };
  const before = structuredClone(message);
  assert.equal(formatMessage('zh-CN', message), '已从词本删除“don\'t”。');
  assert.equal(formatMessage('en', message), 'Deleted “don\'t” from your notebook.');
  assert.deepEqual(message, before);
  const failure: Message = { code: 'deleteFailed', params: { reason: { code: 'storageAborted' } } };
  assert.equal(formatMessage('zh-CN', failure), '删除失败：本地词库操作已中止，未保存任何更改。请重试。');
  assert.equal(formatMessage('en', failure), 'Deletion failed: The local notebook operation was aborted. No changes were saved. Please try again.');
  assert.match(formatMessage('zh-CN', { code: 'operationBusy' }), /删除/);
  assert.match(formatMessage('en', { code: 'operationBusy' }), /delete/);
});

test('import counts use independent English plurals for zero, one and many', () => {
  for (const imported of [0, 1, 7]) {
    for (const skipped of [0, 1, 3]) {
      const message: Message = { code: 'imported', params: { imported, skipped } };
      assert.equal(formatMessage('zh-CN', message),
        `已导入 ${imported} 个单词，跳过 ${skipped} 个重复词。已有内容未覆盖。`);
      assert.equal(formatMessage('en', message),
        `Imported ${imported} ${imported === 1 ? 'word' : 'words'} and skipped ${skipped} ${skipped === 1 ? 'duplicate' : 'duplicates'}. Existing entries were not replaced.`);
    }
  }
});

test('error context and cause descriptors switch language together', () => {
  const cause = new SyntaxError('private diagnostic');
  const error = new MessageError({ code: 'backupInvalidJson' }, { cause });
  assert.equal(error.cause, cause);
  assert.equal(error.message, defaultMessages.backupInvalidJson);
  assert.equal(errorMessage(error), error.detail);
  const message: Message = { code: 'importFailed', params: { reason: errorMessage(error) } };
  assert.equal(formatMessage('zh-CN', message), '导入失败：备份不是有效的 JSON 文件。');
  assert.equal(formatMessage('en', message), 'Import failed: The backup is not a valid JSON file.');
  assert.equal(formatMessage('en', { code: 'loadFailed', params: { reason: { code: 'storageQuota' } } }),
    'Could not read your notebook: Browser storage is full. No changes were saved. Free up space and try again.');
});

test('unknown errors use a localized fallback without displaying arbitrary diagnostics', () => {
  for (const error of [new Error('private 中文'), '<script>bad</script>', null, { detail: { code: 'saved' } }]) {
    assert.deepEqual(errorMessage(error), { code: 'operationFailed' });
    assert.equal(formatMessage('en', errorMessage(error)), 'The operation failed. Please try again.');
  }
});

test('preferences default to Chinese and accept only supported stored locales', () => {
  const storage = memoryStorage();
  const getStorage = () => storage;
  assert.equal(readLocale('wordbook:/', getStorage), 'zh-CN');
  for (const value of ['zh-CN', 'en', 'EN', 'en-US', '', 'null', 'zh-TW', '<script>']) {
    storage.setItem('wordbook:/:locale', value);
    assert.equal(readLocale('wordbook:/', getStorage), value === 'en' ? 'en' : 'zh-CN');
  }
  assert.equal(writeLocale('wordbook:/', 'en', getStorage), true);
  assert.equal(readLocale('wordbook:/', getStorage), 'en');
  assert.equal(writeLocale('wordbook:/', 'zh-CN', getStorage), true);
  assert.equal(readLocale('wordbook:/', getStorage), 'zh-CN');
});

test('preferences reuse the database deployment namespace without changing its normalization', () => {
  const storage = memoryStorage();
  const getStorage = () => storage;
  const root = databaseName('https://example.com/');
  const subpath = databaseName('https://example.com/wordbook/');
  writeLocale(root, 'en', getStorage);
  assert.equal(readLocale(subpath, getStorage), 'zh-CN');
  writeLocale(subpath, 'zh-CN', getStorage);
  for (const url of ['https://example.com/index.html?x=1#top', 'https://example.com/?x=1'])
    assert.equal(readLocale(databaseName(url), getStorage), 'en');
  assert.equal(readLocale(databaseName('https://example.com/wordbook/index.html?x=1#top'), getStorage), 'zh-CN');
  assert.deepEqual([...storage.data], [['wordbook:/:locale', 'en'], ['wordbook:/wordbook/:locale', 'zh-CN']]);
});

test('unavailable storage and a throwing storage getter are safe', () => {
  for (const getStorage of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
    assert.equal(readLocale('wordbook:/', getStorage), 'zh-CN');
    assert.equal(writeLocale('wordbook:/', 'en', getStorage), false);
  }
});

test('getItem and setItem failures do not escape preference helpers', () => {
  const storage = memoryStorage();
  storage.getItem = () => { throw new Error('Cannot read'); };
  assert.equal(readLocale('wordbook:/', () => storage), 'zh-CN');
  storage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  assert.equal(writeLocale('wordbook:/', 'en', () => storage), false);
});

test('only exact known source labels translate, not URLs, unknown content or old composites', () => {
  for (const [original, translated] of [
    ['手动填写', 'Entered manually'],
    ['用户提供的示例', 'User-provided example'],
    ['MyMemory（机器翻译）', 'MyMemory (machine translation)'],
    ['词典摘录，可经编辑', 'Dictionary excerpt; may be edited'],
  ]) {
    assert.equal(sourceLabel('zh-CN', original), original);
    assert.equal(sourceLabel('en', original), translated);
  }
  for (const value of [
    '', 'FreeDictionaryAPI.com', 'EnglishDictionaryAPI.com', 'CC BY-SA 4.0', '用户自己的中文笔记：手动填写',
    'Wiktionary: https://en.wiktionary.org/wiki/apple', 'MyMemory（机器翻译） | 旧来源',
    '<img src=x onerror=alert(1)>', '__proto__',
  ]) {
    assert.equal(sourceLabel('zh-CN', value), value);
    assert.equal(sourceLabel('en', value), value);
  }
});

test('accent UI and omission warnings are localized without rewriting stored IPA', () => {
  const entry = { ...sample, phonetic: 'US /a/ · UK [b]', id: 1, created: '2024-02-29T12:34:56.789Z' };
  const before = serializeBackup([entry], entry.created);
  assert.equal(ui['zh-CN'].unknownAccent, '口音未标注');
  assert.equal(ui.en.unknownAccent, 'Accent not specified');
  for (const locale of ['zh-CN', 'en'] as const) {
    assert.match(ui[locale].phoneticHint, /US.*UK/);
    assert.ok(ui[locale].dictionaryHint);
    assert.ok(ui[locale].dictionaryAccentHint);
    assert.ok(formatMessage(locale, { code: 'phoneticOmitted' }));
    assert.equal(serializeBackup([entry], entry.created), before);
  }
});

test('date formatting follows locale without changing timestamp or timezone semantics', () => {
  const created = '2024-02-29T12:34:56.789Z';
  for (const locale of ['zh-CN', 'en'] as const)
    assert.equal(formatDate(locale, created), new Date(created).toLocaleDateString(locale));
  assert.equal(created, '2024-02-29T12:34:56.789Z');
});

test('entry and backup validators expose stable codes while retaining Chinese diagnostics', () => {
  assert.throws(() => validateEntry(null), hasMessage({ code: 'invalidEntry' }));
  assert.throws(() => validateEntry({ ...sample, word: '?' }), hasMessage({ code: 'invalidWord' }));
  assert.throws(() => validateEntry({ ...sample, pos: null }), hasMessage({ code: 'invalidFields' }));
  assert.throws(() => validateCreated('yesterday'), hasMessage({ code: 'invalidCreated' }));
  assert.throws(() => parseBackup('bad JSON'), error => {
    assert.ok(hasMessage({ code: 'backupInvalidJson' })(error));
    assert.ok((error as MessageError).cause instanceof SyntaxError);
    return true;
  });
  assert.throws(() => parseBackup('{}'), hasMessage({ code: 'backupInvalidStructure' }));
});

test('formatting UI messages and sources does not alter entries or backup protocol', () => {
  const entry = { ...sample, id: 1, created: '2024-02-29T12:34:56.789Z' };
  const before = serializeBackup([entry], entry.created);
  for (const locale of ['zh-CN', 'en'] as const) {
    sourceLabel(locale, entry.source);
    formatDate(locale, entry.created);
    formatMessage(locale, { code: 'saved' });
    assert.equal(serializeBackup([entry], entry.created), before);
  }
  assert.equal(parseBackup(before)[0].translation, '调查');
  assert.equal(parseBackup(before)[0].source, '用户提供的示例');
});

test('duplicate message parameters survive transaction abort and original entries remain intact', async t => {
  const store = createWordStore({ name: 'messages-duplicate', indexedDB: new IDBFactory() });
  t.after(() => store.close());
  const original = await store.save(createEntry('apple'));
  await assert.rejects(store.save({ ...sample, word: ' APPLE ' }),
    hasMessage({ code: 'duplicateWord', params: { word: 'apple' } }));
  assert.deepEqual(await store.list(), [original]);
});

test('browser storage error classification retains the original cause', async t => {
  const cases = [
    ['QuotaExceededError', 'storageQuota'], ['SecurityError', 'storageDenied'],
    ['NotAllowedError', 'storageDenied'], ['VersionError', 'storageVersion'],
    ['InvalidStateError', 'storageInactive'], ['TransactionInactiveError', 'storageInactive'],
    ['AbortError', 'storageAborted'], ['ConstraintError', 'storageConstraint'],
    ['UnknownError', 'storageUnavailable'],
  ] as const;
  for (const [name, code] of cases) {
    const factory = new IDBFactory();
    const cause = new DOMException('private diagnostic', name);
    factory.open = () => { throw cause; };
    const store = createWordStore({ name: 'messages-' + name, indexedDB: factory });
    t.after(() => store.close());
    await assert.rejects(store.list(), hasMessage({ code }, cause));
  }
});

test('known message errors inside a write transaction retain identity, parameters and cause', async t => {
  const factory = new IDBFactory();
  const cause = new Error('original diagnostic');
  const error = new MessageError({ code: 'duplicateWord', params: { word: 'apple' } }, { cause });
  const open = factory.open.bind(factory);
  factory.open = (name, version) => {
    const request = open(name, version);
    request.addEventListener('success', () => {
      const db = request.result;
      const transact = db.transaction.bind(db);
      db.transaction = (...args: Parameters<IDBDatabase['transaction']>) => {
        const tx = transact(...args);
        if (tx.mode === 'readwrite') tx.objectStore('words').add = () => { throw error; };
        return tx;
      };
    });
    return request;
  };
  const store = createWordStore({ name: 'messages-pass-through', indexedDB: factory });
  t.after(() => store.close());
  await assert.rejects(store.save(createEntry('apple')), caught => {
    assert.equal(caught, error);
    return hasMessage(error.detail, cause)(caught);
  });
  assert.deepEqual(await store.list(), []);
});
