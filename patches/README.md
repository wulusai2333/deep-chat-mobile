# patches/ —— 对上游源码的改动镜像

这里是**给人看的文档**，不是构建输入。真正的补丁逻辑在 `scripts/prepare-web.mjs`，
它把 `web-patches/` 下的新文件复制进 `web/src/shell/`，再对这 9 个上游文件做 14 处锚点替换。

## 为什么要有这个目录

`prepare-web.mjs` 里的替换是**代码**：锚点字符串、插入内容、校验逻辑都在里面。
读代码能知道「改了什么」，但读不出「为什么这么改」——而那些理由往往是
踩过坑之后才明白的（例如 `MODIFY_AUDIO_SETTINGS`、`await shellReady` 的冷启动竞态）。

所以每个改动在这里有一份带完整理由的说明。两处内容必须保持一致，
`scripts/verify.mjs` 的 D 组用 14 个 `mobile-shell:` 标记守住这一点：
任何人把补丁改回去，自检立刻失败。

## 14 处改动总览

| # | 上游文件 | 标记 | 说明文件 | 一句话理由 |
| --- | --- | --- | --- | --- |
| 1 | `src/index.html` | `viewport-fit` | [index.html.ts](index.html.ts) | 不加 `viewport-fit=cover`，`env(safe-area-inset-*)` 恒为 0，刘海会压住标题 |
| 2 | `src/main.tsx` | `bootstrap` | [main.tsx.ts](main.tsx.ts) | 引入壳层入口 |
| 3 | `src/main.tsx` | `await shell` | [main.tsx.ts](main.tsx.ts) | 等 Key 注入后再 render，否则 `ensureApiKey()` 误弹设置窗 |
| 4 | `src/components/settings/settingsDialogState.ts` | `onboarding owns key prompt` | [settingsDialogState.ts](settingsDialogState.ts) | 首启时引导页接管，别和设置窗抢 |
| 5 | `src/services/settings.ts` | `secure api key` | [settings.ts](settings.ts) | Key 的类型声明 + 运行时事件监听 |
| 6 | `src/services/settings.ts` | `api key initial` | [settings.ts](settings.ts) | 内存 Key 优先于 localStorage |
| 7 | `src/services/settings.ts` | `api key setter` | [settings.ts](settings.ts) | 有加密桥时只写原生，**先 return** 不落明文 |
| 8 | `src/services/chat/history/toLocal.ts` | `no toSorted` | [es2023-methods.ts](es2023-methods.ts) | ES2023 方法在老内核上是 undefined |
| 9 | `src/services/chat/store.ts` | `no toReversed` | [es2023-methods.ts](es2023-methods.ts) | 同上 |
| 10 | `src/services/chat/db.ts` | `merge staging helpers` | [db.merge.ts](db.merge.ts) | 合并导入需要 3 个暂存辅助函数 |
| 11 | `src/services/chat/backup.ts` | `export snapshot` | [backup.ts](backup.ts) | 拆出不入队的导出，供导入前自动备份复用 |
| 12 | `src/services/chat/backup.ts` | `merge import` | [backup.ts](backup.ts) | 把「替换」改成「合并」 |
| 13 | `src/components/chatInput/useVoiceInput.ts` | `mic guidance import` | [useVoiceInput.ts](useVoiceInput.ts) | 引入永久拒绝的引导 |
| 14 | `src/components/chatInput/useVoiceInput.ts` | `mic guidance` | [useVoiceInput.ts](useVoiceInput.ts) | 仅 `NotAllowedError` 时问原生，其余照旧 |

新增文件（不进上游，放在 `web/src/shell/`）见 `web-patches/`，共 10 个。

## 允许改什么、不许改什么

规格明确要求界面与桌面浏览器一致，所以改动范围是封闭的：

**允许**

- 安全区 CSS（`safe-area.css`）与 viewport meta
- API Key 的存储与注入
- 历史 ZIP 导入 / 合并
- 首次启动引导
- ES2023 方法替换（内核兼容）
- 麦克风永久拒绝时的引导

**不允许**

- 改任何布局、间距、字号、配色
- 加底部导航、抽屉、手势之类「移动化」改造
- 改上游的业务逻辑、请求协议
- 往包里塞 Key、加代理服务器

## 上游升级时怎么重放

1. 在 `web/` 里 checkout 新的上游 commit
2. 跑 `pnpm web:prepare`
3. **锚点找不到会直接报错退出**（这是故意设计的，见下）
4. 按报错逐个手工对齐，改 `prepare-web.mjs` 里的锚点字符串
5. 更新 `web-patches/` 与 `patches/` 里的说明
6. `pnpm build:web && pnpm verify && pnpm accept && pnpm test:import`

> **锚点宁可失败也不要静默跳过**
> 如果用了模糊匹配（例如只匹配 `const sorted =`），上游改了这行之后补丁会「成功」
> 但补错位置，产出一个看似正常、实际有问题的包。所以 14 处全部是
> `replaceOnce` / `insertOnce`：找不到、或找到多处，都立刻抛错。
> 升级时花十分钟对齐锚点，比发布后排查一个静默的数据丢失便宜得多。
