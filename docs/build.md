# 构建与发布

从零到能装到手机上的 APK，以及一份可以直接部署的 PWA。本文按「换台机器也能照做」编写。

---

## 0. 这是什么

`chat-demo` 是纯静态前端（React + rspack），所有数据存本地 IndexedDB，直接调 `https://api.deepseek.com`。
本项目用 Capacitor 把它套进一个 Android WebView，产出可侧载的 APK。

**没有改上游界面**。所有改动都在 `web-patches/`，由脚本以上游原文件为基准重放补丁，见 [§5](#5-哪些地方动了上游代码)。

```
deep-chat-mobile/
├── capacitor.config.ts        Capacitor 配置（scheme / 输入法 / 安全）
├── package.json               脚本入口
├── web/                       上游仓库的只读克隆（不要手改，会被 prepare 覆盖）
├── web-patches/               本项目对上游的补丁源 + 壳层代码
├── native/                    原生插件源码（Java）—— Java 的唯一真源
├── android/                   Capacitor 生成的 Android 工程
├── scripts/                   构建流水线
├── docs/                      本文档
├── dist/                      build:web 的产物（进 APK 的网页）
├── pwa-dist/                  build:pwa 的产物（可直接部署的 PWA）
└── pwa-icons/                 图标源（由 make-icons 生成）
```

---

## 1. 环境准备

实测通过的版本组合：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22.19.0 | 需要 ≥ 20（脚本用到 `fs.cpSync`） |
| pnpm | 11.21.0 | npm 也能用，但锁文件是 pnpm 的 |
| JDK | 21 | Gradle 8.14 支持 17–21；**不要用 JDK 8/11** |
| Android SDK | platform 36 + build-tools 36.0.0 | `compileSdk`/`targetSdk` 都是 36 |
| Gradle | 8.14.3 | 由 wrapper 自动下载，无需手装 |

### 1.1 装 JDK

任意 JDK 17 或 21 都可以。装完设好：

```powershell
$env:JAVA_HOME = 'D:\soft\java\jdk-21'          # 换成你的路径
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version                                    # 应输出 21.x
```

> **长期生效**：用「系统属性 → 环境变量」新建 `JAVA_HOME`，而不是只改当前终端。
> Gradle 从 `JAVA_HOME` 找 JDK，找不到会报 `No Java virtual machine was found`。

### 1.2 装 Android SDK

最小安装（无需 Android Studio）：

```powershell
# 1) 下 cmdline-tools，解压到 sdk\cmdline-tools\latest
#    https://developer.android.com/studio#command-line-tools-only
# 2) 接受许可并安装需要的组件
$env:ANDROID_HOME = 'D:\soft\android-sdk'
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" `
    "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

**踩过的坑**：`sdkmanager` 的参数要用**斜杠**分隔（`platforms/android-36`），
写成 `platforms;android-36` 在 PowerShell 里会被当成分号而静默安装失败 —— 命令返回 0，但什么也没装。

然后指向 SDK。`android/local.properties` 已经写好了，换机器要改这一行：

```properties
sdk.dir=D\:\\soft\\android-sdk
```

或者让环境变量生效（`ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 两个都设，不同工具读不同的）：

```powershell
$env:ANDROID_HOME = 'D:\soft\android-sdk'
$env:ANDROID_SDK_ROOT = 'D:\soft\android-sdk'
```

### 1.3 装项目依赖

```powershell
cd deep-chat-mobile
pnpm install                # 项目自身：Capacitor CLI + typescript
```

`web/` 是上游仓库的完整克隆，依赖要单独装。`pnpm web:install` 做两件事：
校验上游 commit、然后 `pnpm install --frozen-lockfile`。

```powershell
pnpm web:install
```

> **为什么需要 typescript**：`@capacitor/cli` 读 `capacitor.config.ts` 时要 transpile，
> 没装会报 `Could not find installation of TypeScript.`。本项目锁在 `5.9.3`，
> 与上游 `web/` 里那个 `typescript 7.0.2` 是两个独立安装，互不影响。

---

## 2. 一键构建

```powershell
pnpm web:prepare      # 1. 校验上游 commit + 注入壳层 + 重放补丁
pnpm build:web        # 2. 上游 rspack 构建 → dist/
pnpm icons            # 3. 生成图标（首次或换图标时跑一次）
pnpm cap:sync         # 4. 把 dist/ 灌进 android/app/src/main/assets/public/
pnpm keystore         # 5. 生成签名 keystore（只跑一次，见 §4）
pnpm android:release  # 6. 编译签名的 release APK
pnpm verify           # 7. 自检 55 项硬指标
pnpm accept           # 8. 用无头浏览器验收打包进 APK 的那份产物
pnpm test:import      # 9. 合并导入的端到端测试（真实 IndexedDB）
```

产物：`dist-apk/deep-chat-0.1.1-x64-release.apk`（约 5.4 MB）

调试包把第 6 步换成 `pnpm android:debug`，产物名带 `-debug`，用 debug 签名。

**顺序不能乱**。`cap:sync` 之前必须有 `dist/`；`build-apk` 内部也会重跑 `cap:sync`，
所以 5→6 之间手工改了网页需要重新走一遍 2→4。

### 2.1 各脚本做什么

| 脚本 | 作用 | 幂等 |
| --- | --- | --- |
| `prepare-web.mjs` | 校验 `web/` 在上游 pin 的 commit 上；把 `web-patches/*` 复制到 `web/src/shell/`；对上游 9 个文件重放补丁 | ✅ 重复跑安全 |
| `build-web.mjs` | 直接调 `web/node_modules/@rspack/cli/bin/rspack.js`，设 `NODE_ENV=production`，再把 `web/dist/` 复制到 `dist/` | ✅ |
| `cap-sync.mjs` | 先 `sync-native.mjs` 同步 Java，再跑 `capacitor sync android`，最后校验 assets 真的非空 | ✅ |
| `build-apk.mjs` | 检查环境变量 → 同步 Java → `gradlew assembleRelease` → 归档改名 → `apksigner verify` | ✅ |
| `make-keystore.mjs` | 生成 keystore + `keystore.properties`。**文件已存在时拒绝执行** | 防护式 |
| `make-icons.mjs` | 按像素画图标，写 `android/.../mipmap-*` 与 `pwa-icons/` | ✅ 覆盖写 |
| `build-pwa.mjs` | 组装 `pwa-dist/`（manifest + service worker + 图标） | ✅ |
| `verify.mjs` | 55 项硬指标自检，失败退出码 1 | 只读 |
| `accept.mjs` | 无头 Chromium 打开 **APK 里那份** assets，注入假原生桥，验证渲染 / 引导层 / Key 注入时序 / PWA 兜底 / 安全区变量 | 只读 |
| `test-import.mjs` | 用真实 IndexedDB 跑合并导入的 10 个场景 31 条断言 | 只读 |

> **为什么 `build:web` 不直接跑 `pnpm build`**
> 上游的构建脚本是 `NODE_ENV=production rspack build`，这种写法在 Windows 的 `cmd` 下不成立
> （会报 `'NODE_ENV' 不是内部或外部命令`）。`build-web.mjs` 用 Node 直接调 rspack 并设好环境变量，
> 一处修好，跨平台都能跑。

> **`accept` 与 `test-import` 为什么值得存在**
> `pnpm build:web` 成功**不代表**页面能渲染 —— 壳层代码只要有一处抛异常，应用就白屏，
> 而构建日志全是绿的。用户装上 APK 看到的第一个也是唯一一个现象就是白屏，这种问题
> 必须在构建侧拦住。`accept` 直接跑打包进 APK 的那份 assets，能覆盖白屏、引导层、
> Key 注入时序、浏览器兜底路径。
>
> `test-import` 覆盖的是更危险的一类：合并导入踩在「清空 → 重建」的原子事务上，
> 写错会**静默丢用户数据**，而且读代码看不出来。它跑在真实 IndexedDB 上，
> 包含幂等性、新旧择优、附件与 MIME 保留、损坏归档整批回滚等 10 个场景。
>
> 两者都不依赖模拟器，因此可以进 CI；但它们**替代不了真机验收**（见 §9.1）。

---

## 3. 装到手机

### 3.1 鸿蒙 4.3（Mate 70 Pro+）

APK 走 Android 兼容层。详细步骤见 [install-harmony.md](./install-harmony.md)，要点：

1. 设置 → 安全 → 更多安全设置 → **允许安装未知来源应用**（针对文件管理器或浏览器）
2. 把 APK 传到手机（USB / 微信文件传输 / 网盘均可）
3. 点击安装。若弹「纯净模式」拦截，选**继续安装**（需要登录华为账号）
4. 首次启动会要求输入 API Key，见 §6

### 3.2 用 adb 装（开发时更快）

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r dist-apk\deep-chat-0.1.1-x64-release.apk
```

`-r` 是覆盖安装、保留数据。**签名必须一致** —— 换签名只能先卸载，本地数据会全丢。

---

## 4. 签名

Android 用「包名 + 签名」识别是不是同一个应用。**keystore 丢了就再也发不出能覆盖安装的更新**，
用户只能卸载重装（本地会话全没）。所以：

```powershell
pnpm keystore
```

产出：

- `android/deep-chat.keystore` —— 私钥。**离线备份，别进 git**
- `android/keystore.properties` —— 口令与别名。同样别进 git

两个文件都已在 `.gitignore` 里。`build.gradle` 从 `keystore.properties` 读签名配置；
文件不存在时 release 构建不带签名（能编译，但装不上真机）。

### 4.1 对外分发前必须做的

脚本生成的是**开发默认口令** `deepchat-dev`，并在输出里明确警告。要让别人装，改成自己的：

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore android\deep-chat.keystore -alias deepchat `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass '<强口令>' -keypass '<强口令>' `
  -dname "CN=你的名字, OU=Mobile, O=你的组织, C=CN"
```

然后同步改 `android/keystore.properties`。`validity 10000`（约 27 年）是为了避免证书过期后无法更新。

### 4.2 校验签名

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --print-certs `
  dist-apk\deep-chat-0.1.1-x64-release.apk
```

`build-apk.mjs` 在 release 结束时自动跑这一步。

---

## 5. 哪些地方动了上游代码

**原则：能不改就不改。** 需要改的一律在 `web-patches/` 里，由 `prepare-web.mjs` 用
「锚点 + `mobile-shell:` 标记」的方式重放，每个替换点都带注释说明为什么。

改动清单（共 9 个上游文件、14 处替换）：

| 文件 | 改了什么 | 为什么必须改 |
| --- | --- | --- |
| `src/index.html` | viewport 加 `viewport-fit=cover` | 不加则 `env(safe-area-inset-*)` 恒为 0，刘海会挡内容 |
| `src/main.tsx` | render 前 `await shellReady` | 让加密存储里的 Key 在首屏挂载前就位，否则每次启动都弹设置窗 |
| `src/components/settings/settingsDialogState.ts` | `ensureApiKey()` 增加首启引导判断 | 引导自己管 Key 输入，两套弹窗不能同时出现 |
| `src/services/settings.ts` | Key 的读写走加密存储；内存变量兜底 | **核心安全需求**：Key 不许落 localStorage 明文 |
| `src/services/chat/history/toLocal.ts` | `toSorted()` → `.slice().sort()` | `toSorted` 是 ES2023，鸿蒙 4.3 的 WebView 内核不支持，会直接崩 |
| `src/services/chat/store.ts` | `toReversed()` → `.slice().reverse()` | 同上 |
| `src/services/chat/db.ts` | **新增** 3 个暂存辅助函数 | 合并导入需要「复制现有数据进暂存」，上游只有覆盖导入 |
| `src/services/chat/backup.ts` | 拆出 `exportHistorySnapshot()`；导入改走合并桥 | 自动备份需要不经过队列的快照；导入要 merge 而非 replace |
| `src/components/chatInput/useVoiceInput.ts` | 录音失败时补一次原生引导 | 区分「永久拒绝」与普通失败，否则用户被卡在一条看不懂的 toast 上 |

**绝不能做的事**（做了就是返工）：

- 改布局、字号、间距、配色 —— 手机端界面必须与桌面浏览器一致
- 给上游加 npm 依赖 —— `web/pnpm-lock.yaml` 会被破，且增大回归面
- 在 `web/src/` 里手工改代码 —— 下次 `prepare-web` 会覆盖，改动丢失

### 5.1 拿不到上游源码怎么办

`web/` 是完整克隆，不是 submodule。如果上游更新了想跟：

```powershell
cd web
git fetch origin
git log --oneline HEAD..origin/main     # 看有什么变化
git checkout <新commit>
cd ..
# 更新 scripts/lib/env.mjs 里的 PINNED_COMMIT，然后
pnpm web:install
pnpm web:prepare    # 若某处锚点失效，会明确报「找不到待替换原文」并指出文件
```

锚点失效说明上游改了那段代码，需要人看一遍再更新补丁 —— 这是有意的，不是缺陷：
**静默失败比报警更危险**。

---

## 6. API Key 的安全边界

需求里「设备丢失不能泄露 Key」是硬指标。做法：

```
用户输入 → 前端 setApiKey()
         → window.__CHAT_DEMO_KEYSTORE__.set()      （浏览器里没有这个对象）
         → 原生 DeepChatSecureStorage.write()
         → EncryptedSharedPreferences（MasterKey 在 Android Keystore 里，AES256-GCM）
```

读取方向相反：启动时前端调 `read()`，把明文只放进内存变量 `window.__RUNTIME_KEY__`，
用完即弃（不写 localStorage、不写 cookie、不进 IndexedDB）。

**明确的安全边界**（不夸大）：

| 能防 | 不能防 |
| --- | --- |
| 手机丢失后，拿到 `data/` 目录也解不出 Key（密钥在 TEE/StrongBox 里，与设备绑定） | 已 root 且攻击者能实时注入你的进程 |
| 备份文件里没有明文 Key（`allowBackup=false` 且加密存储本身不进备份） | 系统级恶意软件 / 已被攻破的 WebView 内核 |
| 应用内其他页面 / XSS 拿不到（Key 不在任何可枚举的存储里） | 用户自己截图或手抄 |

这些限制写在这里，而不是藏起来 —— 「不能防什么」和「能防什么」同等重要。

复核方式：

```powershell
pnpm verify     # C 组会检查产物里没有 sk- 字面量、settings.ts 分支顺序、原生是否真用 EncryptedSharedPreferences
```

---

## 7. 老 WebView 内核与降级

鸿蒙 4.3 的 WebView 内核版本比同代 Android 旗舰更旧。当前目标：

```ts
// web/rspack.config.ts（由上游决定，本项目未改）
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
```

`capacitor.config.ts` 里同时设了 `minWebViewVersion: 105` —— 低于此版本 Capacitor 会直接提示更新，
而不是让应用在半坏的状态下运行。

### 7.1 如果真机上白屏或语法报错

先确认真实内核版本。在手机浏览器打开 `https://www.whatismybrowser.com/detect/what-version-is-my-browser`，
或连 adb 后：

```powershell
adb shell dumpsys webviewupdate | Select-String "Current WebView package"
```

若明显低于 105，把 `web/rspack.config.ts` 的 `targets` 降到 `chrome >= 99`（或更低），重跑
`build:web` → `cap:sync` → 重新打包。**这是唯一需要改上游文件的情况**，改完要记在这里。

```ts
const targets = ['chrome >= 99', 'edge >= 99', 'safari >= 15', 'firefox >= 100']
```

同时把 `capacitor.config.ts` 的 `minWebViewVersion` 一起调低，否则会被拦在启动页。

代价：产物体积略增（降级会插入更多 polyfill），构建稍慢。**没有别的副作用**。

### 7.2 已知会失败的能力

不是所有上游功能在受限 Key 下都能用。这与 APK 无关，是 API 权限问题：

- 联网搜索（`/v1/tools/search`）—— 部分 Key 返回 401/404
- 网页读取（`/v1/tools/open`）
- 语音识别（`/v1/tools/asr`）—— 若 Key 无权限，录音能进行但转写失败

处理方式：让用户换一个有权限的 Key，或在设置里关掉对应开关。应用不应白屏或崩溃 ——
上游对这些失败已有 toast 处理。

---

## 8. PWA 兜底

鸿蒙 NEXT 不再兼容 APK。过渡方案是把同一份 `dist/` 当 PWA 用（浏览器打开 + 添加到桌面）。

```powershell
pnpm build:web
pnpm icons
pnpm pwa
```

产物 `pwa-dist/`，可直接丢到任意静态托管（Nginx / Vercel / GitHub Pages / OSS）。

### 8.1 组成

- `manifest.webmanifest` —— `display: standalone`、竖屏、深色启动底
- `sw.js` —— 只缓存构建产物，**不缓存任何 API 响应**
- `icons/` —— 192 / 512 / maskable-512

### 8.2 service worker 的策略与理由

| 请求类型 | 策略 | 为什么 |
| --- | --- | --- |
| 导航（HTML） | network-first，断网回落缓存 | 有网时必须拿到最新版本 |
| 静态资源 | cache-first | 文件名带 contenthash，内容变则名变，永不更新是安全的 |
| 跨域 API | **直接放行，不介入** | 流式响应被 SW 包一层会破坏 SSE |

### 8.3 本地验收

```powershell
node scripts/dev-serve.cjs pwa-dist 8098
# 浏览器打开 http://127.0.0.1:8098/
```

SW 需要 **https 或 localhost**。直接双击 `index.html`（`file://`）不会注册成功，这是浏览器安全限制，不是 bug。

### 8.4 PWA 与 APK 的能力差异

| 能力 | APK | PWA |
| --- | --- | --- |
| Key 加密存储 | ✅ Keystore | ❌ 退回 localStorage（浏览器沙箱内） |
| 合并导入 + 自动备份到 Documents | ✅ | ❌ 退回上游的覆盖式导入，无备份 |
| 外部打开 ZIP（文件管理器） | ✅ | ❌ |
| 离线启动 | ✅ 资源内置 | ✅ SW 缓存 |
| 语音输入 / 朗读 | ✅ | ✅（需 https） |

**这是有意的降级**：浏览器里没有 Keystore，也无法写 Documents。PWA 是过渡手段，不是等价替代。

---

## 9. 自检清单

发布前跑这三条：

```powershell
pnpm verify        # 静态硬指标（不需要浏览器）
pnpm accept        # 无头浏览器验收 APK 里的那份产物
pnpm test:import   # 合并导入端到端（真实 IndexedDB）
```

### 9.1 `verify`：55 项静态硬指标

覆盖四组：

- **A 构建产物**：viewport、6 个壳能力真的在 bundle 里、CSS 变量、`assets` 与 `dist` 逐字节一致（防「忘了 cap sync 就打包」）
- **B APK 硬指标**：权限白名单、无存储/相机/位置权限、`allowBackup=false`、`usesCleartextTraffic=false`、release 已签名
- **C 安全**：产物无 `sk-` 字面量、keystore 分支先 return（不会回写 localStorage）、原生真用 `EncryptedSharedPreferences`、网络配置不信任用户 CA
- **D 补丁完整性**：14 个 `mobile-shell:` 标记都在位（有人手工改回去会立刻暴露）

### 9.2 `accept`：25 项运行时验收

无头 Chromium 打开 `android/app/src/main/assets/public/`（**已打包进 APK 的那份**），
注入一个模拟的 `window.Capacitor.nativePromise` 原生桥，验证：

| 场景 | 验的东西 |
| --- | --- |
| A 首次安装（桥返回空 Key） | 页面真的渲染（非白屏）、出现引导层、`__CHAT_DEMO_ONBOARDING__=true`、导入/Key 桥已装、确实向原生读过 Key |
| B 已配好 Key | Key 进入 `window.__RUNTIME_KEY__`、**不**出引导层、标志复位 |
| C 已引导过 | 即使没 Key 也不再弹 |
| D 纯浏览器（无桥） | 正常渲染、零异常、不装壳层专属能力 —— PWA 兜底路径 |
| E 安全区 | `.frame` 锚点仍在、`--shell-inset-*` 是具体 px 而非 `env()` 原文 |

### 9.3 `test:import`：31 条断言 / 10 个场景

| 场景 | 验的东西 |
| --- | --- |
| 1 空库导入 | 会话与消息正确落库 |
| 2/3 重复导入 ×2 | 幂等：全部 skipped，会话数不变 |
| 4 导入更新的同名会话 | 记为 updated，消息变多，**其他会话不丢** |
| 5 导入更旧的同名会话 | 跳过，不覆盖新数据 |
| 6 带图片导入 | 附件 id、`isImage`、MIME 嗅探、原件字节都在 |
| 7 后续导入纯文字 | 既有图片的 MIME 与原件**不被抹掉** |
| 8 损坏归档 | 抛错且整批回滚，会话数不变 |
| 9 单条坏数据 | 好的入库、坏的记 failed 并指出是哪条 |
| 10 导出后回导 | 往返一致 |

> **为什么场景 4/5/7 最关键**：它们对应「合并而非替换」这条规格。
> `replaceHistory()` 内部会先 `clearStaging()` 再重建，一旦哪一步写错，
> 用户的历史会话就会在导入成功的外观下被悄悄清掉 —— 这类错误不会报错，
> 只会在几天后被发现「我的对话怎么没了」。

三条命令失败时退出码为 1，可直接接 CI。

### 9.4 手工验收（自动化覆盖不到的）

装到真机后逐项过：

- [ ] 首屏正常渲染，无白屏；Markdown / KaTeX 公式 / Mermaid 图正常
- [ ] 深浅色跟随系统切换
- [ ] 键盘弹出不遮挡输入框
- [ ] 顶部内容不被刘海/状态栏遮挡（安全区生效）
- [ ] 首次启动出现引导；输错 Key 有提示；输对后进入
- [ ] 杀进程重启，**不再**要求输入 Key
- [ ] 语音输入：首次点录音弹系统授权框；允许后能录；拒绝后提示正确
- [ ] 语音输入：选「不再询问」后再录音，出现「去设置」引导
- [ ] 朗读：点朗读有声音（无声音先查媒体音量与静音开关）
- [ ] 导入：设置 → 数据 → 导入 ZIP（系统文件选择器），结果页显示新增/更新/跳过/失败
- [ ] 导入后 `Documents/DeepChat/` 下有 `deep-chat-backup-<时间>.zip`
- [ ] 同一 ZIP 连导 3 次，会话数不变
- [ ] 在文件管理器里点开 ZIP → 「用其他应用打开」→ Deep Chat，能直接导入
- [ ] 锁屏 5 分钟回来，应用还在（而不是被系统杀掉）
- [ ] 飞行模式下启动，历史会话能看（只是发不出消息）

---

## 10. 排错

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Could not find installation of TypeScript` | 项目根没装 typescript | `pnpm install` |
| `'NODE_ENV' 不是内部或外部命令` | 直接跑了上游 `pnpm build` | 用 `pnpm build:web` |
| `No Java virtual machine was found` | `JAVA_HOME` 没设或指向 JRE | 设 `JAVA_HOME` 到 JDK 根目录 |
| `SDK location not found` | `local.properties` 缺失/路径错 | 改 `android/local.properties` 的 `sdk.dir` |
| `找不到待替换原文` | 上游代码变了，锚点失效 | 看报错指的文件，人读一遍再更新补丁 |
| APK 装上白屏 | `dist/` 是旧的，或资产没灌入 | `build:web` → `cap:sync` → 重新打包；`pnpm verify` A 组会抓这个 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名与已装版本不同 | 先 `adb uninstall com.deepchat.app`（**会清数据**） |
| 装不上，提示「解析包错误」 | `minSdk` 高于设备，或文件传输损坏 | 确认 Android 版本 ≥ 7.0（API 24）；重新传一次 |
| 录音失败但系统里麦克风已允许 | `MODIFY_AUDIO_SETTINGS` 缺失 | 见 [§11](#11-一个容易忽略的坑录音权限) |
| 输入中文时拼音被打断 | `captureInput` 被设成 `true` | 保持 `captureInput: false` |

看真机日志：

```powershell
adb logcat -s Capacitor/Console:V Capacitor:V chromium:V
```

---

## 11. 一个容易忽略的坑：录音权限

Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 在网页请求麦克风时，
会**同时**申请两个权限：

```java
// node_modules/@capacitor/android/capacitor/.../BridgeWebChromeClient.java:108
permissionLauncher.launch(new String[] {
    Manifest.permission.MODIFY_AUDIO_SETTINGS,
    Manifest.permission.RECORD_AUDIO
});
```

并对结果做「**全部 granted 才算 granted**」的与运算。所以 manifest 里少声明
`MODIFY_AUDIO_SETTINGS` 时，系统把它直接判 denied（不弹框、无提示），
整组请求失败 → `request.deny()` → 网页侧 `getUserMedia` 抛 `NotAllowedError`。

用户看到的现象是：**系统设置里麦克风明明允许了，点录音就是失败**。极难排查。

`MODIFY_AUDIO_SETTINGS` 是 `normal` 级权限（安装时自动授予、不弹框、不给额外数据访问），
所以加上它不违背「最小权限」的本意。`pnpm verify` 的权限白名单里包含它，
并在 `AndroidManifest.xml` 里写了完整说明。

---

## 12. 安全区（刘海 / 手势条）

Capacitor 8 的 `SystemBars` 有两档行为，`web-patches/safe-area.css` 的顶部注释记录了完整表格：

- **A 档**（WebView < 140，或页面没有 `viewport-fit=cover`）：原生给 decorView 加 padding，
  CSS 变量全是 `"0px"`。此时**不要**再加 CSS padding，否则双重留白。
- **B 档**（WebView ≥ 140 且 `viewport-fit=cover`）：原生不动，CSS 变量是真实 dp 值，需要自己 pad。

本项目用 `--shell-inset-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px))`，
两种情况都能拿到正确值；只在窄屏（`< 768px`）对 `.frame` 加 padding-top，
因为底部由上游自己处理了（`SessionView` 的输入区、`Welcome`、`Settings`、`Toast` 四处）。

**不要**对 `div[class*='content-']` 这类模糊选择器加 padding —— 构建产物里有 6 个不同的
`content-*` 哈希类（`_282ec`、`_3d93a`、`_5cf57`、`_83af2`、`_85c1b`、`_9fdf5`），会误伤。这是踩过的坑。

---

## 13. 相关文档

- [install-harmony.md](./install-harmony.md) —— 鸿蒙侧载安装细节
- [`../native/secure-storage/README.md`](../native/secure-storage/README.md) —— 加密存储的威胁模型与 API
- [`../web/src/services/chat/history/README.md`](../web/src/services/chat/history/README.md) —— 上游的归档格式说明
