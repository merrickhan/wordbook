# Wordbook：纯前端生词本

基于 React 19、TypeScript 5.9 和 Vite 8 的个人生词本，可在本机预览或托管到 GitHub Pages。**没有应用后端、登录或自动同步；词条保存在当前浏览器的 IndexedDB 中，不保存在 GitHub。** Node.js 只用于开发和构建，访问已发布网页不需要安装 Node.js。

支持查询、编辑草稿、保存、朗读，以及 JSON 备份和合并导入。内置 `investigation`（调查）示例。自动查询依赖第三方接口，查询失败时仍可手动填写。

顶栏 **中文 | EN** 可即时切换界面语言，默认中文，不跟随浏览器语言。选择保存在当前浏览器的 `localStorage` 中，并按部署目录区分；刷新后恢复，存储不可用时仍可在当前页面切换。切换不会清空草稿或中断操作，只改变界面提示、日期和已知来源说明的展示；单词、中文释义等学习内容及备份中的原始来源不变，朗读仍为英语。语言偏好不包含在词条备份中，原生文件选择器等系统界面的语言由设备决定。

## 一、本机使用

推荐安装 [Node.js 24.x](https://nodejs.org/)。项目支持 Node.js 22.12 及以上的 22.x，或 24.x；使用固定版本 pnpm 11.25.0。

在项目目录的终端执行：

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev
```

打开终端显示的地址，通常为 **http://127.0.0.1:5173/**。不要直接双击 HTML 文件。按 Ctrl+C 停止开发服务；正常浏览模式下，关闭服务不会主动删除已保存的词条。

检查并预览构建结果：

```sh
pnpm check
pnpm test
pnpm build
pnpm preview
```

预览地址通常为 `http://127.0.0.1:4173/`。源码更新后须重新构建，预览不会自动使用最新源码。**开发与预览的端口不同，数据也不同**；`localhost` 和 `127.0.0.1` 同样不是同一来源。需要转移时先导出 JSON，再在目标地址导入。

## 二、发布到 GitHub Pages

项目提供 `.github/workflows/deploy.yml`，通过 GitHub Actions 构建和部署：

1. 在 GitHub 创建仓库，将项目源码和配置上传到仓库根目录，保留目录结构。必须包含 `package.json`、`pnpm-lock.yaml` 和 `.github/workflows/deploy.yml` 等构建文件。
   - 网页方式：使用 **Add file → Upload files**。如果隐藏目录未被上传，可用 **Create new file** 创建 `.github/workflows/deploy.yml`，粘贴本地同名文件的内容。
   - Git 方式：在终端将项目提交到目标仓库并推送。
   - 不要上传 `.env`、历史 `data/`、SQLite 文件、私人 JSON 备份、`node_modules/`、`dist/`，或 `.wordbook-test/`、`.playwright-mcp/` 等本地验证输出。网页上传不会自动遵守本地 `.gitignore`，请自行检查。
2. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
3. 工作流默认在推送到 `main` 时触发，也可在 **Actions → Deploy Wordbook to GitHub Pages → Run workflow** 手动运行。如果默认分支不是 `main`，请修改工作流中的 `on.push.branches`；手动运行入口要求工作流已存在于默认分支。
4. 等待依赖安装、类型检查、测试、构建及部署全部成功，再从 Pages 设置或部署环境打开实际生成的网址。若上传时尚未启用 Pages，可在启用后重新运行工作流。

CI 使用 Node.js 24 和 pnpm 11.25.0，按锁文件安装依赖，只把生成的 **`dist/`** 上传为 Pages 构建产物，不上传整个项目根目录。`dist/` 不应提交到仓库。Vite 使用相对资源路径 `base: './'`，无需根据仓库名配置路径；应用没有前端路由。上线结果以 Actions 和实际网站访问为准，本地构建成功不等于已发布。

## 三、JSON 备份与迁移

- 在页面导出 JSON，将下载文件另存到可靠位置，并保留多个日期版本。备份含私人词条，**没有加密**，不要放进公开仓库。
- 在目标浏览器或网址选择备份文件导入。导入是**合并**：保留现有词条，跳过重复词，不覆盖其内容；新词保留原 `created` 创建时间。
- 备份格式为 `{ format: 'wordbook', version: 1, exportedAt, entries }`。词条不包含数据库 ID；导入时生成新 ID。不要将任意 JSON 或旧数据库文件当作备份导入。
- 单份备份最多 **10 MiB（10,485,760 字节）和 10,000 条**。导入前会完整校验，通过后用事务提交；文件无效或事务失败不会破坏原数据。导出同样校验字段、数量和大小，不会静默截断。
- 更换设备、浏览器、域名、协议、端口或部署目录前，先在旧地址导出，再到新地址导入。不同设备访问同一个 Pages 网址，也不会共享词条。

原 SQLite 数据**不会自动迁移**。请保留历史数据及已有备份；本版不提供 SQLite 导入器，需要另行转换成受支持的 JSON 格式或手动录入。

## 四、数据与隐私边界

- 网页代码和静态资源对访问者公开，不要在前端源码或构建变量中放密码、令牌或密钥。发布到 Pages 不会把 IndexedDB 中的词条一起上传。
- IndexedDB 受浏览器同源规则约束，并按规范化部署目录使用 `wordbook:` 前缀的数据库名，减少同源不同目录的误混用。**库名不同不等于安全隔离**：同源页面脚本仍可能访问这些数据库。共享浏览器配置文件的人也可能看到词条。
- 清除网站数据、浏览器空间回收、隐私模式退出或浏览器配置文件损坏，都可能导致本地数据丢失。浏览器保存不等于备份，请定期导出。
- 查词会从浏览器并行请求 FreeDictionaryAPI.com（`freedictionaryapi.com`）和 MyMemory（`api.mymemory.translated.net`），两家都会收到查询词语。每路请求最多等待 30 秒；优先使用同一词义的词典中文译词，缺失时采用 MyMemory 机器翻译。上游失败时可手动填写，不影响已保存词条。
- FreeDictionaryAPI.com 无需密钥，受网络、跨域策略、服务额度和词条覆盖限制。数据来自 Wiktionary，采用 CC BY-SA 4.0；页面展示服务署名、原始词条和许可链接，来源信息随词条及 JSON 备份保留。编辑单词不会改写原始来源链接。再分发词典内容时须保留署名、许可及修改说明，并遵守相同方式共享等许可要求。
- 朗读使用系统／浏览器语音功能，所选语音可能联网处理文本，是否可用和是否离线取决于设备。
- 本版不是 PWA，也不保证关闭网页后能离线重新打开；没有账号、云端恢复或自动同步服务。

## 五、维护

源码职责、实现约定和检查清单见 [MAINTENANCE-ZH.md](MAINTENANCE-ZH.md)。第三方内容与依赖许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，构建时会将该声明加入 `dist/`。
