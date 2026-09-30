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
  storageInvalidId: '词条编号无效，无法操作本地词库。',
  importEntriesInvalid: '导入的词条必须是数组。',
  operationBusy: '请等待当前保存、删除或备份操作完成。',
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
  phoneticOmitted: '部分音标过长，已完整省略；可核对来源后手动补充。',
  baiduNotConfigured: '尚未配置百度翻译，请展开百度设置，保存 APPID 和密钥。',
  baiduInvalidCredentials: 'APPID 须为 1–64 位数字，密钥须为 1–256 个字符且不含空白或控制字符。请完整填写两项。',
  baiduAuthFailed: '百度鉴权失败，请检查 APPID、密钥和通用文本翻译服务是否已开通。',
  baiduRateLimited: '百度请求过于频繁，请稍后手动重试。',
  baiduQuota: '百度账户余额或额度不足，请到百度翻译开放平台检查。',
  baiduIpBlocked: '百度限制了当前 IP，请检查 IP 白名单及同 IP 多 APPID 限制。',
  baiduUnavailable: '百度翻译暂时不可用，请检查网络、浏览器限制或服务状态。未切换其他翻译服务。',
  baiduInvalidResponse: '百度未返回可用的中文译文，可手动补充。',
  baiduTimedOut: '百度翻译等待超过 30 秒，可稍后手动重试。',
  baiduSettingsReadFailed: '无法读取本地百度配置，本页暂不使用密钥。请检查浏览器存储权限。',
  baiduSettingsInvalid: '本地百度配置格式无效，请重新填写并保存，或清除配置。',
  baiduSettingsSaved: '已保存到当前浏览器。尚未验证百度接口；请查词后检查结果。',
  baiduSettingsSaveFailed: '配置未能保存，仍使用此前生效的配置。请检查浏览器存储权限或空间。',
  baiduSettingsCleared: '已清除当前部署的百度配置。',
  baiduSettingsClearFailed: '本页已停止使用密钥，但未能清除本地存储。刷新后旧配置可能恢复，请检查浏览器存储设置。',
  baiduSettingsUpdated: '百度配置已在其他标签页更改；当前查询已取消，未保存的设置输入保持不变。',
  translationPreferenceNotSaved: '中文补全来源仅在本页生效，未能记住此选择。',
  deleted: ({ word }: { word: string }) => `已从词本删除“${word}”。`,
  duplicateWord: ({ word }: { word: string }) => `“${word}” 已在词本中，原词条已保留。`,
  imported: ({ imported, skipped }: { imported: number; skipped: number }) =>
    `已导入 ${imported} 个单词，跳过 ${skipped} 个重复词。已有内容未覆盖。`,
  loadFailed: (reason: string) => '无法读取生词本：' + reason,
  importFailed: (reason: string) => '导入失败：' + reason,
  deleteFailed: (reason: string) => '删除失败：' + reason,
};

type PlainCode = {
  [K in keyof typeof defaultMessages]: typeof defaultMessages[K] extends string ? K : never;
}[keyof typeof defaultMessages];

export type Message =
  | { code: PlainCode }
  | { code: 'duplicateWord' | 'deleted'; params: { word: string } }
  | { code: 'imported'; params: { imported: number; skipped: number } }
  | { code: 'loadFailed' | 'importFailed' | 'deleteFailed'; params: { reason: Message } };

export type MessageCatalog = {
  [K in keyof typeof defaultMessages]: typeof defaultMessages[K] extends string ? string : typeof defaultMessages[K];
};

export function renderMessage(catalog: MessageCatalog, message: Message): string {
  switch (message.code) {
    case 'duplicateWord':
    case 'deleted': return catalog[message.code](message.params);
    case 'imported': return catalog.imported(message.params);
    case 'loadFailed':
    case 'importFailed':
    case 'deleteFailed': return catalog[message.code](renderMessage(catalog, message.params.reason));
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
