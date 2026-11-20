# Deep Chat 手机端（deep-chat-mobile）

把上游 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的纯静态前端封装成
**Android APK** 的个人项目：Capacitor 8 壳 + 三个原生插件 + 一层按官方 App 重做的移动端 UI。
目标是**个人自用、侧载安装**；开发和实测主要在鸿蒙 4.3（Android 兼容层）的华为手机上完成。

> **非官方项目**：与 DeepSeek 官方无任何关联，也不代表其立场。仓库内不包含上游源码副本，
> 只包含补丁、壳层代码、原生插件、脚本与文档；所有上游许可与署名见文末「许可」。
>
> **使用前请先读 [免责声明](#免责声明)**。API Key 需要你自己准备，费用与额度由上游服务决定。

当前版本 **0.2.4**。0.2.4 本地验证结果：`pnpm verify` 111/111、`pnpm accept` 50/50、
`pnpm test:import` 45/45、TypeScript 0 错误（数字随版本变化，以脚本实际输出为准）。

---

## 目录

- [这是什么 / 不是什么](#这是什么--不是什么)
- [支持的设备与系统（大致范围）](#支持的设备与系统大致范围)
- [功能](#功能)
- [安装（使用者）](#安装使用者)
- [从源码构建](#从源码构建)
- [架构](#架构)
- [对上游的改动](#对上游的改动三种形态全部可重放)
- [签名与升级](#签名与升级重要)
- [隐私与数据](#隐私与数据)
- [备份、导出与换机](#备份导出与换机)
- [常见问题（FAQ）](#常见问题faq)
- [已知限制](#已知限制)
- [免责声明](#免责声明)
- [许可](#许可)
- [目录结构](#目录结构)
- [文档索引](#文档索引)

---

## 这是什么 / 不是什么

**是**：一个可以直接装在 Android 手机上的「DeepSeek 对话客户端」——前端与交互来自上游
chat-demo，本项目补上了移动端 UI、本地会话存储、API Key 加密、历史归档导入、朗读等能力，
并用 Capacitor 打包成可侧载的 APK。

这是一个**免费、非商业的公益项目**：不收费、无广告、无捐赠入口、不收集数据；API Key 和
由此产生的上游费用完全由使用者自己承担。

**不是**：

- 不是 DeepSeek 官方客户端，不代表官方立场，也没有官方支持；
- 不是云服务：没有后端、没有账号体系、不同步聊天记录（跨设备靠手动导出/导入 ZIP）；
- 不是「免费 API」：仍然使用你自己的 API Key，按上游的计费规则扣费；
- 不是应用商店版本：需要侧载，没有自动更新，升级靠手动安装新 APK。

---

## 支持的设备与系统（大致范围）

一句话：**主要面向 Android 7.0 以上、竖屏使用、系统 WebView 内核 ≥ Chromium 105 的安卓手机**，
包含鸿蒙 4.x 的内置 Android 兼容层；鸿蒙 NEXT（5.0+）和 iPhone 不支持 APK。

| 设备 / 系统 | 大致范围 | 状态 |
| --- | --- | --- |
| Android 手机 | Android 8.0 – 16（API 26–36） | ✅ 目标形态（竖屏手机） |
| Android 7.0 – 7.1 | API 24–25 | ⚠️ 理论可用；要求系统 WebView 能升级到 Chromium 105+，未实测 |
| Android 6.0 及以下 | API ≤ 23 | ❌ 不支持（`minSdk 24`） |
| 鸿蒙 HarmonyOS 4.x | 4.0–4.3，Android 兼容层（约 API 30–31） | ✅ 4.3 实测可用（Mate 70 Pro+）；4.0–4.2 理论可用，未实测 |
| 鸿蒙 HarmonyOS NEXT 5.0+ | 已移除 Android 兼容层 | ❌ APK 装不上；只能用 PWA（能力有降级） |
| 平板 / 折叠屏展开 / 横屏手机 | 视口宽度 ≥ 768px | ⚠️ 会切到**桌面布局**；功能可用，但不是本项目的目标形态 |
| Android 模拟器 | x86_64，WebView ≥ 105 | ✅ 可安装调试 |
| iPhone / iPad | 无 iOS 工程 | ❌ 不支持 |
| Windows / macOS | 仅 PWA 兜底 | ⚠️ 降级使用（无加密 Key、无系统备份写入） |

**硬件与基础环境（经验值，不是硬性保证）**

| 项目 | 建议 | 说明 |
| --- | --- | --- |
| CPU 架构 | arm64-v8a / armeabi-v7a / x86_64 均可 | APK **不含任何原生 `.so`**，是通用包；WebView 由系统提供 |
| 运行内存 | 2 GB 可运行，**3 GB+ 推荐**，4 GB+ 导大归档更稳 | 导入历史时前端会有短时较高的内存占用（见 `docs/import-performance.md`） |
| 可用存储 | 建议预留 **300 MB 以上**，最好 1 GB | 导入 30 MB 的归档会生成约等体积的备份 ZIP，并把会话/图片解到本机 |
| 屏幕 | 竖屏手机，最小宽度约 320px | 已适配刘海/手势条安全区；平板宽度会走桌面布局 |
| 系统依赖 | 系统 WebView / Chrome **≥ Chromium 105** | 低于 105 会白屏或被 Capacitor 提示升级；不需要 Google 服务（GMS/Play） |
| 网络 | 能访问你配置的 API 地址（默认 `https://api.deepseek.com`） | 无离线模式；朗读、对话都依赖网络 |

> **鸿蒙 4.3 上已验证**：侧载、首启输入 Key、聊天、导入历史、朗读、换头像均可用
> （详细步骤见 [docs/install-harmony.md](docs/install-harmony.md)）。
> 其他机型没有逐台验证过；如果你的设备不在上表或遇到问题，欢迎在 Issues 反馈型号与系统版本。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 移动端 UI 对齐官方 App | 欢迎页（鲸鱼 logo + 问候语）、顶栏（汉堡 / 朗读 / 新建对话）、圆角输入框 + 深度思考/智能搜索药丸、`+` 附件面板（拍照 / 相册 / 文件 / 最近图片）、按住说话、抽屉（搜索 + 分组列表 + 底部账户行，头像默认 App 图标、可换成自己的图）。桌面端保持上游原样 |
| 上游聊天能力完整保留 | 流式回复、深度思考、联网搜索、网页读取、附件上传、Markdown / 代码高亮 / KaTeX / Mermaid、分支切换、重新生成 |
| 本地会话 | 会话、消息与附件原件都在本机 IndexedDB，无后端，不需要账号 |
| API Key 加密存储 | `EncryptedSharedPreferences` + Android Keystore（AES-256-GCM），Key 不落 localStorage / IndexedDB 明文；首启引导会先验证 Key 再进主界面 |
| 历史 ZIP **合并**导入 | 导入前自动备份当前全部会话；同 id 取 `updatedAt` 较新者、不同 id 追加，**不覆盖本机**；重复导入幂等；支持应用内选择文件与「用其他应用打开 ZIP」两条入口 |
| 历史导出**落盘 + 进度** | 应用内导出写入 `Documents/DeepChat/deep-chat-export-<时间>.zip`（与导入备份同目录）；导出时显示**阶段进度**，完成后显示完整路径，失败显示原因并可**原地重试**（0.2.4 修复了此前 Android WebView 下导出静默无效的问题） |
| 朗读 | 顶栏喇叭朗读当前会话最后一条有正文的回答；朗读中喇叭**变为品牌蓝**（`aria-pressed`/`data-reading` 可测），再点一次停止 |
| API 余额 | 抽屉账户行显示当前 API Key 的余额：打开抽屉自动查询（60s 内不重复），点余额可手动刷新；支持多币种，Key 无效 / 网络异常 / 余额不足都有明确提示。余额只存在内存，不落盘、不进导出的历史 ZIP |
| 深色模式 | 跟随系统 / 手动切换，移动端组件有自己的浅色与深色 token |
| 安全区与中文输入法 | `viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海与手势条；`captureInput: false` 保证拼音组合输入正常 |
| PWA 兜底 | 同一份 `dist/` 可打成可直接部署的 PWA（鸿蒙 NEXT 用户的过渡方案，能力有降级） |

---

## 安装（使用者）

> 本仓库**不提交 APK**（二进制产物在 `.gitignore` 里）。请从
> [**GitHub Releases**](https://github.com/wulusai2333/deep-chat-mobile/releases) 下载
> （当前最新为 [v0.2.4](https://github.com/wulusai2333/deep-chat-mobile/releases/tag/v0.2.4)）；
> 也可以按下一节从源码自行构建。

1. 下载 `DeepChat-<version>-release.apk`（发布页会同时给出 APK 的 SHA-256 与证书指纹）。
2. 允许「安装未知来源应用」（针对你用来打开 APK 的应用：文件管理器 / 浏览器 / 微信，
   不是给所有应用放行）。鸿蒙上若弹「纯净模式」，选**继续安装**。
3. 安装后首次启动输入 API Key（`sk-...`），点「验证并继续」——验证走 `GET /models`。
4. 导入桌面端历史：应用内 `设置 → 数据 → 导入 → 选择文件`，或直接在文件管理器里点开 ZIP。

**升级**：0.2.x 之间直接覆盖安装即可，数据保留；只有 0.1.x → 0.2.x 需要先卸载
（早期版本的签名密钥已丢失，详见 [签名与升级](#签名与升级重要)）。

**首次启动会要什么**：只申请 `INTERNET`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS` 三个权限，
没有存储/相机/位置权限；导入与拍照走系统文件选择器/相机应用，不需要额外授权。

更细的鸿蒙安装步骤（纯净模式、adb、卸载、备份位置）见
[docs/install-harmony.md](docs/install-harmony.md)。

---

## 从源码构建

### 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（实测 22.19.0） | 脚本用到 `fs.cpSync` |
| pnpm | 实测 11.21.0 | 锁文件是 pnpm 的；npm 也能装，但建议用 pnpm |
| JDK | 17 或 21（实测 21） | 设好 `JAVA_HOME` |
| Android SDK | platform 36 + build-tools 36.0.0 | 设好 `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| Gradle | 8.14.3 | 由 wrapper 自动下载，无需手装 |
| 浏览器 | Chrome 或 Edge | `accept` / `test:import` / `ui:preview` 用无头浏览器跑 |

脚本本身跨平台（Windows / macOS / Linux）。Windows 下工具路径示例见
[docs/build.md §1](docs/build.md)。

### 命令

```powershell
pnpm install          # 本项目依赖（@capacitor/cli、typescript）
pnpm web:install      # clone/校验上游 web/ 并装它的依赖（只跑一次或换 commit 时）
pnpm web:prepare      # 校验上游 commit + 注入壳层/移动端覆盖层 + 重放补丁
pnpm build:web        # 用上游 rspack 构建 → dist/
pnpm cap:sync         # 同步原生 Java + 把 dist/ 灌进 android assets
pnpm android:release  # 编译签名的 release APK → dist-apk/
```

顺序不能乱：`cap:sync` 之前必须有 `dist/`；改了网页要重新走
`build:web → cap:sync → android:release`，否则打进 APK 的还是旧 assets。

其他常用命令：

```powershell
pnpm android:debug    # debug 包（与 release 同一把发布密钥，可互相覆盖）
pnpm verify           # 静态硬指标：构建产物 / APK / 安全 / 补丁完整性 / 私钥未入库
pnpm accept           # 无头浏览器验收「打包进 APK 的那份产物」
pnpm test:import      # 合并导入端到端（真实 IndexedDB，14 场景 45 断言）
pnpm ui:preview       # 构建 + 截图（移动端 5 屏 + 桌面回归图）
pnpm icons            # 从 assets/app-icon.jpeg 重新生成全套图标（含默认头像）
pnpm pwa              # 组装 pwa-dist/（PWA 兜底）
```

产物：`dist-apk/deep-chat-<version>-x64-release.apk`（约 6 MB）。
更完整的流水线说明、脚本职责与排错见 [docs/build.md](docs/build.md)。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│ Android（android/，Capacitor 8 工程）                         │
│  MainActivity + 3 个原生插件（源码真源在 native/）            │
│    DeepChatSecureStorage  Key 的加密存储                      │
│    DeepChatMic            麦克风权限状态 / 引导去设置          │
│    DeepChatFiles          写备份到 Documents、收外部 ZIP      │
│  WebView ← assets/public/（由 pnpm cap:sync 灌入 dist/）      │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ Web 前端（上游 chat-demo 的构建产物 + 我们的补丁）            │
│  web/         上游 clone，钉在固定 commit，**不入库**         │
│  web-patches/ 壳层代码 + 移动端覆盖层，**唯一改动来源**       │
│  scripts/prepare-web.mjs 把补丁重放到 web/ 上                │
└──────────────────────────────────────────────────────────────┘
```

### 对上游的改动：三种形态，全部可重放

`web/` 是上游仓库的只读 vendored clone（`pnpm web:install` 拉取到固定的
`PINNED_COMMIT`），构建前由 `pnpm web:prepare` 重建。**所有改动只能放在 `web-patches/`**：

1. **注入（inject）**：`web-patches/*.ts` → `web/src/shell/`，`web-patches/mobile/` → `web/src/mobile/`。
   壳层的启动时序（等 Key 就绪再 render）、加密存储桥、导入桥、首启引导、安全区 CSS 都在这里。
2. **锚点插入 / 精确替换**：在上游文件里插入带 `mobile-shell:` / `mobile-ui:` 标记的代码段，
   共 25 处、涉及 11 个上游文件；找不到锚点就**报错退出**，不静默跳过。
3. **整文件 fork**：需要整文件改写的上游组件放 `web-patches/mobile/overrides/`，
   manifest 记录上游原文件的 `sha256` 基线；上游一变就让 `prepare` 失败，避免把补丁打错位置。

`scripts/verify.mjs` 的 D 组会校验这些标记与 fork 是否逐字节一致。

---

## 签名与升级（重要）

Android 用「包名 + 签名」判定是不是同一个应用。**签名换了，已装版本就无法覆盖安装**，
用户只能卸载重装（本地会话全部丢失）。所以签名要永久固定，但**私钥绝不进仓库**：

| 文件 | 内容 | 是否入库 |
| --- | --- | --- |
| `android/deep-chat.keystore` | release 私钥（alias `deepchat`，PKCS12） | ❌ 只在本机 + 离线备份 |
| `android/keystore.properties` | 别名与口令（开发默认值 `deepchat-dev`，仅适合自用） | ❌ 只在本机 |
| `android/release-cert.sha256` | 签发证书的 SHA-256 指纹（公开信息），构建的硬约束 | ✅ 入库 |

证书 SHA-256：

```
594829f66ba88b67f8c5b025c45aaa418b58ec31692cf35142c56071088d9401
```

`pnpm android:release` 在构建结束后用 `apksigner verify --print-certs` 取实际证书指纹，
与 `release-cert.sha256` 比对，不一致直接失败；`pnpm verify` 也会检查，并断言私钥没有被
git 跟踪、git 历史里也没有（公开仓库的前提）。

规则：

- **永远不要重新生成 / 更换这把 keystore。** 也不要通过改指纹文件来「修复」构建失败——
  那等于让所有已安装设备都装不上更新。
- **私钥必须离线备份**（密码管理器附件 / 加密盘，至少两份）。私钥丢失就再也发不出能
  覆盖安装的更新；仓库里的指纹只能证明该用哪把钥匙，救不回签名。
- **0.1.x → 0.2.x 需要一次性卸载。** 早期版本用的是另一把密钥，0.2.0 起签名固定为上面的证书；
  升级前先在旧版本里「设置 → 数据 → 导出」备份，卸载重装后再导入。
- **0.2.x 起可覆盖安装**：`adb install -r` 或直接装新版 APK 即可，数据保留；
  debug 包与 release 包也共用同一把签名，可互相覆盖。
- **公开发布方式**：仓库不提交 APK；本机构建后把 APK 作为 GitHub Release 附件上传，
  私钥永远不离开本机。详细流程见 [docs/build.md §4](docs/build.md)。

---

## 隐私与数据

- **全部本地**：会话、消息与附件原件存在本机 IndexedDB；API Key 存在
  `EncryptedSharedPreferences`（主密钥在 Android Keystore，AES-256-GCM），不写 localStorage、
  不写 cookie、不进 IndexedDB。没有自建后端，也没有账号体系。
- **无遥测**：不收集统计、不上报崩溃、无广告、无第三方分析 SDK。
  应用只连接你配置的 API 服务（默认 `https://api.deepseek.com`）。
- **余额查询**：打开抽屉时会向 API 发一次 `GET /user/balance`（只带 `Authorization` 头，
  不发送任何会话内容），结果显示为 `余额 ¥12.34`；余额只存在内存、不写 localStorage /
  IndexedDB，也不进导出的历史 ZIP。
- **不参与系统备份**：`allowBackup="false"` + `dataExtractionRules` 双保险，
  云备份和换机迁移都带不走数据，跨设备靠手动导出/导入 ZIP。
- **最小权限**：只申请 `INTERNET`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`；
  没有存储、相机、位置权限（导入走系统文件选择器，拍照走 `<input capture>`，备份写 MediaStore）。
- **仓库不提交任何个人数据**：官方 App 截图、会话导出 ZIP、APK/AAB、日志、抓包、录屏
  全部在 `.gitignore` 里；`UI参考图 不允许添加到git/` 整个目录不入库；
  `deepseek_data*.zip`、`*.zip`、`*.apk`、`screenshots/`、`captures/`、`recordings/` 等规则见
  [`.gitignore`](.gitignore)。
- **仓库不包含任何密钥**：release 签名私钥与口令只存在本机（`.gitignore` 排除），
  仓库只保存证书 SHA-256 指纹（公开信息）；`pnpm verify` 会断言私钥未被 git 跟踪。
  API Key 也不在仓库里，只在安装后的设备上用 Android Keystore 加密保存。
- **删除数据**：应用内「设置 → 数据 → 清空」或卸载（会清掉会话与 Key）；
  `Documents/DeepChat/` 下的导入备份需在文件管理器里手动删除。

---

## 备份、导出与换机

- **导出**：应用内 `设置 → 数据管理 → 下载` 生成
  `deep-chat-export-<日期>-<时间>.zip`（会话 + 附件），写入 `Documents/DeepChat/`
  （Android 10+ 走 MediaStore；Android 7–9 在应用专属外部目录
  `Android/data/com.deepchat.app/files/Documents/DeepChat/`）。
  导出过程有进度浮层，完成后显示完整路径；失败会说明原因并允许重试。
  > 0.2.3 及以前，这个按钮在 Android 上其实**不写文件**（WebView 不支持
  > `<a download>`，且没有 DownloadListener）—— 0.2.4 起改为分块原生写入。
- **导入前自动备份**：合并导入会先把本机现有会话导出成
  `deep-chat-backup-<日期>-<时间>.zip`，同样保存到 `Documents/DeepChat/`。
  备份失败时导入会中止。
- **换手机**：旧机导出 ZIP → 新机安装后导入；API Key 需要重新输入；头像不会迁移
  （头像属于本机外观偏好，存在本机 `localStorage`）。
- **注意**：应用卸载 / 清理数据会删除 IndexedDB 里的会话；`Documents/DeepChat/` 下的
  ZIP 不会被卸载删除，需要自己清理。

---

## 常见问题（FAQ）

| 问题 | 可能原因与处理 |
| --- | --- |
| 安装时报「应用未安装 / INSTALL_FAILED_UPDATE_INCOMPATIBLE」 | 已装版本的签名不同。0.1.x → 0.2.x 必须卸载一次；0.2.x 之间不会。卸载前先导出会话 |
| 打开后白屏 | 先查系统 WebView / Chrome 是否 ≥ Chromium 105；升级 WebView 后重启应用。自编译包白屏还要确认 `cap:sync` 后重新打了 APK |
| 鸿蒙 NEXT 装不上 | 系统没有 Android 兼容层，只能换用 PWA 兜底（功能降级，见 `docs/build.md`） |
| 横屏/平板显示的是桌面布局 | 设计如此：视口 ≥ 768px 走桌面布局。手机上建议竖屏使用 |
| 导入很慢 / 中途像卡死 | 大归档在低端机上是分钟级操作；0.2.1 已把峰值内存和事务数大幅降下来。导入期间请保持前台、别杀应用，并留足存储 |
| 朗读没声音 | 检查媒体音量与静音；TTS 需要网络与 API 额度；部分文本服务端无法合成会提示 |
| 点「+ → 拍照/相册」没反应 | 需要系统里有相机/相册应用，且 WebView 的 file chooser 未被系统或安全软件拦截；可改用「文件」入口 |
| 提示 Key 无效 / 余额不足 | 到上游控制台检查 Key、余额与限流；本项目只负责调用 |
| 余额显示「--」「Key 无效」「网络异常」或「获取失败」 | 余额来自 `GET /user/balance`：需要联网、Key 有效且有查询权限；点一下余额文字即可重试。刚打开抽屉时可能先显示「余额查询中…」 |
| 换手机后聊天记录没了 | 设计为纯本地存储；用旧机导出 ZIP、新机导入。系统云备份不覆盖应用数据 |
| 点了「导出」没反应 / 不知道文件在哪 | 0.2.4 起导出会显示进度并写入 `Documents/DeepChat/`，成功后浮层直接给出完整路径；若显示失败，按提示检查剩余空间后点「重试」。0.2.3 及以前该按钮在 Android 上不落盘，请升级 |
| 导出的 ZIP 在哪、怎么再导入 | 文件管理 → 文档 → DeepChat → `deep-chat-export-<日期>-<时间>.zip`；在新机应用内「数据管理 → 导入 → 选择文件」即可合并导入 |
| APK 为什么不在仓库里 | 二进制产物不入库：请从 GitHub Releases 下载，或按本文从源码构建 |
| 能上架应用商店 / 自动更新吗 | 不能也不计划：只做侧载，升级靠手动安装新 APK |
| 数据存在哪、怎么彻底删 | 应用私有存储（IndexedDB/加密存储）；设置里清空或卸载；`Documents/DeepChat/` 手动删 |

---

## 已知限制

- **鸿蒙 NEXT（5.0+）不能用**：系统移除了 Android 兼容层，APK 装不上；只能用 PWA 兜底，
  且 PWA 没有 Keystore 与 Documents 写入能力（Key 退回浏览器存储，导入退回覆盖式）。
- **只能侧载**：不上架 Google Play / 华为应用市场，没有自动更新；升级靠手动安装新 APK。
- **WebView 内核下限 105**：低于此版本 Capacitor 会直接提示更新；老内核若白屏，按
  [docs/build.md §7](docs/build.md) 下调 rspack targets 后重打，但语音识别等功能仍取决于 WebView 能力。
- **平板/横屏走桌面布局**：移动端覆盖层只在 `< 768px` 生效，大屏上仍可使用，但不是目标体验。
- **导出仍是整包内存 ZIP**：导出会先把全部会话 + 图片打成内存里的 Blob 再分块写入，
  本机会话特别多（数百 MB）时可能吃紧；导入路径的低内存优化见
  [docs/import-performance.md](docs/import-performance.md)。
- **真机行为需自测**：仓库里的 `accept` / `test:import` 用无头浏览器跑，能覆盖白屏、
  首启引导、Key 注入时序、合并导入、头像读写等，但**替代不了真机验收**——朗读（TTS）、相机、
  录音、后台存活、键盘遮挡、安全区都需要装到手机上逐项过（清单见
  [docs/build.md §9.4](docs/build.md)）。
- **无多设备同步**：设计如此，数据只在本机，跨设备靠手动导入 ZIP。
- **桌面端不保证新特性**：移动端改动只出现在 `isMobile` 分支，桌面端保持上游原样。

---

## 免责声明

> 以下内容同时构成使用本项目的风险提示。请在使用前完整阅读；开始使用即视为你已理解并接受。

1. **非官方、无关联**：本项目是个人开发的第三方工具，与 DeepSeek 官方及其关联公司无任何
   隶属、合作或背书关系。「DeepSeek」、鲸鱼标识及相关商标归其各自权利人所有。本项目不主张
   任何官方身份，也不代表官方立场。

2. **按「现状」提供，无任何担保**：本项目及其产物按现状提供，不作任何明示或默示担保，
   包括但不限于适销性、特定用途适用性、不侵权、无缺陷、持续可用。作者不承诺修复缺陷、
   发布更新或提供任何形式的技术支持。

3. **第三方服务与费用**：软件本身不提供模型能力或 API 额度。你需要自行向上游服务申请
   API Key，并自行承担由此产生的费用、额度限制、账号风险与合规义务。上游服务的可用性、
   计费规则、数据处理方式与条款由其自行决定，本项目无法控制也不承担责任。

4. **数据丢失风险**：聊天记录、附件与 API Key 主要保存在本机。任何软件都可能存在缺陷，
   系统清理、误操作、卸载、设备损坏、签名变化导致的卸载重装都可能造成数据不可恢复。
   **请自行保留重要会话的导出备份**；因数据丢失、损坏或无法恢复造成的损失由使用者自行承担。

5. **安全与隐私**：本项目不含遥测、后台上传或自建服务器，但你的对话内容会按上游 API 的
   规则发送给对应服务商；请勿在对话中提交你不希望离开本机的敏感信息（密码、证件号、
   银行卡、商业机密等）。API Key 使用 Android Keystore 加密保存，但没有任何软件能保证
   绝对安全；设备被 root、被恶意软件控制或系统存在漏洞时风险由使用者承担。

6. **侧载与来源风险**：本项目不通过应用商店分发，需要手动侧载，可能被系统安全策略拦截。
   请只从本仓库的 GitHub Releases 或自己构建的产物安装，并核对发布页给出的 APK SHA-256
   与证书指纹；从第三方转载渠道获得的 APK 可能被篡改，本项目不对其负责。

7. **合规与用途**：使用本项目需遵守你所在地区的法律法规、上游服务条款及公序良俗。
   不得将本项目用于违法、侵权、骚扰、欺诈或规避监管等用途。模型生成内容不保证准确、
   完整或适用，据此做出的任何决策与后果由使用者自行承担。

8. **责任限制**：在适用法律允许的最大范围内，作者不对因使用或无法使用本项目而产生的
   任何直接、间接、偶然、特殊或后果性损失承担责任（包括但不限于利润损失、数据损失、
   业务中断、第三方索赔）。

9. **素材与分发**：`assets/app-icon.jpeg` 为项目自选图标素材（作者确认不涉及第三方版权
   授权问题）；本项目为免费、非商业项目。如权利人仍有异议，欢迎通过 Issues 联系，会删除或
   替换该素材。代码以 MIT 许可发布；「DeepSeek」名称与鲸鱼标识等商标不包含在 MIT 授权范围内。

---

## 许可

本项目代码以 **MIT License** 发布，见 [LICENSE](LICENSE)。
版权署名：`Copyright (c) 2026 Deep Chat Mobile contributors`。

上游 attribution：

- 前端来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT License，
  `Copyright (c) 2026 DeepSeek`），本项目钉在 commit
  `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`。上游源码不在本仓库内（由 `pnpm web:install`
  拉取），仓库只含补丁、壳层与脚本。
- 欢迎页鲸鱼图形取自 [Simple Icons](https://simpleicons.org/) 的 DeepSeek 单色路径（CC0），
  内联为 SVG（见 `web-patches/mobile/common/logo.tsx`）。
- 「DeepSeek」名称、鲸鱼标识及相关商标归其各自所有者所有；本项目非官方，不主张任何官方身份。
- `assets/app-icon.jpeg` 为项目自选图标素材（作者确认不涉及第三方版权授权问题）；本项目免费、
  非商业。如权利人提出异议，会删除或替换该素材。
- 本仓库不包含上游未授权的资产，也不包含任何用户个人数据（截图、会话归档、APK 等）。

---

## 目录结构

```
deep-chat-mobile/
├── capacitor.config.ts        Capacitor 配置（appId / https 安全上下文 / 输入法）
├── android/                   Android 工程（发布签名私钥不入库，只有证书指纹入库）
├── assets/app-icon.jpeg       应用图标源图（图标与默认头像由 pnpm icons 生成）
├── web-patches/               对上游的全部改动：壳层代码 + 移动端覆盖层
├── patches/                   每个上游补丁「为什么这么改」的说明
├── native/                    三个原生插件源码（Java 的唯一真源）
├── scripts/                   构建、验收、测试流水线
├── docs/                      构建文档 / 移动端 UI 规格 / 鸿蒙安装 / 导入性能
├── pwa-icons/                 PWA 图标（由 pnpm icons 生成）
├── CHANGELOG.md               版本记录
├── web/                       上游只读 clone（不入库，由 pnpm web:install 重建）
└── dist/  pwa-dist/  dist-apk/   构建产物（不入库）
```

## 文档索引

- [docs/build.md](docs/build.md) —— 构建与发布：环境、流水线、签名、上游改动清单、排错
- [docs/mobile-ui-spec.md](docs/mobile-ui-spec.md) —— 移动端 UI 规格：视觉、覆盖层架构、i18n、验收
- [docs/import-performance.md](docs/import-performance.md) —— 历史 ZIP 导入的性能与闪退根因、分块协议、内存上界
- [docs/install-harmony.md](docs/install-harmony.md) —— 鸿蒙 4.3 侧载安装、权限、卸载、导入
- [CHANGELOG.md](CHANGELOG.md) —— 版本记录
- [patches/README.md](patches/README.md) —— 25 处上游改动总览（每处的理由）
- [native/secure-storage/README.md](native/secure-storage/README.md) —— Key 加密存储的威胁模型与 API
- [native/mic-permission/README.md](native/mic-permission/README.md) —— 麦克风权限状态插件
- [native/file-open/README.md](native/file-open/README.md) —— 备份写出与「用其他应用打开 ZIP」

---

## 反馈与贡献

这是个人自用项目，Issue / PR 不保证响应。反馈问题时请附上：

- 手机型号、系统版本（鸿蒙请注明 HarmonyOS 版本）、WebView/Chrome 版本；
- APK 版本（设置 → 关于）+ 安装来源（Releases / 自己构建）；
- 复现步骤、预期与实际现象；如果是白屏/闪退，尽量附上 `adb logcat` 里的相关片段。

**安全提醒**：不要在 Issue / PR 里粘贴 API Key、会话内容、`deepseek_data*.zip` 或个人截图。
