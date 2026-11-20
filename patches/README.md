# patches/ —— 对上游源码的改动镜像

这里是**给人看的文档**，不是构建输入。真正的补丁逻辑在 `scripts/prepare-web.mjs`：

- **注入**：`web-patches/*.ts` → `web/src/shell/`，`web-patches/mobile/` → `web/src/mobile/`
- **锚点补丁**：对上游文件做插入 / 精确替换，共 12 个上游文件、27 处；
  `scripts/verify.mjs` 的 D 组用 `mobile-shell:` / `mobile-ui:` 标记逐个守住，谁改回去自检立刻失败
- **整文件 fork**：组件的整文件重写放 `web-patches/mobile/overrides/`，manifest 记录上游 `sha256`
  基线，上游一变就让 `prepare` 失败（详见 [`../docs/mobile-ui-spec.md`](../docs/mobile-ui-spec.md) §1）。
  0.2.5 起 `src/services/chat/history/zipReader.ts` 也走 fork（原因见下）

## 为什么要有这个目录

`prepare-web.mjs` 里的替换是**代码**：锚点字符串、插入内容、校验逻辑都在里面。
读代码能知道「改了什么」，但读不出「为什么这么改」—— 而那些理由往往是踩过坑之后
才明白的（例如 `MODIFY_AUDIO_SETTINGS`、`await shellReady` 的冷启动竞态、
导入时 `getAll` 造成的 227 MB 堆峰值、导入慢到分钟级）。所以每个改动在这里有一份带完整理由的说明。

## 改动总览

### 壳层 / 功能（锚点补丁）

| # | 上游文件 | 标记 | 说明文件 | 一句话理由 |
| --- | --- | --- | --- | --- |
| 1 | `src/i18n/zh.ts` | `product name zh` | [app-name.ts](app-name.ts) | 侧边栏应用名：上游写「API 使用 demo」，本壳是正式客户端 |
| 2 | `src/i18n/en.ts` | `product name en` | [app-name.ts](app-name.ts) | 同上（英文串） |
| 3 | `src/index.html` | `page title` | [app-name.ts](app-name.ts) | 页面标题 / 任务切换器里显示的名字 |
| 4 | `src/index.html` | `viewport-fit` | [index.html.ts](index.html.ts) | 不加 `viewport-fit=cover`，`env(safe-area-inset-*)` 恒为 0，刘海会压住标题 |
| 5 | `src/main.tsx` | `bootstrap` | [main.tsx.ts](main.tsx.ts) | 引入壳层入口 |
| 6 | `src/main.tsx` | `await shell` | [main.tsx.ts](main.tsx.ts) | 等 Key 注入后再 render，否则 `ensureApiKey()` 误弹设置窗 |
| 7 | `src/components/settings/settingsDialogState.ts` | `onboarding owns key prompt` | [settingsDialogState.ts](settingsDialogState.ts) | 首启时引导页接管，别和设置窗抢 |
| 8 | `src/services/settings.ts` | `secure api key` | [settings.ts](settings.ts) | Key 的类型声明 + 运行时事件监听 |
| 9 | `src/services/settings.ts` | `api key initial` | [settings.ts](settings.ts) | 内存 Key 优先于 localStorage |
| 10 | `src/services/settings.ts` | `api key setter` | [settings.ts](settings.ts) | 有加密桥时只写原生，**先 return** 不落明文 |
| 11 | `src/services/chat/history/toLocal.ts` | `no toSorted` | [es2023-methods.ts](es2023-methods.ts) | ES2023 方法在老内核上是 undefined |
| 12 | `src/services/chat/store.ts` | `no toReversed` | [es2023-methods.ts](es2023-methods.ts) | 同上 |
| 13 | `src/services/chat/db.ts` | `merge staging helpers` | [db.merge.ts](db.merge.ts) | 合并导入的暂存辅助：批量写会话、定向回填 MIME、增量提交 |
| 14 | `src/services/chat/backup.ts` | `export snapshot` | [backup.ts](backup.ts) | 拆出不入队的导出，供导入前自动备份复用；会话按批读取 |
| 15 | `src/services/chat/backup.ts` | `merge import` | [backup.ts](backup.ts) | 把「替换」改成「合并」 |
| 16 | `src/components/chatInput/useVoiceInput.ts` | `mic guidance import` | [useVoiceInput.ts](useVoiceInput.ts) | 引入永久拒绝的引导 |
| 17 | `src/components/chatInput/useVoiceInput.ts` | `mic guidance` | [useVoiceInput.ts](useVoiceInput.ts) | 仅 `NotAllowedError` 时问原生，其余照旧 |

### 导入提速（0.2.5）

| # | 上游文件 | 标记 | 说明文件 | 一句话理由 |
| --- | --- | --- | --- | --- |
| 18 | `src/services/chat/store.ts` | `replace history commit` | [import-speed.md](import-speed.md) | `replaceHistory` 增加可选提交函数，合并导入用「增量提交」 |
| 19 | `src/services/chat/store.ts` | `replace history commit call` | 同上 | 默认参数保持上游覆盖语义，所有上游调用点不受影响 |
| 20 | `src/components/settings/SettingsDialog.tsx` | `import backup pref` | [import-speed.md](import-speed.md) | 引入「导入前自动备份」开关 |
| 21 | `src/components/settings/SettingsDialog.tsx` | `import confirm body` | [import-speed.md](import-speed.md) | 手机端是合并语义，不能照抄上游的「覆盖」说明；顺带给备份开关 |
| 22 | `src/components/settings/SettingsDialog.tsx` | `import cell description` | [import-speed.md](import-speed.md) | 设置页的导入说明同样只在原生壳里改成合并 |

> **`src/services/chat/history/zipReader.ts` 改成整文件 fork**（`web-patches/mobile/overrides/history/zipReader.ts`）。
> 0.2.4 用三段小补丁给它加「缓存目录 / 统计条目数」，0.2.5 要改成「中央目录一次读完、
> 每条目头一次读完、暴露 CRC 与裸跳过」，改动面已经超过小补丁能维护的范围。
> manifest 记录上游基线 `sha256`，上游一动 `prepare` 直接失败，详见
> `web-patches/mobile/manifests/history.json`。

### 导出落盘（0.2.4）

| # | 上游文件 | 标记 | 说明文件 | 一句话理由 |
| --- | --- | --- | --- | --- |
| 23 | `src/components/settings/SettingsDialog.tsx` | `device export import` | [export.ts](export.ts) | 引入「是否原生壳」与「原生导出」两个入口 |
| 24 | `src/components/settings/SettingsDialog.tsx` | `device export body` | [export.ts](export.ts) | WebView 没有 DownloadListener，`<a download>` 静默无效：改走分块原生写 Documents + 进度/结果浮层 |

> 该补丁新增三个壳层文件：`native-backup.ts`（分块保存，导入前备份也复用它）、
> `export-bridge.ts`（导出编排与失败重试）、`export-ui.ts`（进度 / 成功路径 / 失败原因）。
> 0.2.5 起 `native-backup.ts` 的分块上限从 256 KB 提到 1 MB，并且让出主线程改用
> `MessageChannel`（后台时 `setTimeout` 会被 WebView 钳到 1 秒）。

### 移动端 UI 覆盖层

移动端按官方 Android App 重做（见 [`../docs/mobile-ui-spec.md`](../docs/mobile-ui-spec.md)）。
除整文件 fork 的组件外，还有 3 个 `mobile-ui:` 锚点补丁：

| # | 上游文件 | 标记 | 说明 |
| --- | --- | --- | --- |
| 25 | `src/i18n/zh.ts` | `mobile strings zh` | 欢迎语、按住说话、拍照/相册/文件、搜索对话内容、导入备份开关等文案 |
| 26 | `src/i18n/en.ts` | `mobile strings en` | 英文对应文案 |
| 27 | `src/main.tsx` | `mobile css` | 在 `global.css` 之后引入移动端 token / 样式 |

新增文件（不进上游）见 `web-patches/`：壳层文件注入到 `web/src/shell/`，移动端覆盖层
注入到 `web/src/mobile/`。桌面端分支保持上游原样；所有手机端专属行为都在
`isNativeShell()` 为真时才生效。

## 允许改什么、不许改什么

**允许**

- 安全区 CSS（`safe-area.css`）与 viewport meta
- API Key 的存储与注入
- 历史 ZIP 导入 / 合并 / 导入性能与内存
- 历史导出落盘与进度提示（仅原生壳；浏览器保持上游下载）
- 首次启动引导
- ES2023 方法替换（内核兼容）
- 麦克风永久拒绝时的引导
- 移动端 UI 覆盖层（按官方 App；只影响 `isMobile` 分支）

**不允许**

- 改桌面端布局、间距、字号、配色
- 改上游的业务逻辑、请求协议
- 往包里塞 Key、加代理服务器、加遥测
- 把个人数据（截图 / 会话 ZIP / APK / 日志）或私钥以外的敏感信息提交进仓库

## 上游升级时怎么重放

1. 在 `web/` 里 checkout 新的上游 commit
2. 跑 `pnpm web:prepare`
3. **锚点找不到会直接报错退出**（这是故意设计的，见下）
4. 按报错逐个手工对齐，改 `prepare-web.mjs` 里的锚点字符串
5. **fork 的上游基线变了同样会报错**：人工确认 fork 是否仍适用，再更新
   `web-patches/mobile/manifests/*.json` 里的 `upstreamSha256`（`node scripts/mobile-forks.mjs hash <路径>`）
6. 更新 `web-patches/` 与 `patches/` 里的说明
7. `pnpm build:web && pnpm verify && pnpm accept && pnpm test:import`

> **锚点宁可失败也不要静默跳过**
> 如果用了模糊匹配（例如只匹配 `const sorted =`），上游改了这行之后补丁会「成功」
> 但补错位置，产出一个看似正常、实际有问题的包。所以所有补丁点都走
> `replaceOnce` / `insertOnce` / `upsertBlock`：找不到、或找到多处，都立刻抛错。
> 升级时花十分钟对齐锚点，比发布后排查一个静默的数据丢失便宜得多。
