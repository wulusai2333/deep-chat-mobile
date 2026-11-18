# 移动端 UI 对齐官方 App —— 实施规格

> 状态：**已完成**（随 0.2.0 发布）。本文件是这次移动端改版的**唯一口径**：视觉、文件所有权、i18n 键、验收标准都在这里。
> 与官方 App 的**已知差异**见文末 §7（都是有意取舍，不是漏做）。
> 参考图：`UI参考图 不允许添加到git/`（4 张官方 App 截图，**不得入库**）。

---

## 0. 背景与范围

此前项目原则是「手机端界面与桌面浏览器一致」，所以移动端只是把桌面 UI 塞进窄屏。
用户要求改为：**移动端按官方 DeepSeek App 的样子做**，桌面端**保持现状不动**。

这次做这几屏（都来自参考图）：

1. 欢迎页（新对话，空态）——参考图 1
2. 输入框「+」附件面板 ——参考图 2
3. 语音输入（按住说话）——参考图 3
4. 抽屉（会话列表 + 搜索 + 底部账户行）——参考图 4
5. 会话内聊天页的顶栏与输入框：与上面同一套风格

**不改**：设置页（下一轮）、消息气泡与 Markdown 渲染、桌面端任何布局。

---

## 1. 架构：移动端覆盖层（mobile overlay）

`web/` 是上游 `deepseek-ai/chat-demo` 的只读 vendored clone，构建前由
`scripts/prepare-web.mjs` 重建。**所有我们的代码只能放在 `web-patches/` 下**，绝不在 `web/src/`
里手改（会被覆盖）。

本次新增三类补丁（都由 prepare-web.mjs 重放）：

### 1.1 注入（inject）

`web-patches/mobile/` 下除 `manifests/`、`overrides/` 之外的所有文件，整体拷贝到 `web/src/mobile/`。
导入路径示例：`../../mobile/chatinput/MobileChatInput.js`。

### 1.2 覆盖（override / fork）

上游文件需要整文件改写的，放 `web-patches/mobile/overrides/<path>`，
并在 `web-patches/mobile/manifests/<area>.json` 登记：

```json
{
  "overrides": [
    {
      "to": "src/components/session/Welcome.tsx",
      "from": "overrides/session/Welcome.tsx",
      "upstreamSha256": "<上游该文件在 PINNED_COMMIT 的 sha256（归一化 CRLF 后）>"
    }
  ]
}
```

prepare-web 的规则：

- 目标文件内容 == fork 内容 → 跳过（幂等）
- 目标文件内容 == manifest 记录的上游内容 → 写入 fork
- 目标文件是「上一版 fork」或有人手改过 → 直接覆盖为最新 fork 并打印提示
  （`web/` 是生成物，覆盖是正确语义；上游漂移由 `upstreamSha256` 拦截）

取 `upstreamSha256`：`node scripts/mobile-forks.mjs hash <to-path>`。

**fork 的文件里必须保留「桌面端原有分支的行为」**，只在 `isMobile` 分支写新 UI；
除了我们自己新增的 import / 组件，桌面代码一字不改。

### 1.3 小补丁（replace/insert）

i18n 文案、`main.tsx` 引入 mobile.css 这类小改动，继续用 prepare-web 里现有的
`replaceOnce` / `insertOnce`（带 `mobile-shell:` 标记）。

### 1.4 文件所有权（并行开发，别越界）

| 归属 | 文件 |
| --- | --- |
| Lead | `scripts/prepare-web.mjs`、`scripts/mobile-forks.mjs`、`scripts/ui-preview.mjs`、`docs/*`、`web-patches/mobile/common/*`、`web-patches/mobile/overrides/app/*`、`web-patches/mobile/manifests/app.json`、i18n 补丁 |
| teammate-topbar | `web-patches/mobile/overrides/session/*`、`web-patches/mobile/topbar/*`、`web-patches/mobile/manifests/session.json` |
| teammate-composer | `web-patches/mobile/chatinput/*`、`web-patches/mobile/manifests/chatinput.json` |
| teammate-drawer | `web-patches/mobile/overrides/sider/*`、`web-patches/mobile/drawer/*`、`web-patches/mobile/manifests/drawer.json` |

跨模块接口（已由 Lead 建 stub，替换实现时**保持导出签名不变**）：

- `src/mobile/chatinput/MobileChatInput.tsx` → `export const MobileChatInput = ({ sessionId }: { sessionId: string | null })`
- `src/mobile/drawer/MobileDrawer.tsx` → `export const MobileDrawer = ()`
- `src/mobile/topbar/MobileTopBar.tsx` → `export const MobileTopBar = ({ title, session }: { title?: string; session?: Session })`
- `src/mobile/common/icons.tsx` / `src/mobile/common/logo.tsx`（Lead 维护，可提需求但别改）
- `src/mobile/common/mobile.css`（Lead 维护，tokens 只加不改名）

---

## 2. 视觉规范

按官方截图（参考图 1316px 宽，约 393–460 CSS px 设备）换算。以下数值以 **393px 视口** 为准。
颜色以官方品牌蓝为准：`#4D6BFE`。

### 2.1 tokens（写在 `mobile/common/mobile.css`）

```
--m-brand: #4d6bfe
--m-brand-weak: rgba(77, 107, 254, 0.10)   /* 药丸底 */
--m-brand-weak-press: rgba(77, 107, 254, 0.18)
--m-text: #1a1a1a
--m-text-secondary: #8a8f99
--m-text-placeholder: #b0b4bd
--m-line: rgba(0, 0, 0, 0.06)
--m-composer-bg: #ffffff
--m-composer-shadow: 0 2px 16px rgba(0, 0, 0, 0.08)
--m-fill: #f5f6f7          /* 附件按钮底 */
--m-fill-strong: #f2f3f5   /* 搜索框底 */
--m-drawer-width: 84vw   /* 抽屉约占 84% 宽，右侧露出一条主界面（官方实测 330/393） */
```

深色主题用 `body[data-ds-dark-theme]` 覆盖同名 token（composer 底用 `#2a2a2e`、文字 `#e8e8ea`、
填充 `#333338` 之类，别用纯黑）。

### 2.2 顶栏（欢迎页 & 会话页）

> 尺寸按官方截图反推（1316px 宽截图 → 393 CSS 视口，缩放系数 0.2986）。
> 已和 teammate-topbar 的独立测量交叉核对过。

- 高度 **60px**（+ 安全区），左右 padding **14px**，背景透明/页面底色，无边框。
- 左：汉堡 **24px**，两根线（上 18×2、下 10×2，圆角，间距 6px），颜色 `--m-text`，
  墨迹起点距左约 16.7px。aria-label 用现有 `t('expandSiderbarButton')`。
- 右（从右到左）：`⊕` 新建对话 **24px**（`t('newChat')`，圆形描边直径约 18.5，用 MIconPlusCircle 默认 24）、
  `🔊` 朗读 **24px**（`t('ttsPlay')`），两个图标盒间距约 **24px**（官方图标墨迹之间的空隙确实很宽）。
  - 朗读：朗读**当前会话最后一条 assistant 且正文非空**的消息（`toggleReadAloud`）；
    正在朗读时图标换成 `ReadingBars`/停止样式，再次点击停止；没有可读内容时按钮 `disabled`
    （欢迎页就是 disabled 但**要显示**）。
  - `⊕` → `newChat()`。
- 会话页：中间标题 16px/500，单行省略，左右各留 12px；欢迎页没有标题。

### 2.3 欢迎页

- 垂直居中偏上（中心大约在内容区 42% 高度，用 flex + padding-bottom 微调，可复用官方比例）。
- 鲸鱼 logo（`<WhaleLogo/>`，官方 DeepSeek 鲸鱼，纯色 `--m-brand`）**42×42**，下间距 **20px**。
  （官方墨迹 40.9×31.1 CSS px；WhaleLogo 的墨迹几乎铺满 viewBox，所以框取 42。
  之前 spec 写的 56 偏大，已按实测修正。）
- 问候语：`t('welcomeBackGreeting')`，**22px / 600**，颜色 `--m-text`，居中。
- 垂直位置：logo 墨迹中心约在屏幕高度 **44–45%**（比正中略高），问候语墨迹中心约 50%。
- 不要 `contentCaveat`（「内容由 AI 生成…」在移动端隐藏）。
- 底部是输入框（2.4）。

### 2.4 输入框（普通态）

结构（自上而下）：

```
[草稿附件行（有附件时才显示，复用 DraftAttachments）]
[textarea：placeholder = t('chatInputPlaceholderMobile')]
[控制行：深度思考 智能搜索 ……… ( + ) ( 麦克风 )]
```

- 外框：左右 margin **10px**，底部 margin **10px**；圆角 **26px**；白底；`--m-composer-shadow`；
  1px `--m-line` 描边（截图里很淡）。实测整卡高约 **115px**、宽 373px（393 视口）。
- textarea：`padding: 14px 18px 4px`；`font-size: 17px`；`line-height: 24px`；`min-height: 48px`；
  placeholder 颜色 `--m-text-placeholder`；行高最少 1 行、最多约 5 行（保持上游的 mirror 自适应逻辑）。
- 控制行：`padding: 0 14px 12px`；高 **40px**；`display:flex; align-items:center`。
- 药丸（深度思考/智能搜索）：高 **30px**；左右 padding **12px**；圆角 999；字号 **14px / 500**；
  图标 16px；间距 5px；两药丸间距 **9px**；药丸左边缘距卡片左约 14px。
  - 未开启：底色 `--m-brand-weak`，文字/图标 `--m-brand`（和截图一致）
  - 已开启：底色 `--m-brand`，文字/图标白色（明确的「开」状态）
- 右侧按钮：
  - 空文本时：`+` 圆钮 **24px**（1.5px 实线描边 `--m-text`，透明底，图标 14px），
    麦克风圆钮 **24px**，两圆之间约 **18px**（官方实测墨迹直径 23.6px、边缘间距 19.4px）。
    - `+` → 打开/关闭附件面板（2.5），aria-label `t('addAttachment')`
    - 麦克风 → 进入按住说话模式（2.6），aria-label `t('voiceInput')`
  - 有文本时：只显示发送圆钮 **24px**（`--m-brand` 底、白色 ↑）；aria-label `t('send')`。
    流式生成中显示停止圆钮（`--m-brand` 底、白色方块），aria-label `t('chatInputStopButtonTooltip')`。
- 发送/停止/上传/失败重试等**行为逻辑**沿用上游 `ChatInput.tsx`：草稿、上传、`prepareDraftMessage`、
  `ensureApiKey`、`sendMessage`、`stopReply`、`importingHistory` 禁用、Enter 发送。别自己另写一套。

### 2.5 附件面板（点 `+`）

面板在输入框**下方**（输入框被顶上去，页面其它内容自然上移）：

- 最近图片行：横向滚动，`gap 8px`，缩略图 **78×78**、圆角 12px；右上角选择圈 **22px**
  （未选：白描边 + 半透明深色底；已选：`--m-brand` 底 + 白勾）。
  - 数据来源：**本地历史对话里的图片附件**（从最近的会话往前收集，最多 12 张，用 `loadFile(id)` 取 blob 做 URL）。
    点选 = 把该图片加进草稿附件并关闭面板（走 `addDraftFiles`）。
  - 没有历史图片时整行不渲染。
- 三个操作块：等宽 3 列（393 视口下每块约 113px 宽），间距 **8px**；高 **82px**；圆角 16px；
  底色 **#f5f5f5**（`--m-fill`）；图标 26px 在上、文字 15px 在下；左右留白约 10px。
  1. `t('camera')` 拍照 → 隐藏 `<input type=file accept="image/*" capture="environment">`
  2. `t('album')` 相册 → `<input type=file accept="image/*" multiple>`
  3. `t('fileAttachment')` 文件 → 现有 `ACCEPT` + `multiple`（和桌面同一个上传通路）
- 面板打开时右侧按钮变：`×` 关闭面板（aria-label `t('close')`），麦克风仍在（进入语音模式）。
- 点空白处 / 点 `×` / 选完文件后关闭面板。
- 面板整体底部留安全区 padding。

### 2.6 语音输入（点麦克风）

- 输入框第 1 行换成「按住说话」大区：
  - 高 **56px**，文字 `t('holdToTalk')` **17px / 500**，居中；下方一条 1px 分隔线（`--m-line`，贯穿卡片）
  - 录音中：文字换成 `t('releaseToSend')`，并显示已录秒数（复用 `useVoiceInput` 的 `seconds`）；
    转写中显示 `t('voiceTranscribing')`
- 控制行不变（药丸仍在左边），右侧按钮变成：`×`（退出语音模式，aria-label `t('close')`）+ 键盘图标
  （切回文字输入并 focus textarea，aria-label `t('voiceInputKeyboard')`）。
- 交互：`touchstart/mousedown` 开始录音，`touchend/mouseup/touchcancel` 结束并转写；
  录音时长 < 0.6s 时提示 `t('voiceTooShort')` 并取消。
- 转写结果通过 `useVoiceInput(onText)` 写回草稿，并**退出语音模式**、focus textarea。
- 权限失败：沿用 `useVoiceInput` 现成的 toast + `guideBlockedMic` 原生引导，不要再造一套。

### 2.7 抽屉

- 打开时**主界面整体右移**，露出抽屉宽度 `--m-drawer-width = 84vw`（官方实测 330/393；
  右侧还能看到主界面的汉堡和输入框左边缘）。用 transform 过渡 300ms，主界面**不再叠蒙层**。
  - Lead 在 `overrides/app/App.tsx` 里做：`isMobile && siderOpen` 时给 `<main>` 加 `styles.mainPushed`；
    抽屉打开时点主界面任意位置 = 关闭抽屉（capture 阶段拦截）。
- 抽屉面板：左侧、满高；白底；右侧轻微阴影；右缘圆角 16px（可选）；顶部留安全区。
- 内容 padding **16px**：
  1. 搜索框：高 **44px**、圆角 999、底色 `--m-fill-strong`；左侧放大镜 18px；
     placeholder `t('searchConversations')`，字号 15px；有内容时右侧出现清除按钮（`t('clearSearch')`）。
  2. 分组列表：沿用 `groupSessions()` 的分组标题（今天/昨天/7 天内/30 天内）；
     标题 15px、颜色 `--m-text-secondary`、padding `12px 4px 6px`、吸顶。
  3. 会话行：高 **47px**，字号 16px，单行省略，颜色 `--m-text`；当前会话用 `--m-brand` 文字 + 浅蓝底。
     点击 = `selectSession(id)` + `closeMobileSider()`。
     **长按 500ms** 弹菜单：重命名 / 删除（复用 `Menu`、`renameSession`、`removeSession`，
     删除确认弹窗逻辑照抄 `Sider.tsx`）。按压缩放反馈要有（`active` 时背景 `--m-fill`）。
  4. 搜索行为：输入 ≥ 1 字后，**同时**搜标题和消息正文；250ms 防抖；搜索中显示 `t('searching')`；
     结果为空显示 `t('searchNoResults')`；点结果 = 打开该会话并关抽屉。
     - 标题匹配立即出结果；正文匹配异步扫描（按会话摘要从新到旧，未加载的用 `db.loadSession`，
       最多扫 200 条会话 / 最多 50 条结果，可取消）。
     - 搜索态下不显示分组标题，平铺结果。
  5. 底部账户行（固定底、高 64px + 安全区）：
     - 左：圆形头像 32px（默认 **App 图标**，`<img data-avatar="local">` 圆形裁切；
       点头像 = 系统选图，压成 256×256 JPEG 存 `localStorage`，可恢复默认）。
       头像不进导出的历史 ZIP（属于本机外观偏好）。
     - 中：`t('localAccountName')`，16px
     - 右：`…` 按钮 → `Menu`：`t('changeAvatar')` / 已自选时多一项 `t('resetAvatar')`、
       `t('settings')`（`openSettings('general')`）、
       `t('theme')`（在 浅色/深色/跟随系统 间切换，复用 `setThemePreference`）
     - 点击账户行本身 = 打开设置。

### 2.8 动画

- 抽屉：`transform` 300ms `cubic-bezier(0.4, 0, 0.2, 1)`
- 附件面板 / 语音模式切换：高度或透明度 180–220ms，别闪
- 按钮按压：`transform: scale(0.96)` 或底色变化

---

## 3. i18n 键（Lead 已加到 zh.ts / en.ts）

新增键（`t('key')` 直接用，别写死中文）：

| key | zh | en |
| --- | --- | --- |
| `welcomeBackGreeting` | 欢迎回来，想从哪里开始？ | Welcome back. Where shall we start? |
| `chatInputPlaceholderMobile` | 发消息或按住说话 | Message or hold to talk |
| `addAttachment` | 添加附件 | Add attachment |
| `camera` | 拍照 | Camera |
| `album` | 相册 | Photos |
| `fileAttachment` | 文件 | Files |
| `holdToTalk` | 按住说话 | Hold to talk |
| `releaseToSend` | 松开发送，上滑取消 | Release to send |
| `voiceTranscribing` | 正在转写… | Transcribing… |
| `voiceTooShort` | 说话时间太短 | Too short, try again |
| `voiceInputKeyboard` | 键盘输入 | Keyboard |
| `searchConversations` | 搜索对话内容… | Search chats… |
| `searching` | 搜索中… | Searching… |
| `searchNoResults` | 未找到相关对话 | No matching chats |
| `clearSearch` | 清除 | Clear |
| `localAccountName` | 本地用户 | Local user |
| `theme` | 主题 | Theme |
| `changeAvatar` | 更换头像 | Change avatar |
| `resetAvatar` | 恢复默认头像 | Reset avatar |
| `avatarUpdated` | 头像已更新 | Avatar updated |
| `avatarReset` | 已恢复默认头像 | Avatar reset to default |
| `avatarReadFailed` | 图片读取失败，请换一张 | Could not read the image, try another |

已有键直接用：`thinkingSwitch`、`search`、`send`、`chatInputStopButtonTooltip`、`voiceInput`、
`close`、`more`、`newChat`、`expandSiderbarButton`、`ttsPlay`、`ttsStop`、`settings`、
`untitledChat`、`sessionItemMenuRenameOption`、`delete`。

---

## 4. 可复用 API（别重复实现）

- 草稿：`services/chat/drafts.ts`（`useDrafts` / `setDraftText` / `addDraftFiles` /
  `removeDraftAttachment` / `retryDraftAttachment` / `prepareDraftMessage`）
- 发送/停止/会话：`services/chat/store.ts`（`sendMessage` / `stopReply` / `newChat` /
  `selectSession` / `renameSession` / `removeSession` / `useChatStore`）
- 上传：`services/attachments.ts`（`ACCEPT`、`useUploads`、`validateFiles`…）
- 语音：`components/chatInput/useVoiceInput.ts`（`toggle` / `cancel` / `status` / `seconds` / `available`）
- 朗读：`services/speech/readAloud.ts`（`toggleReadAloud` / `stopReadAloud` / `useReadAloud` /
  `describeReadAloudError`）+ `components/messages/ReadingBars`
- 历史图片：`services/chat/db.ts`（`loadSessionSummaries` / `loadSession` / `loadFile`）
- 组件：`components/base/IconButton`、`Button`、`Menu`、`Modal`、`Tooltip`、`Toast`
- 桌面输入框里还有可参考的逻辑：`components/chatInput/ChatInput.tsx`（**只能抄逻辑，不要改它**）

---

## 5. 工作流

```powershell
# 一次构建 + 多状态截图（自带构建锁，可多人同时跑）
node scripts/ui-preview.mjs
# 产物：.tmp/ui-preview/latest/*.png（mobile-welcome / mobile-drawer / mobile-attach /
#       mobile-voice / mobile-typed / desktop-welcome）
```

- 改完代码**必须**跑一次 ui-preview 看截图，与 `UI参考图 不允许添加到git/` 里的对应截图肉眼对比。
- 需要临时数据（历史图片行/会话列表）时，在 ui-preview 里注 localStorage / 往 IndexedDB 塞假数据，
  不要写进产品代码。
- 构建若报 `找不到待替换原文` / fork 校验失败：先跑 `node scripts/mobile-forks.mjs check`，
  看是哪个文件，再决定更新 fork 还是修补丁。

## 6. 验收标准（完成定义）

1. `pnpm web:prepare && pnpm build:web` 通过；`node scripts/ui-preview.mjs` 截图与参考图结构一致：
   - 欢迎页：顶栏左汉堡 / 右喇叭+⊕、中间鲸鱼 logo + 问候语、底部圆角输入框 + 两药丸 + ⊕ + 麦克风
   - 附件面板：最近图片行（有历史图片时）+ 拍照/相册/文件 三块，⊕ 变 ×
   - 语音：按住说话大区 + 分隔线 + 药丸 + ×/键盘
   - 抽屉：主界面右移、搜索框、分组列表、底部账户行
   - 会话页：顶栏标题 + 同样的输入框
2. 桌面端（1280px 宽）截图与改版前一致（ui-preview 里 `desktop-welcome.png` 对比）。
3. 功能可用：发送、停止、上传、拍照/相册/文件、按住说话转写、朗读、抽屉搜索、新建/切换/重命名/删除会话。
4. `pnpm verify`、`pnpm accept`、`pnpm test:import` 全绿（Lead 会同步更新验收项）。
5. 深浅色都正常。


---

## 7. 与官方 App 的已知差异（有意取舍）

1. **附件面板的「最近图片」来自本机历史对话的图片附件**，不是系统相册。WebView 没有读取相册的通道
   （需要额外的原生相册插件与权限），用历史图片既满足「点一张图发出去」的用法，又不新增敏感权限。
2. **抽屉分组标题右侧的「排序/多选」小图标未实现**：截图里有，但语义不明确（排序？批量管理？），
   宁缺勿假——做一个猜的功能比不做更容易误导。
3. **顶部「朗读」读的是当前会话最后一条有正文的回答**（官方语义未公开，按最自然的理解实现）；
   欢迎页/空会话时按钮显示但 disabled。朗读中（loading/playing）喇叭保持可见并变成品牌蓝
   （`--m-brand` / `#4d6bfe`，与官方 App 一致），再点同一个按钮即停止；按钮同时暴露
   `aria-pressed` / `data-reading` 与「停止朗读」的 aria-label，空闲时是普通深色喇叭。
4. **浏览器截图没有手机状态栏**，与官方截图像素对齐时整页内容会高约 38px；按「App 内相对坐标」
   （顶栏图标位置、卡片高度、字号）与官方数值吻合。
5. 官方「按住说话」录音时是否会先出转写中间态、上滑取消的阈值等细节无法从静态截图确认，
   按常见语音输入交互实现（<0.6s 提示太短、上滑 60px 取消）。
