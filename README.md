# Deep Chat 手机端（deep-chat-mobile）

把上游 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的纯静态前端封装成
**Android APK** 的个人项目：Capacitor 8 壳 + 三个原生插件 + 一层按官方 App 重做的移动端 UI。
目标是**个人自用、侧载安装**，实测目标机是鸿蒙 4.3（Android 兼容层，`minSdk 24` / `compileSdk 36`）。

> **非官方项目**：与 DeepSeek 官方无任何关联，也不代表其立场。仓库内不包含上游源码副本，
> 只包含补丁、壳层代码、原生插件、脚本与文档；所有上游许可与署名见文末「许可」。

当前版本 **0.2.1**（以 `package.json` 的 `version` 为准；APK 文件名由它决定，
`capacitor.config.ts` 的 UA 与 `build.gradle` 的兜底版本号需同步手改）。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 移动端 UI 对齐官方 App | 欢迎页（鲸鱼 logo + 问候语）、顶栏（汉堡 / 朗读 / 新建对话）、圆角输入框 + 深度思考/智能搜索药丸、`+` 附件面板（拍照 / 相册 / 文件 / 最近图片）、按住说话、抽屉（搜索 + 分组列表 + 底部账户行）。桌面端保持上游原样 |
| 上游聊天能力完整保留 | 流式回复、深度思考、联网搜索、网页读取、附件上传、Markdown / 代码高亮 / KaTeX / Mermaid、分支切换、重新生成 |
| 本地会话 | 会话、消息与附件原件都在本机 IndexedDB，无后端，不需要账号 |
| API Key 加密存储 | `EncryptedSharedPreferences` + Android Keystore（AES-256-GCM），Key 不落 localStorage / IndexedDB 明文；首启引导会先验证 Key 再进主界面 |
| 历史 ZIP **合并**导入 | 导入前自动备份当前全部会话；同 id 取 `updatedAt` 较新者、不同 id 追加，**不覆盖本机**；重复导入幂等；支持应用内选择文件与「用其他应用打开 ZIP」两条入口 |
| 朗读 | 顶栏喇叭朗读当前会话最后一条有正文的回答；朗读中喇叭**变为品牌蓝**（`aria-pressed`/`data-reading` 可测），再点一次停止 |
| 深色模式 | 跟随系统 / 手动切换，移动端组件有自己的浅色与深色 token |
| 安全区与中文输入法 | `viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海与手势条；`captureInput: false` 保证拼音组合输入正常 |
| PWA 兜底 | 同一份 `dist/` 可打成可直接部署的 PWA（鸿蒙 NEXT 用户的过渡方案，能力有降级） |

## 装到手机（使用者视角）

> 本仓库**不提交 APK**（`.gitignore` 排除二进制产物）。需要自己构建，见下一节。

1. 构建得到 `dist-apk/deep-chat-<version>-x64-release.apk`。
2. 鸿蒙 4.3 上先允许「安装未知来源应用」（针对文件管理器/浏览器，不是全部应用），
   纯净模式拦截时选「继续安装」。
3. 安装后首次启动输入 API Key（`sk-...`），点「验证并继续」——验证走 `GET /models`。
4. 导入桌面端历史：应用内 `设置 → 数据 → 导入 → 选择文件`，或直接在文件管理器里点开 ZIP。

详细步骤（权限、adb、卸载、备份位置）见 [docs/install-harmony.md](docs/install-harmony.md)。

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
pnpm verify           # 静态硬指标：构建产物 / APK / 安全 / 补丁完整性
pnpm accept           # 无头浏览器验收「打包进 APK 的那份产物」
pnpm test:import      # 合并导入端到端（真实 IndexedDB，10 场景 43 断言）
pnpm ui:preview       # 构建 + 截图（移动端 5 屏 + 桌面回归图）
pnpm icons            # 从 assets/app-icon.jpeg 重新生成全套图标
pnpm pwa              # 组装 pwa-dist/（PWA 兜底）
```

产物：`dist-apk/deep-chat-<version>-x64-release.apk`（约 5.8 MB）。
更完整的流水线说明、脚本职责与排错见 [docs/build.md](docs/build.md)。

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


## 隐私与数据

- **全部本地**：会话、消息与附件原件存在本机 IndexedDB；API Key 存在
  `EncryptedSharedPreferences`（主密钥在 Android Keystore，AES-256-GCM），不写 localStorage、
  不写 cookie、不进 IndexedDB。没有自建后端，也没有账号体系。
- **无遥测**：不收集统计、不上报崩溃、无广告、无第三方分析 SDK。
  应用只连接你配置的 API 服务（默认 `https://api.deepseek.com`）。
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

## 目录结构

```
deep-chat-mobile/
├── capacitor.config.ts        Capacitor 配置（appId / https 安全上下文 / 输入法）
├── android/                   Android 工程（含入库的发布签名）
├── assets/app-icon.jpeg       应用图标源图（其他图标由 pnpm icons 生成）
├── web-patches/               对上游的全部改动：壳层代码 + 移动端覆盖层
├── patches/                   每个上游补丁「为什么这么改」的说明
├── native/                    三个原生插件源码（Java 的唯一真源）
├── scripts/                   构建、验收、测试流水线
├── docs/                      构建文档 / 移动端 UI 规格 / 鸿蒙安装说明
├── pwa-icons/                 PWA 图标（由 pnpm icons 生成）
├── web/                       上游只读 clone（不入库，由 pnpm web:install 重建）
└── dist/  pwa-dist/  dist-apk/   构建产物（不入库）
```

## 文档索引

- [docs/build.md](docs/build.md) —— 构建与发布：环境、流水线、签名、上游改动清单、排错
- [docs/mobile-ui-spec.md](docs/mobile-ui-spec.md) —— 移动端 UI 规格：视觉、覆盖层架构、i18n、验收
- [docs/import-performance.md](docs/import-performance.md) —— 历史 ZIP 导入的性能与闪退根因、分块协议、内存上界
- [docs/install-harmony.md](docs/install-harmony.md) —— 鸿蒙 4.3 侧载安装、权限、卸载、导入
- [patches/README.md](patches/README.md) —— 17 处上游改动总览（每处的理由）
- [native/secure-storage/README.md](native/secure-storage/README.md) —— Key 加密存储的威胁模型与 API
- [native/mic-permission/README.md](native/mic-permission/README.md) —— 麦克风权限状态插件
- [native/file-open/README.md](native/file-open/README.md) —— 备份写出与「用其他应用打开 ZIP」

## 已知限制

- **鸿蒙 NEXT（5.0+）不能用**：系统移除了 Android 兼容层，APK 装不上；只能用 PWA 兜底，
  且 PWA 没有 Keystore 与 Documents 写入能力（Key 退回浏览器存储，导入退回覆盖式）。
- **只能侧载**：不上架 Google Play / 华为应用市场，没有自动更新；升级靠手动安装新 APK。
- **WebView 内核下限 105**：低于此版本 Capacitor 会直接提示更新；老内核（如鸿蒙 4.3 的
  部分机型）若白屏，按 [docs/build.md §7](docs/build.md) 下调 rspack targets 后重打，
  但语音识别等功能仍取决于 WebView 能力。
- **真机行为需自测**：仓库里的 `accept` / `test:import` 用无头浏览器跑，能覆盖白屏、
  首启引导、Key 注入时序、合并导入等，但**替代不了真机验收**——朗读（TTS）、相机、
  录音、后台存活、键盘遮挡、安全区都需要装到手机上逐项过（清单见
  [docs/build.md §9.4](docs/build.md)）。
- **无多设备同步**：设计如此，数据只在本机，跨设备靠手动导入 ZIP。
- **桌面端不保证新特性**：移动端改动只出现在 `isMobile` 分支，桌面端保持上游原样。

## 许可

本项目以 **MIT License** 发布，见 [LICENSE](LICENSE)。
版权署名：`Copyright (c) 2026 Deep Chat Mobile contributors`。

上游 attribution：

- 前端来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT License，
  `Copyright (c) 2026 DeepSeek`），本项目钉在 commit
  `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`。上游源码不在本仓库内（由 `pnpm web:install`
  拉取），仓库只含补丁、壳层与脚本。
- 欢迎页鲸鱼图形取自 [Simple Icons](https://simpleicons.org/) 的 DeepSeek 单色路径（CC0），
  内联为 SVG（见 `web-patches/mobile/common/logo.tsx`）。
- 「DeepSeek」名称、鲸鱼标识及相关商标归其各自所有者所有；本项目非官方，不主张任何官方身份。
- `assets/app-icon.jpeg` 为项目自选的图标素材，仓库内未声明其第三方授权；若要公开分发，
  请先自行确认该素材的使用许可。
- 本仓库不包含上游未授权的资产，也不包含任何用户个人数据（截图、会话归档、APK 等）。

---

本项目是个人自用工具，按「现状」提供，不对数据安全或可用性作任何担保；请自行备份重要会话。
