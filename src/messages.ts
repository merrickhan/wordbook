// 业务层只保存消息标识和参数；默认中文也用于 Error 的诊断信息。
export const defaultMessages = {
  operationFailed: '操作失败，请重试。',
  invalidEntry: '条目内容无效。',
  invalidWord: '请输入有效的英语单词或短语（最多 80 个字符）。',
  invalidFields: '条目内容无效或过长。',
  invalidCreated: '备份中的创建时间无效，请使用 Wordbook 导出的原始备份。',
  backupTooLarge: '备份文件超过 10 MiB 限制，无法导入或导出。',
  backupEntriesInvalid: '备份中的 entries 必须是词条数组。',
  backupTooManyEntries: '备份词条超过 10,000 条限制，无法导入或导出。',
  backupInvalidJson: '备份不是有效的 JSON 文件。',
  backupInvalidFormat: '备份格式无效，请选择 Wordbook 导出的 JSON 文件。',
  backupInvalidStructure: '备份结构无效，必须包含 format、version、exportedAt 和 entries。',
  backupWrongFormat: '此文件不是 Wordbook 备份。',
  backupUnsupportedVersion: '不支持此备份版本，请使用版本 1 的 Wordbook 备份。',
  backupInvalidId: '词条编号无效，无法导出备份。',
  storageUnavailable: '无法访问或保存本地词库，请检查浏览器存储设置后重试。',
  storageQuota: '浏览器存储空间不足，未保存任何更改。请释放空间后重试。',
  storageDenied: '浏览器禁止访问本地词库，请检查隐私和存储权限设置后重试。',
  storageVersion: '本地词库版本不兼容，请关闭其他标签页并更新或刷新页面后重试。',
  storageInactive: '本地词库连接已失效，请重试。',
  storageAborted: '本地词库操作已中止，未保存任何更改。请重试。',
  storageConstraint: '本地词库数据约束冲突，未保存任何更改。请重试。',
  storageClosed: '本地词库连接已关闭，请重试。',
  storageUnsupported: '此浏览器不支持本地词库存储，请换用支持 IndexedDB 的浏览器。',
  storageBlocked: '本地词库被其他标签页占用，请关闭其他 Wordbook 页面后重试。',
  storageInvalidRecord: '本地词库记录格式无效，请保留现有数据并检查备份。',
  invalidClock: '无法获取有效的当前时间，请检查设备时间后重试。',
  storageInvalidId: '本地词库返回了无效的词条编号。',
  importEntriesInvalid: '导入的词条必须是数组。',
  operationBusy: '请等待当前保存或备份操作完成。',
  manualInvalidWord: '请先输入有效的英语单词或短语（最多 80 个字符）。',
  storeNotReady: '生词本尚未打开，请先重新加载。',
  saved: '已保存到当前浏览器的生词本。',
  exported: '备份已生成并开始下载，请确认文件已保存。',
  importFileTooLarge: '备份文件不能超过 10 MiB。',
  speechUnsupported: '当前浏览器不支持朗读。',
  dictionaryUnavailable: '词典暂时不可用或未收录该词，可手动填写后保存。',
  missingTranslation: '未取得中文释义，请手动补充。',
  missingExample: '词典未提供此释义的例句，可补充你遇到的原句。',
  missingPhonetic: '未取得音标。',
  duplicateWord: ({ word }: { word: string }) => `“${word}” 已在词本中，原词条已保留。`,
  imported: ({ imported, skipped }: { imported: number; skipped: number }) =>
    `已导入 ${imported} 个单词，跳过 ${skipped} 个重复词。已有内容未覆盖。`,
  loadFailed: (reason: string) => '无法读取生词本：' + reason,
  importFailed: (reason: string) => '导入失败：' + reason,
};

type PlainCode = {
  [K in keyof typeof defaultMessages]: typeof defaultMessages[K] extends string ? K : never;
}[keyof typeof defaultMessages];

export type Message =
  | { code: PlainCode }
  | { code: 'duplicateWord'; params: { word: string } }
  | { code: 'imported'; params: { imported: number; skipped: number } }
  | { code: 'loadFailed' | 'importFailed'; params: { reason: Message } };

export type MessageCatalog = {
  [K in keyof typeof defaultMessages]: typeof defaultMessages[K] extends string ? string : typeof defaultMessages[K];
};

export function renderMessage(catalog: MessageCatalog, message: Message): string {
  switch (message.code) {
    case 'duplicateWord': return catalog.duplicateWord(message.params);
    case 'imported': return catalog.imported(message.params);
    case 'loadFailed':
    case 'importFailed': return catalog[message.code](renderMessage(catalog, message.params.reason));
    default: return catalog[message.code];
  }
}

export class MessageError extends Error {
  constructor(readonly detail: Message, options?: ErrorOptions) {
    super(renderMessage(defaultMessages, detail), options);
    this.name = 'MessageError';
  }
}

export function errorMessage(error: unknown): Message {
  return error instanceof MessageError ? error.detail : { code: 'operationFailed' };
}
