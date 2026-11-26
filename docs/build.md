# 构建与发布

从零到能装到手机上的 APK，以及一份可以直接部署的 PWA。本文按「换台机器也能照做」编写。

---

## 0. 这是什么

`chat-demo` 是纯静态前端（React + rspack），所有数据存本地 IndexedDB，直接调 `https://api.deepseek.com`。
本项目用 Capacitor 把它套进一个 Android WebView，产出可侧载的 APK。

**桌面端界面不改；移动端界面按官方 App 重做**，两者都通过 `web-patches/` 里的补丁实现，
由脚本以上游原文件为基准重放，见 [§5](#5-哪些地方动了上游代码) 与
[`mobile-ui-spec.md`](./mobile-ui-spec.md)。

```
deep-chat-mobile/
├── capacitor.config.ts        Capacitor 配置（scheme / 输入法 / 安全）
├── package.json               脚本入口
├── web/                       上游仓库的只读克隆（不要手改，会被 prepare 覆盖）
├── web-patches/               本项目对上游的补丁源 + 壳层代码
│   ├── *.ts / safe-area.css   壳层代码（注入 web/src/shell/）
│   └── mobile/                移动端覆盖层（见 docs/mobile-ui-spec.md §1）
│       ├── common/            设计 tokens、图标、logo
│       ├── chatinput/         移动端输入框 / 附件面板 / 按住说话
│       ├── topbar/            移动端顶栏
│       ├── drawer/            移动端抽屉（搜索 + 列表 + 账户行）
│       ├── overrides/         整文件 fork 的上游组件
│       └── manifests/         每个 area 的 fork 清单
├── native/                    原生插件源码（Java）—— Java 的唯一真源
├── android/                   Capacitor 生成的 Android 工程
├── scripts/                   构建流水线
├── docs/                      本文档 + mobile-ui-spec.md
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
pnpm web:prepare      # 1. 校验上游 commit + 注入壳层/移动端覆盖层 + 重放补丁
pnpm build:web        # 2. 上游 rspack 构建 → dist/
pnpm ui:preview       # 3. 构建 + 无头截图（移动 5 屏 + 桌面回归图，开发时常用）
pnpm icons            # 4. 生成图标（首次或换图标时跑一次）
pnpm cap:sync         # 5. 把 dist/ 灌进 android/app/src/main/assets/public/
pnpm keystore         # 6. 发布签名自检（私钥只在本机，见 §4）
pnpm android:release  # 7. 编译签名的 release APK（自动校验证书指纹）
pnpm verify           # 8. 自检 APK / 安全 / 补丁硬指标
pnpm accept           # 9. 用无头浏览器验收打包进 APK 的那份产物
pnpm test:import      # 10. 合并导入的端到端测试（真实 IndexedDB）
```

产物：`dist-apk/deep-chat-0.2.8-x64-release.apk`（约 5.8 MB）

调试包把第 7 步换成 `pnpm android:debug`，产物名带 `-debug`。**debug 与 release 使用同一把
发布密钥**（见 `android/app/build.gradle`），所以两者可以互相覆盖安装，不会出现
「先装过 debug 包，正式包盖不上」的问题。

**顺序不能乱**。`cap:sync` 之前必须有 `dist/`；`build-apk` **只负责同步原生 Java 并调 Gradle**，
不会再重跑 `cap:sync` —— 手工改了网页必须重新走一遍 2→5→6，否则打进 APK 的还是旧 assets。
（`pnpm verify` 的 A 组会用「assets 与 dist 逐字节一致」抓这种漏跑。）

### 2.1 各脚本做什么

| 脚本 | 作用 | 幂等 |
| --- | --- | --- |
| `prepare-web.mjs` | 校验 `web/` 在上游 pin 的 commit 上；把 `web-patches/*` 注入 `web/src/shell/`、`web-patches/mobile/` 注入 `web/src/mobile/`；按 manifest 应用整文件 fork；对上游文件重放锚点补丁 | ✅ 重复跑安全 |
| `build-web.mjs` | 直接调 `web/node_modules/@rspack/cli/bin/rspack.js`，设 `NODE_ENV=production`，再把 `web/dist/` 复制到 `dist/` | ✅ |
| `ui-preview.mjs` | 串行化构建（文件锁）+ 无头截图：移动端欢迎页/抽屉/附件面板/按住说话/发送态 + 桌面回归图 | ✅ |
| `mobile-forks.mjs` | 移动端 fork 辅助：`hash` / `new` / `check`（见 `mobile-ui-spec.md` §1.2） | 只读 / 防护式 |
| `cap-sync.mjs` | 先 `sync-native.mjs` 同步 Java，再跑 `capacitor sync android`，最后校验 assets 真的非空 | ✅ |
| `build-apk.mjs` | 检查环境变量（release 还要求发布签名齐全）→ 同步 Java → `gradlew assembleRelease` → 归档改名 → `apksigner verify` → **证书指纹与 `release-cert.sha256` 比对** | ✅ |
| `make-keystore.mjs` | 生成 keystore + `keystore.properties`（**只在本机，绝不入库**）。**已存在时拒绝覆盖**，且存在指纹基线时拒绝重新生成（防签名丢失后误换） | 防护式 |
| `make-icons.mjs` | 按像素画图标，写 `android/.../mipmap-*` 与 `pwa-icons/` | ✅ 覆盖写 |
| `build-pwa.mjs` | 组装 `pwa-dist/`（manifest + service worker + 图标） | ✅ |
| `verify.mjs` | 硬指标自检（构建/APK/安全/补丁完整性），失败退出码 1 | 只读 |
| `accept.mjs` | 无头 Chromium 打开 **APK 里那份** assets，注入假原生桥，验证渲染 / 引导层 / Key 注入时序 / PWA 兜底 / 安全区 / 移动端 UI 结构 | 只读 |
| `test-import.mjs` | 用真实 IndexedDB 跑合并导入的 10 个场景 43 条断言 | 只读 |

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

### 3.1 真机侧载（目标是鸿蒙 4.x；开发期在 Android 模拟器上验证）

APK 走 Android 兼容层。详细步骤见 [install-harmony.md](./install-harmony.md)，要点：

1. 设置 → 安全 → 更多安全设置 → **允许安装未知来源应用**（针对文件管理器或浏览器）
2. 把 APK 传到手机（USB / 微信文件传输 / 网盘均可）
3. 点击安装。若弹「纯净模式」拦截，选**继续安装**（需要登录华为账号）
4. 首次启动会要求输入 API Key，见 §6

### 3.2 用 adb 装（开发时更快）

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r dist-apk\deep-chat-0.2.8-x64-release.apk
```

`-r` 是覆盖安装、保留数据。**签名必须一致** —— 换签名只能先卸载，本地数据会全丢。

---

## 4. 发布签名：私钥只在本机，仓库只存证书指纹

Android 用「包名 + 签名」判定是不是同一个应用。签名一变：

- 已安装的老版本无法覆盖升级（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）；
- 唯一出路是卸载重装，而卸载会清掉本机会话。

所以从 0.2.x 起，**签名永久固定**，但**私钥绝不进仓库**：

| 文件 | 作用 | 是否入库 |
| --- | --- | --- |
| `android/deep-chat.keystore` | 发布私钥（PKCS12，alias `deepchat`，口令 `deepchat-dev`） | ❌ **绝不入库**（`.gitignore`）；只在本机 + 离线备份 |
| `android/keystore.properties` | 签名口令与别名，`build.gradle` 从这里读 | ❌ **绝不入库** |
| `android/release-cert.sha256` | 发布证书 SHA-256 指纹（公开信息），构建与 `verify` 的硬基线 | ✅ 入库 |

证书指纹（`apksigner verify --print-certs`）：

```text
SHA-256: 594829f66ba88b67f8c5b025c45aaa418b58ec31692cf35142c56071088d9401
DN:      CN=Deep Chat, OU=Mobile, O=DeepChat, C=CN
有效期:  10000 天（约 27 年）
```

> **为什么只入库指纹、不入库私钥？**
> 指纹是公开信息，能让构建和自检发现「签名被换掉了」；而私钥一旦入库，
> 任何拿到仓库的人都能签出**能覆盖安装的假更新**。本项目准备公开仓库 / 公开发布
> Release APK，所以私钥必须只留在本机。`pnpm verify` 会检查私钥没有被 git 跟踪、
> 历史里也没有（命中就失败）。

> **最重要的一条：私钥必须有离线备份。**
> 私钥丢失 = 再也发不出能覆盖安装的更新（只能换签名、让所有用户卸载重装）。
> 至少备份两份：密码管理器附件 / 加密 U 盘，并记下 alias `deepchat` 与口令。
> 仓库里的指纹文件只能证明「该用哪把钥匙」，本身救不回签名。

### 4.1 构建时如何防止签名被换

`scripts/build-apk.mjs` 在 release 路径上做三道闸：

1. `keystore.properties` / keystore 缺失 → **直接失败**，不再产出「能编译但装不上」的未签名包；
2. 构建完跑 `apksigner verify --print-certs`；
3. 把实际证书 SHA-256 与 `android/release-cert.sha256` 比对，不一致 → **失败**并提示恢复密钥。

`pnpm verify` 的 B 组同样会比对指纹，并检查私钥未被 git 跟踪，所以「签名被悄悄换掉」
或「私钥误提交」都不可能一路绿灯。

### 4.2 指纹固定之后，升级规则

- **0.2.x → 0.2.y / 0.3.0**：`adb install -r` 或直接点 APK 覆盖安装即可，数据保留。
- **0.1.x → 0.2.x**：早期发布的包用的是另一把密钥（已丢失，无法恢复），这是唯一一次
  需要卸载重装的跨越；从 0.2.0 起签名固定，以后不会再发生。
- 需要保留 0.1.x 的会话时：先在旧版里「设置 → 数据管理 → 下载」把会话导出成 ZIP，卸载重装后导入。

### 4.3 公开发布 Release 时的做法

- **仓库不提交 APK**（`.gitignore` 排除 `*.apk` / `dist-apk/` / `deliver/`）；
  本机构建出签名 APK 后，作为 **GitHub Release 的附件**上传（Release 附件不进入 git 历史）。
- 发布前跑一遍 `pnpm verify`（含私钥未入库检查）与 `pnpm accept`；公开仓库前再确认
  `git log --all --name-only | findstr keystore` 为空。
- **轮换（极不推荐，只在私钥泄漏/丢失时做）**：
  1. 生成新 keystore，更新 `keystore.properties`；
  2. 从新 APK 用 `apksigner verify --print-certs` 取新指纹，写入 `android/release-cert.sha256`；
  3. 版本号升一个 minor，并在发布说明里明确「本次必须卸载重装」；
  4. 老用户导出/导入数据。
- **禁止**通过改 `release-cert.sha256` 去迁就一个错误的 keystore —— 那只是把不一致藏起来。

### 4.4 手工校验签名

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --print-certs `
  dist-apk\deep-chat-0.2.8-x64-release.apk
```

`build-apk.mjs` 在 release 结束时自动跑这一步，并打印指纹。

---

## 5. 哪些地方动了上游代码

**原则：能不改就不改。** 需要改的一律在 `web-patches/` 里，由 `prepare-web.mjs`
以上游原文件为基准重放。三种补丁形态：

1. **注入**：我们的新文件（`web-patches/*.ts` → `web/src/shell/`，`web-patches/mobile/` → `web/src/mobile/`）
2. **锚点插入 / 精确替换**：上游文件里插入带 `mobile-shell:` / `mobile-ui:` 标记的代码段，找不到锚点就报错
3. **整文件 fork**：上游组件需要整文件改写时，fork 放 `web-patches/mobile/overrides/`，
   manifest 记录「基于上游哪个 sha256」；prepare 时三方比对（已是 fork / 仍是上游 / 都不是），
   上游一变就明确失败。详见 [`mobile-ui-spec.md`](./mobile-ui-spec.md) §1。

> 导入链路的性能与内存（真实 32 MB 归档、分块原生桥、根因数据）单独记在
> [`import-performance.md`](./import-performance.md)。

### 5.1 壳层 / 功能补丁（上游 14 个文件，30 处）

| 文件 | 改了什么 | 为什么必须改 |
| --- | --- | --- |
| `src/index.html` | viewport 加 `viewport-fit=cover` | 不加则 `env(safe-area-inset-*)` 恒为 0，刘海会挡内容 |
| `src/main.tsx` | render 前 `await shellReady`；引入移动端样式 | 让加密存储里的 Key 在首屏挂载前就位；移动端 tokens 要在 global.css 之后生效 |
| `src/components/settings/settingsDialogState.ts` | `ensureApiKey()` 增加首启引导判断 | 引导自己管 Key 输入，两套弹窗不能同时出现 |
| `src/services/settings.ts` | Key 的读写走加密存储；内存变量兜底 | **核心安全需求**：Key 不许落 localStorage 明文 |
| `src/services/chat/history/toLocal.ts` | `toSorted()` → `.slice().sort()` | `toSorted` 是 ES2023，鸿蒙 4.3 的 WebView 内核不支持，会直接崩 |
| `src/services/chat/store.ts` | `toReversed()` → `.slice().reverse()` | 同上 |
| `src/services/chat/db.ts` | **新增** 暂存辅助函数（复制现有数据 / 批量写会话 / 定向回填附件 MIME） | 合并导入需要「复制现有数据进暂存」，且不能再用 `getAll` 制造百 MB 级堆峰值 |
| `src/services/chat/backup.ts` | 拆出 `exportHistorySnapshot()`（支持进度回调）；导入改走合并桥 | 自动备份需要不经过队列的快照；导出要画进度；导入要 merge 而非 replace |
| `src/components/settings/SettingsDialog.tsx` | 原生壳的导出改走 `exportHistoryToDevice()`；浏览器保留 blob 下载 | Android WebView 没有 DownloadListener，`<a download>` 是静默 no-op；必须分块写 Documents 并显示进度 |
| `src/services/chat/history/zipReader.ts` | 中央目录解析结果按 `File` 缓存 | 一次导入原本解析 3 遍中央目录（677 条目 × 3），缓存后 1 遍 |
| `src/components/chatInput/useVoiceInput.ts` | 录音失败时补一次原生引导 | 区分「永久拒绝」与普通失败，否则用户被卡在一条看不懂的 toast 上 |
| `src/i18n/zh.ts` `en.ts` | 产品名 + 移动端文案 | 正式客户端不叫 demo；移动端官方文案见 spec §3 |
| `src/components/messages/AssistantMessage.tsx` | 动作栏最左侧插入「本轮消耗」入口（两处：import + JSX） | 官方 App 的数据库图标在最后一条回答下方；组件内部按 `isMobile` 提前返回，桌面端零变化 |

### 5.2 移动端 UI 覆盖层

移动端界面按官方 App 重做，涉及「整文件 fork 的组件 + 新组件」：

| 归属 | 文件 | 说明 |
| --- | --- | --- |
| App | `src/app/App.tsx` `App.module.css` | 抽屉打开时主界面右移；点主界面关抽屉 |
| 会话页 | `src/components/session/{MobileHeader,Welcome,SessionView}.tsx` + css | 移动端换成官方风格，桌面分支不动 |
| 抽屉 | `src/components/sider/Sider.tsx` + `Sider.module.css` | 移动端抽屉换成搜索 + 分组列表 + 账户行 |
| 新组件 | `web-patches/mobile/{common,chatinput,topbar,drawer}/` | 顶栏、输入框、附件面板、按住说话、搜索、图标、logo、tokens |
| 本轮消耗 | `web-patches/mobile/cost/` | 数据库图标入口 + 底部费用面板；峰谷计价、每日抓官方价目、24h 缓存（见 [patches/cost-panel.md](../patches/cost-panel.md)） |

**绝不能做的事**（做了就是返工）：

- 在 `web/src/` 里手工改代码 —— 下次 `prepare-web` 会覆盖，改动丢失
- 给上游加 npm 依赖 —— `web/pnpm-lock.yaml` 会被破，且增大回归面
- 改上游桌面端代码的既有行为 —— 移动端改动只允许出现在 `isMobile` 分支；桌面端必须与改版前一致
- 往 `web-patches/mobile/manifests/` 里写别的 area 的 fork —— 每个 area 一个文件，并行开发靠它隔离

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
| 导出落盘 + 进度 | ✅ 分块写 `Documents/DeepChat/`，失败可重试 | ⚠️ 退化为浏览器 `<a download>`，没有进度浮层与固定目录 |
| 外部打开 ZIP（文件管理器） | ✅ | ❌ |
| 离线启动 | ✅ 资源内置 | ✅ SW 缓存 |
| 语音输入 / 朗读 | ✅ | ✅（需 https） |

**这是有意的降级**：浏览器里没有 Keystore，也无法写 Documents。PWA 是过渡手段，不是等价替代。

---

## 9. 自检清单

发布前跑这四条：

```powershell
pnpm ui:preview    # 移动端 5 屏 + 桌面回归图（人眼对比 UI参考图）
pnpm verify        # 静态硬指标（不需要浏览器）
pnpm accept        # 无头浏览器验收 APK 里的那份产物
pnpm test:import   # 合并导入端到端（真实 IndexedDB）
pnpm test:cost     # 峰谷计价与价目解析（纯函数，60 条断言）
```

### 9.1 `verify`：静态硬指标

覆盖四组：

- **A 构建产物**：viewport、6 个壳能力真的在 bundle 里、CSS 变量、`assets` 与 `dist` 逐字节一致（防「忘了 cap sync 就打包」）
- **B APK 硬指标**：权限白名单、无存储/相机/位置权限、`allowBackup=false`、`usesCleartextTraffic=false`、release 已签名
- **C 安全**：产物无 `sk-` 字面量、keystore 分支先 return（不会回写 localStorage）、原生真用 `EncryptedSharedPreferences`、网络配置不信任用户 CA
- **D 补丁完整性**：全部 `mobile-shell:` / `mobile-ui:` 标记都在位、移动端覆盖层文件已注入、
  fork 与 `web-patches/mobile/overrides/` 逐字节一致（有人手工改回去或 fork 漂移会立刻暴露）

### 9.2 `accept`：运行时验收

无头 Chromium 打开 `android/app/src/main/assets/public/`（**已打包进 APK 的那份**），
注入一个模拟的 `window.Capacitor.nativePromise` 原生桥，验证：

| 场景 | 验的东西 |
| --- | --- |
| A 首次安装（桥返回空 Key） | 页面真的渲染（非白屏）、出现引导层、`__CHAT_DEMO_ONBOARDING__=true`、导入/Key 桥已装、确实向原生读过 Key |
| B 已配好 Key | Key 进入 `window.__RUNTIME_KEY__`、**不**出引导层、标志复位 |
| C 已引导过 | 即使没 Key 也不再弹 |
| D 纯浏览器（无桥） | 正常渲染、零异常、不装壳层专属能力 —— PWA 兜底路径 |
| E 安全区 | `.frame` 锚点仍在、`--shell-inset-*` 是具体 px 而非 `env()` 原文 |
| F 移动端 UI | 鲸鱼 logo、汉堡/朗读/新建对话、官方占位符、深度思考/智能搜索药丸、无 caveat、+ 打开附件面板（拍照/相册/文件）、麦克风切「按住说话」、抽屉搜索框与账户行 |
| F2 原生导出 | 进度浮层可见；成功后显示 `Documents/DeepChat/deep-chat-export-<时间>.zip`；桥调用含 begin/append/finish；失败显示原因且 abort；点重试可重新导出 |
| G 朗读开关 | 朗读中变品牌蓝 + 「停止朗读」，再点回到空闲 |
| H 本轮消耗面板 | 种子会话（命中 1024 / 未命中 3568 / 输出 508，北京周五 20:00）→ 最后一条回答下方出现数据库图标 → 点开显示 `0.00562048 元`、三条用量与金额、「空闲时段」、上下文 0%；Esc 可关；重开面板不再抓价（价目每天只抓一次，缓存 `source=official`） |

### 9.3 `test:import`：63 条断言 / 19 个场景

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
| 10 导出后回导 | 往返一致；导出进度回调单调递增、末值等于会话数；手机导出的 ZIP 还能被桌面端覆盖式导入读取（跨端兼容） |
| 11 真机导入路径 | `importHistory()` 内部入队 + 自动备份不死锁；备份走 begin/append/finish 分块协议 |
| 12 分块读文件 | 外部打开 ZIP 的多块 `readPendingFileChunk` + close 路径完整 |
| 13 暂存辅助函数 | 游标收集附件 MIME、定向回填不影响其他会话 |
| 14 备份失败 | 抛错中止导入、调用 abort 清理、正式会话数不变 |

> **为什么场景 4/5/7 最关键**：它们对应「合并而非替换」这条规格。
> `replaceHistory()` 内部会先 `clearStaging()` 再重建，一旦哪一步写错，
> 用户的历史会话就会在导入成功的外观下被悄悄清掉 —— 这类错误不会报错，
> 只会在几天后被发现「我的对话怎么没了」。

三条命令失败时退出码为 1，可直接接 CI。

### 9.4 `test:cost`：60 条断言

把 `web-patches/mobile/cost/pricing.ts` 用上游 rspack 打成 IIFE，在无头 Chromium 里跑纯函数断言
（找不到浏览器时退化为 Node 执行同一 bundle，并在输出里说明）。覆盖：

- 官方截图那组数字：命中 1024 × 0.02 + 未命中 3568 × 1 + 输出 508 × 4 = `0.00562048`；
- 峰谷边界 8 个（北京 08:59 / 09:00 / 11:59 / 12:00 / 13:59 / 14:00 / 17:59 / 18:00）、周末两个、法定假日一天；
- 真实价目页 `.md` 片段解析出 6 个价格 + 1M 上下文；删掉价格行或改成非数字必须返回 `null`（不产生半张表）；
- 金额/token/单价格式化、上下文占比封顶、缺字段与全 0 usage 的降级。

### 9.5 手工验收（自动化覆盖不到的）

装到真机后逐项过：

- [ ] 首屏正常渲染，无白屏；Markdown / KaTeX 公式 / Mermaid 图正常
- [ ] 移动端 UI 与官方 App 截图一致：欢迎页鲸鱼 logo + 问候语、顶栏（汉堡/朗读/⊕）、圆角输入框 + 药丸 + ⊕/麦克风
- [ ] 输入框「+」打开附件面板：最近图片行、拍照（真机拉起相机）、相册、文件（系统选择器）
- [ ] 麦克风进入「按住说话」：按住说一句、松手出文字；短按提示「说话时间太短」；键盘键切回文字
- [ ] 顶栏喇叭朗读当前会话最后一条回答，再点停止
- [ ] 抽屉：主界面右移露出汉堡；搜索标题与正文都能命中；长按会话行可重命名/删除；底部账户行可进设置/切主题
- [ ] 账户行头像：默认显示 App 图标；点头像从相册选一张 → 立即变成新头像；重启应用后仍是新头像；菜单「恢复默认头像」能回到 App 图标
- [ ] 移动端会话页：标题居中、消息列表与输入框吸底，键盘弹出不遮挡输入框
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
- [ ] 导出：设置 → 数据管理 → 下载 → 出现进度浮层；完成后路径指向 `Documents/DeepChat/deep-chat-export-<时间>.zip`；文件管理器里确认文件存在且大小合理；再导入一次该 ZIP 能合并成功
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

- [mobile-ui-spec.md](./mobile-ui-spec.md) —— 移动端 UI 对齐官方 App 的规格与覆盖层架构
- [install-harmony.md](./install-harmony.md) —— 鸿蒙侧载安装细节
- [`../native/secure-storage/README.md`](../native/secure-storage/README.md) —— 加密存储的威胁模型与 API
- [`../web/src/services/chat/history/README.md`](../web/src/services/chat/history/README.md) —— 上游的归档格式说明
