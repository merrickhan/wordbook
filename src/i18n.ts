import { defaultMessages, renderMessage, type Message, type MessageCatalog } from './messages';

export type Locale = 'zh-CN' | 'en';

const chinese = {
  pageTitle: 'Wordbook · 英语生词本',
  pageDescription: '你的私人英语生词本',
  home: 'Wordbook 首页',
  brandSubtitle: '英语生词本',
  language: '界面语言',
  notebook: '我的生词本',
  railNote: '把遇见的单词，变成自己的词汇。',
  intro: '记录日常遇见的生词，让每一次阅读都有收获。',
  addWord: '添加生词',
  captureHeading: '今天遇见了什么新单词？',
  englishWord: '英语单词',
  wordPlaceholder: '输入英文单词，例如 serendipity',
  querying: '正在查询…',
  autoFill: '自动补全',
  enterManually: '手动填写',
  phonetic: '音标',
  translation: '中文释义',
  posDefinition: '词性与解释',
  example: '例句',
  editDraft: '编辑生词草稿',
  reviewSave: '检查并保存',
  closeDraft: '关闭草稿',
  manualTip: '填写你需要的内容；暂时没有资料的字段可以留空。',
  machineTip: '自动查询结果可修改；中文释义为机器翻译，请结合语境检查。',
  dictionaryTip: '自动查询结果可修改；词典释义和译词请结合语境检查。',
  word: '单词',
  pos: '词性',
  definition: '英文解释',
  save: '保存到生词本',
  myWords: '我的单词',
  importBackup: '导入备份',
  exportBackup: '导出备份',
  chooseBackup: '选择 Wordbook 备份文件',
  storageNote: '数据仅保存在当前浏览器，不会自动同步。清理网站数据可能丢失词条，请定期导出备份。',
  importNote: '导入时合并词条、跳过重复内容，不覆盖已有单词。',
  loading: '正在打开生词本…',
  reload: '重新加载',
  lookupProviders: '自动查询：',
  sampleTag: '格式示例',
  savedTag: '已收录',
  phoneticPlaceholder: '音标待补充',
  translationPlaceholder: '中文释义待补充',
  posPlaceholder: '词性待补充',
  definitionPlaceholder: '英文解释待补充',
  examplePlaceholder: '例句待补充',
  sampleFooter: '按这个格式，记下每一次遇见。',
  addSample: '添加这个单词',
  source: '来源：',
  wiktionaryArticle: 'Wiktionary 原词条',
  manualSource: '手动填写',
  sampleSource: '用户提供的示例',
  machineSource: 'MyMemory（机器翻译）',
  dictionarySource: '词典摘录，可经编辑',
  speak: (word: string) => '朗读 ' + word,
};

type UI = { [K in keyof typeof chinese]: typeof chinese[K] extends string ? string : typeof chinese[K] };

export const ui: Record<Locale, UI> = {
  'zh-CN': chinese,
  en: {
    pageTitle: 'Wordbook · Vocabulary Notebook',
    pageDescription: 'Your personal English vocabulary notebook',
    home: 'Wordbook home',
    brandSubtitle: 'English vocabulary',
    language: 'Interface language',
    notebook: 'My notebook',
    railNote: 'Make the words you discover your own.',
    intro: 'Keep the words you discover. Take something from every read.',
    addWord: 'Add a word',
    captureHeading: 'What new word did you find today?',
    englishWord: 'English word',
    wordPlaceholder: 'Enter an English word, e.g. serendipity',
    querying: 'Looking up…',
    autoFill: 'Auto-fill',
    enterManually: 'Enter manually',
    phonetic: 'IPA',
    translation: 'Chinese meaning',
    posDefinition: 'Part of speech & definition',
    example: 'Example',
    editDraft: 'Edit word draft',
    reviewSave: 'Review and save',
    closeDraft: 'Close draft',
    manualTip: 'Add the details you need. Fields you have no information for can stay empty.',
    machineTip: 'You can edit these results. The Chinese meaning is machine-translated; check it in context.',
    dictionaryTip: 'You can edit these results. Check the dictionary definition and translations in context.',
    word: 'Word',
    pos: 'Part of speech',
    definition: 'English definition',
    save: 'Save to notebook',
    myWords: 'My words',
    importBackup: 'Import backup',
    exportBackup: 'Export backup',
    chooseBackup: 'Choose a Wordbook backup file',
    storageNote: 'Words are stored only in this browser and do not sync automatically. Clearing site data may erase them. Export backups regularly.',
    importNote: 'Import merges entries and skips duplicates without replacing existing words.',
    loading: 'Opening your notebook…',
    reload: 'Reload',
    lookupProviders: 'Auto-fill: ',
    sampleTag: 'Sample entry',
    savedTag: 'Saved',
    phoneticPlaceholder: 'IPA not added yet',
    translationPlaceholder: 'Chinese meaning not added yet',
    posPlaceholder: 'Part of speech not added yet',
    definitionPlaceholder: 'English definition not added yet',
    examplePlaceholder: 'Example not added yet',
    sampleFooter: 'Use this format for the words you discover.',
    addSample: 'Add this word',
    source: 'Source: ',
    wiktionaryArticle: 'Original Wiktionary entry',
    manualSource: 'Entered manually',
    sampleSource: 'User-provided example',
    machineSource: 'MyMemory (machine translation)',
    dictionarySource: 'Dictionary excerpt; may be edited',
    speak: (word: string) => 'Pronounce ' + word,
  },
};

export const messages: Record<Locale, MessageCatalog> = {
  'zh-CN': defaultMessages,
  en: {
    operationFailed: 'The operation failed. Please try again.',
    invalidEntry: 'The entry is invalid.',
    invalidWord: 'Enter a valid English word or phrase (up to 80 characters).',
    invalidFields: 'The entry contains invalid or overly long fields.',
    invalidCreated: 'The backup contains an invalid creation date. Use an original Wordbook export.',
    backupTooLarge: 'The backup exceeds the 10 MiB import/export limit.',
    backupEntriesInvalid: 'The backup entries must be an array of words.',
    backupTooManyEntries: 'The backup exceeds the 10,000-entry import/export limit.',
    backupInvalidJson: 'The backup is not a valid JSON file.',
    backupInvalidFormat: 'Invalid backup format. Choose a JSON file exported by Wordbook.',
    backupInvalidStructure: 'The backup must contain exactly format, version, exportedAt and entries.',
    backupWrongFormat: 'This file is not a Wordbook backup.',
    backupUnsupportedVersion: 'Unsupported backup version. Use a version 1 Wordbook backup.',
    backupInvalidId: 'An entry has an invalid ID. The backup could not be exported.',
    storageUnavailable: 'Cannot access or save your local notebook. Check your browser storage settings and try again.',
    storageQuota: 'Browser storage is full. No changes were saved. Free up space and try again.',
    storageDenied: 'Your browser blocked access to the local notebook. Check privacy and storage permissions, then try again.',
    storageVersion: 'The local notebook version is incompatible. Close other tabs and update or reload this page.',
    storageInactive: 'The local notebook connection is no longer active. Please try again.',
    storageAborted: 'The local notebook operation was aborted. No changes were saved. Please try again.',
    storageConstraint: 'A local notebook data constraint failed. No changes were saved. Please try again.',
    storageClosed: 'The local notebook connection was closed. Please try again.',
    storageUnsupported: 'This browser cannot store your notebook. Use a browser that supports IndexedDB.',
    storageBlocked: 'Another tab is blocking the local notebook. Close other Wordbook tabs and try again.',
    storageInvalidRecord: 'A local notebook record is invalid. Keep your existing data and check your backups.',
    invalidClock: 'Cannot get a valid current time. Check your device clock and try again.',
    storageInvalidId: 'The local notebook returned an invalid entry ID.',
    importEntriesInvalid: 'Imported entries must be an array.',
    operationBusy: 'Wait for the current save or backup operation to finish.',
    manualInvalidWord: 'First enter a valid English word or phrase (up to 80 characters).',
    storeNotReady: 'Your notebook is not open yet. Reload it first.',
    saved: 'Saved to your notebook in this browser.',
    exported: 'Your backup download has started. Check that the file has been saved.',
    importFileTooLarge: 'The backup file must not exceed 10 MiB.',
    speechUnsupported: 'This browser does not support pronunciation playback.',
    dictionaryUnavailable: 'The dictionary is unavailable or has no entry for this word. You can fill in the details and save it.',
    missingTranslation: 'No Chinese meaning was found. Please add one.',
    missingExample: 'The dictionary has no example for this meaning. You can add the sentence where you found the word.',
    missingPhonetic: 'No IPA transcription was found.',
    duplicateWord: ({ word }) => `“${word}” is already in your notebook. The original entry was kept.`,
    imported: ({ imported, skipped }) =>
      `Imported ${imported} ${imported === 1 ? 'word' : 'words'} and skipped ${skipped} ${skipped === 1 ? 'duplicate' : 'duplicates'}. Existing entries were not replaced.`,
    loadFailed: reason => 'Could not read your notebook: ' + reason,
    importFailed: reason => 'Import failed: ' + reason,
  },
};

export function formatMessage(locale: Locale, message: Message): string {
  return renderMessage(messages[locale], message);
}

export function sourceLabel(locale: Locale, value: string): string {
  switch (value) {
    case '手动填写': return ui[locale].manualSource;
    case '用户提供的示例': return ui[locale].sampleSource;
    case 'MyMemory（机器翻译）': return ui[locale].machineSource;
    case '词典摘录，可经编辑': return ui[locale].dictionarySource;
    default: return value;
  }
}

export function formatDate(locale: Locale, created: string): string {
  return new Date(created).toLocaleDateString(locale);
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'> | undefined;
const browserStorage: StorageAccess = () => globalThis.localStorage;

export function readLocale(namespace: string, getStorage: StorageAccess = browserStorage): Locale {
  try {
    const value = getStorage()?.getItem(`${namespace}:locale`);
    return value === 'en' ? 'en' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

export function writeLocale(namespace: string, locale: Locale, getStorage: StorageAccess = browserStorage): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(`${namespace}:locale`, locale);
    return true;
  } catch {
    // 偏好不可持久化时仍允许切换，不覆盖查词或备份的提示。
    return false;
  }
}
