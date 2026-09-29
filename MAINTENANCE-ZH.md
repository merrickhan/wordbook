# Wordbook 源码维护说明

本项目是 React / TypeScript / Vite 纯前端应用。安装、使用、备份和发布步骤见 [README-ZH.md](README-ZH.md)。

## 文件职责

| 需求 | 文件 |
| --- | --- |
| 页面、按钮、词条展示和交互 | `src/page.tsx` |
| 中英文界面文案、消息格式化与语言偏好 | `src/i18n.ts` |
| 业务消息标识、参数和错误载体 | `src/messages.ts` |
| 颜色、字体、布局与手机端样式 | `src/style.css` |
| 前端入口 | `src/main.tsx` |
| 词条类型、统一校验与 `investigation` 示例 | `src/entry.ts` |
| 浏览器直连词典／翻译接口及结果整理 | `src/vocabulary.ts` |
| IndexedDB 建库、查询、保存及事务 | `src/storage.ts` |
| JSON 备份格式、校验、导出与合并导入 | `src/backup.ts` |
| 自动化测试 | `tests/` |
| 构建和第三方声明文件输出 | `vite.config.ts` |
| Node / pnpm 版本、命令与依赖 | `package.json`、`pnpm-lock.yaml` |
| GitHub Pages 构建与部署 | `.github/workflows/deploy.yml` |

数据流：页面 → `storage.ts` → IndexedDB；查询 → `vocabulary.ts` → 第三方 API；备份 → `backup.ts` → JSON 文件／校验后事务导入。没有应用自己的 HTTP API。

## 开发与检查

改动后执行：

```sh
pnpm check
pnpm test
pnpm build
pnpm preview
```

- `check`：TypeScript 类型检查。
- `test`：通过 `tsx` 运行 `node:test`；IndexedDB 测试使用 `fake-indexeddb`，不等于在真实浏览器运行。
- `build`：生成 `dist/`，应包含静态资源及 `THIRD-PARTY-NOTICES.md`。
- `preview`：只预览已有产物，源码更新后须先构建；它不是正式部署服务。

更新依赖时用 pnpm 更新并一同提交 `package.json` 和 `pnpm-lock.yaml`；不要用其他包管理器生成额外锁文件。CI 的冻结安装失败时，应核对依赖与锁文件，而不是去掉 `--frozen-lockfile`。

## 数据约定

- 单词统一 trim、转小写并校验唯一性；列表按数据库 ID 倒序，而不是按创建时间重排。
- IndexedDB 版本为 1，数据库按 `wordbook:` 加规范化部署目录命名。更改命名、域名或路径会影响已有数据的可见性；不同库名不等于同源安全隔离。
- 备份固定使用 `format: 'wordbook'`、`version: 1`。保留七个业务字段及 UTC ISO 格式的 `created`，不导出数据库 ID；先校验整份文件，再以事务合并。已有词条优先，文件内首条重复词优先，不覆盖已有内容。
- 导入和导出都执行字段、10 MiB 大小及 10,000 条数量限制。失败不得清空原库或提交半份数据，事务提交完成后才能报告成功。
- 不增加账号、自动同步、PWA 或旧 SQLite 自动迁移的承诺。不要把用户备份、历史数据库或密钥写进源码、测试样例或发布产物。

## 界面语言与文案

- 默认 `zh-CN`，顶栏可切换 `en`；偏好安全读写到 `${databaseName(location.href)}:locale`，不改库名，不进入词条备份。读取异常或非法值回退中文，写入失败不阻止当前页面切换。
- 界面文案维护在 `i18n.ts`；业务层传递 `Message`／`MessageError`，页面保存结构化错误、通知和警告，到渲染时才格式化。新增消息同时维护两种语言及参数；未知异常使用本地化通用提示，不直接展示任意 `Error.message`。
- 只翻译操作与反馈，不改词条正文、中文释义、原始 `source` 或 UTC 时间；已知来源说明按精确值本地化，未知与旧来源保持原文，原有 HTTPS 链接白名单不变。日期和网页元信息随界面语言更新，朗读仍使用 `en-US`。
- locale 不参与数据库、focus 监听或工具注册的生命周期，也不作为组件 key；切换不清空草稿、不取消查询，按钮不受业务操作锁禁用且保留原生焦点。`modelContext` 工具元信息和 schema 不变，完成时用同步更新的 locale ref 将警告转为字符串，仅将已知 `MessageError` 转为带原始 `cause` 的可读错误，不包装未知或取消异常。

## 查询与来源约定

- 浏览器并行直连 FreeDictionaryAPI.com 和 MyMemory，两家都会收到查询词语。每路独立 30 秒超时，保留外层取消和请求代次保护；等待两路结束后返回草稿，不改为串行重试。失败时保留可编辑草稿，允许手填。
- 词典结果必须精确匹配查询词，且只采用英语条目。释义、例句、`cmn/zh` 中文译词取同一 `sense`（含子义项），不跨义项拼配；音标只取 IPA。词典中文优先，缺失时采用 MyMemory；缺失字段留空，正文最多 2,000 字符。
- 采用词典内容前校验 Wiktionary 原词条 HTTPS URL 和 CC BY-SA 4.0 许可。`source` 保持字符串：`FreeDictionaryAPI.com | Wiktionary: <原词条URL> | CC BY-SA 4.0: <许可URL> | 词典摘录，可经编辑`。仅实际采用 MyMemory 译文时追加其机器翻译署名；无内容贡献的服务不署名，两路均无有效内容则标记“手动填写”。
- 查询完成时固化出处，编辑单词不重建原始来源；保存和 JSON 备份保留 `source`。页面只链接允许的 HTTPS 来源及固定许可，旧格式按纯文本展示。许可全文保留在 `THIRD-PARTY-NOTICES.md`。
- 系统朗读取决于浏览器和设备，部分语音可能联网处理文本，不保证可用或离线。

## 验证清单

1. 自动化：字段和时间校验、唯一词约束、ID 倒序、事务回滚、查询配对／回退／取消／超时、来源保留、JSON 往返、重复项跳过、无效／超限备份拒绝。
2. 隔离浏览器：新增、刷新后持久化；导出后在另一来源导入；坏文件导入后原数据仍在；检查双语提示、来源链接及手机／平板布局。验证进行中切换不打断操作、消息按最新语言显示、偏好按部署目录恢复且存储不可用时仍能切换；核对焦点、元信息、工具注册次数及词条／备份内容不变。不要操作用户词库。
3. 网络与设备：第三方接口可达性及失败手填；系统朗读。模拟接口结果不能作为真实上游可用性证明。
4. 静态部署：根路径与仓库子路径的资源、首页链接均正确；开发、预览和正式网址的数据独立。没有 PWA，不把浏览器缓存当作离线保证。
5. 产物：第三方声明与源文件一致，不包含 `.env`、SQLite、用户备份或整个项目目录。

先构建，再分别在两个终端预览同一份产物，检查根路径与子路径：

```sh
pnpm preview --port 5198 --strictPort
pnpm preview --port 5199 --strictPort --base /wordbook/
```

如构建指定了自定义 `--outDir`，两个预览命令也必须传入同一目录；端口占用时改用空闲端口。以上是检查清单，不是已通过的结果，实际发布还须检查 Actions 和线上访问。

## 构建与发布边界

- `src/` 是维护源码，`dist/` 是可重建产物，不直接修改或提交。Vite 保持相对资源路径 `base: './'`；网页源码和前端变量不能用于保密。
- CI 冻结安装后执行检查、测试、构建，只上传 `dist/`。部署 job 依赖构建 job；默认权限为 `contents: read`，只有部署 job 增加 `pages: write` 与 `id-token: write`，使用 `pages` 并发组避免部署冲突。
- `.gitignore` 继续保护历史 `.env`、`data/`、SQLite、构建产物及默认命名的备份。它不保护手动网页上传或已被 Git 跟踪的文件；分享前仍须检查，不删除历史数据。
