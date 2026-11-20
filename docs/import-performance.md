# 导入性能与闪退修复（真实归档）

> 范围：合并导入（`web-patches/import-bridge.ts` → 注入到 `web/src/shell/import-bridge.ts`）
> 与原生文件桥（`native/file-open/FileOpenPlugin.java` → 由 `scripts/sync-native.mjs` 同步到 `android/`）。
> 本文的数据来自用户真实历史归档（31.3 MB / 677 个 ZIP 条目 / 593 条会话 / 81 张图片）在无头 Chrome
> 里跑**实际进 APK 的那份 `mergeImport`**，不是小夹具。

## 1. 结论先行

| 指标 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 空库合并 593 条会话 | 4.6–5.5 s（多轮 4639 / 4869 / 5460 ms） | **3.2–3.3 s**（3218 / 3255 ms） | −34% ~ −41% |
| 本机已有 593 条时再导入（含导入前备份） | 11.3 s | **8.0–8.2 s**（7967 / 8205 ms） | −28% ~ −29% |
| 峰值 JS heap（20 ms 采样） | **226.9 MB** | **85.2–102.6 MB**（两次运行） | −55% ~ −62% |
| 备份上传单次跨桥负载 | **69.6 MB base64 字符串** | **≤ 341 KB / 块**（210 块） | 约 1/204 |
| 读入文件（content URI）单次跨桥负载 | 约 44 MB base64 字符串 + Java 32 MB byte[] | ≤ 341 KB / 块 | 约 1/129 |
| 593 条会话的 IndexedDB 事务数 | 593（会话）+ 81（图片） | 约 25 + 6 | 约 1/22 |
| 中央目录解析次数（一次导入） | 3 次 | 1 次 | −67% |

结果正确性：`added + updated + skipped + failed = 593`、`failed = 0`、无 fatal，81 张图片原件全部入库
（`files` 表计数 81）。改后探针完整输出见第 6 节。

## 2. 测量方法

- 探针：`node scripts/real-zip-probe.mjs "<真实 zip>"`。脚本用 rspack 打包 `scripts/probe.entry.ts`，
  在无头 Chrome 里通过 `file://` 之外的本地 HTTP 读入 ZIP，调用 `window.__DEEP_CHAT_IMPORT__.merge(file)`；
  IndexedDB、Blob、File、atob 都是浏览器真实实现。原生桥是**内存桩**：只记录每次调用的方法名与负载
  大小，不落盘、不伪造耗时。
- 耗时口径：`performance.now()` 累计值（`marks` 是「从开始到该节点」的累计毫秒）。
- 峰值 JS heap：`performance.memory.usedJSHeapSize`，每 20 ms 采样一次。没有启用
  `--enable-precise-memory-info`，数值有约 100 KB 的量化误差；**纯同步的瞬时分配峰值可能采样不到**，
  因此本报告的峰值是「采样到的下界」，根因归因结合了分配量估算（第 5 节）。
- 阶段耗时：修复前临时在 `import-bridge.ts` 的每一步包了计时（已移除），下表是空库合并那一轮的读数。

## 3. 根因（改前实测）

空库合并一轮的阶段耗时（累计 / 单步推算）：

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| `checkArchiveFormat()` | 444 ms | 解析中央目录 + 读 manifest |
| `countZipEntries()` | 428 ms | **又解析一遍**中央目录（为了进度总数） |
| `readArchive()` 内部目录解析 | ≈ 400 ms | **第三遍**（正式遍历前） |
| 读 + 解压 593 条会话 JSON | 1262 ms | deflate 解压 + 拼 Blob → text |
| `putStagingSession()` × 593 | 341 ms | 593 个独立 IndexedDB 事务 |
| 读 + 保存 81 张图片 | 292 + 96 ms | 81 个独立事务 |
| `collectStagingFileTypes()`（getAll） | 122 ms | **堆峰值主因**，见下 |
| `updateStagingFileTypes()`（全量扫） | 154 ms | 再读一遍全部暂存会话 |
| 其余（JSON.parse/转换、commitStaging、账本、摘要） | ≈ 1.7 s | 无法再拆细 |

### 根因 A：`collectStagingFileTypes` 用 `getAll('sessionsStaging')` 制造 227 MB 堆峰值

上游的 `updateStagingFileTypes(types)` 会把「映射里没有的附件 MIME」清成空字符串，合并导入必须先
收集暂存里已有附件的 MIME。第一版实现直接 `getAll('sessionsStaging')`：593 条会话、35 MB JSON
**一次性反序列化成 JS 对象**，叠加 IDB 内部的中间副本，实测采样峰值 **226.9 MB**。
低端 Android WebView 的 JS 堆上限通常 128–256 MB —— 这正是「导入时应用直接关闭（闪退）」的
首要嫌疑。桌面 Chrome 有 4 GB 上限所以不崩，只是慢。

### 根因 B：导入前备份把整包 ZIP 转成一个 44–69 MB 的 base64 字符串

`backupBeforeImport()` 先 `exportHistorySnapshot()` 生成 52.2 MB 的 ZIP，再 `toBase64(blob)` 得到
**69,731,128 字符（69.6 MB）的字符串**作为一次 `saveBackup` 的入参：

- JS：52 MB Blob + 69.6 MB base64 字符串 + 跨桥序列化的再一份拷贝；
- WebView → Native：一次巨大的 JSON 参数；
- Java：再解出 52 MB `byte[]` 写盘。

同一时刻三方都要峰值内存，低端机必炸。改前探针记录到的单次桥负载就是 69.6 MB，且这还不含
WebView 桥自己的 JSON 序列化副本。

### 根因 C：读入外部 ZIP 同样是整包 base64

`getPendingFile` 把 content URI 整个读成 `byte[]`（32 MB），再 `Base64.encodeToString` 成约
44 MB 字符串交给 WebView。Java 侧峰值 = `ByteArrayOutputStream` 扩容副本 + 32 MB 数组 + 44 MB
字符串；JS 侧 = 44 MB 字符串 + `atob` 出的 32 MB 数组 + 32 MB Blob。**读入和备份两个方向各有一处
44 MB+ 的字符串**，是闪退的两个独立触发点。

### 根因 D：中央目录被解析三遍

一次导入里 `checkArchiveFormat()`、`countZipEntries()`、`readArchive()` 各调用一次
`readDirectory(file)`。677 个条目约等于 2–3 千次「读 46 字节头 / 文件名 / extra」的小块异步 File 读取，
桌面端一遍约 0.4 s，手机上更贵。

### 根因 E：主线程没有让出点，进度条画不出来

593 次 `putStagingSession` 之间虽然有 `await`，但 IndexedDB 回调与 Promise 微任务之间不保证浏览器
拿到渲染帧。导入期间进度条可能整段不动 —— 用户看到的就是「卡死」，与真正的卡死无法区分。

## 4. 修复清单

### 4.1 `collectStagingFileTypes` 改游标遍历（`scripts/prepare-web.mjs` 的 db.ts 补丁）

- 新实现用 `tx.store.openCursor()` 逐条读，同一时间只持有一条会话，峰值与「最大的单条会话」
  成正比，与总条数无关。
- 更关键的是合并主流程**不再调用它**：新增 `updateStagingImageTypes(types, sessionIds)`，只对
  「本次新写入、且带图片」的会话回填 MIME。现有会话是整条复制进暂存的，MIME 原样保留，不需要
  全量扫描；导入会话的附件 MIME 初始就是 `''`，只有图片原件需要补。结果与全量扫描等价，读取量
  从 593 条降到「带图片的会话数」。
- 另保留 `collectStagingFileTypes()` 作为独立入口，并在测试里覆盖（场景 13）。

### 4.2 修复 `putStagingSessions` 批量写库（db.ts 补丁）

- 新增 `putStagingSessions(sessions)`：一个批次一个事务，调用方按 24 条一批提交。
- 事务语义不变：批写失败直接抛错中止整个导入；原子替换点仍是上游的 `commitStaging()`，暂存写失败
  不会动正式数据。
- 图片同样分批：单批 ≤ 16 张或 ≤ 4 MB（图片单张最大 0.9 MB），一个批次一个事务。
- 每批之后 `setTimeout(0)` 让出主线程（`yieldToPaint()`），进度条才有机会绘制。

### 4.3 备份改分块上传（JS + 原生）

JS（`backupBeforeImport`）：`beginBackup({fileName})` → 每 256 KB `blob.slice()` → `toBase64`
→ `appendBackupChunk({uploadId, data})` → `finishBackup({uploadId})`。失败时 `abortBackup` 并
继续抛出（备份失败就不允许动数据）。

原生（`FileOpenPlugin`）：`beginBackup` 只在 `getCacheDir()/deepchat-backup/` 建临时文件，
`finishBackup` 才 flush/close 并**流式**复制到 Documents（API 29+ MediaStore + `IS_PENDING`；
API 24–28 应用专属目录）。成功或失败都会删临时文件；MediaStore 插入失败会删除已插入的
pending 项，不会留下半截备份；`handleOnDestroy` 兜底清理所有未完成的句柄与临时文件。

### 4.4 读入外部 ZIP 改分块读取（JS + 原生）

原生提供 `openPendingFile` / `readPendingFileChunk` / `closePendingFile`：
`openPendingFile` 取走并清空待处理 URI，但**句柄里保留 content URI**；`readPendingFileChunk`
顺序读时复用同一个 `InputStream`，只有 offset 不连续（或流在异常后丢失）时才重新
`openInputStream` + `skipFully`，因此不会出现「每块重新打开 + 全量 skip」的 O(n²) 拷贝。
JS 侧逐块 `atob` → `new Blob([bytes])` → 丢掉 Uint8Array，最终 `new Blob(parts)` + `new File`，
Blob 字节不进 JS 堆。

### 4.5 中央目录只解析一次（zipReader 补丁）

`readDirectoryCached(file)` 用 `WeakMap<File, Promise<...>>` 缓存解析结果，`countZipEntries` 与
`readArchive` 都改用它。File 是不可变 Blob，按对象缓存不会读到过期内容；WeakMap 随 File 回收。
`checkArchiveFormat()`（上游实现）内部调用的 `readArchive` 因此也命中缓存。

### 4.6 进度

- 备份阶段按**字节**上报（`done/total = 已上传/总大小`），块间让帧；
- 读取外部文件阶段按字节上报；
- 合并阶段仍按 ZIP 条目数上报（真实百分比，来自中央目录）；
- `import-ui.ts` 原有用 rAF 合并更新的逻辑保持不变，配合新增的让出点即可正常绘制。

## 5. 内存上界估算

改后单次导入（593 条会话 / 81 图）的 JS 侧峰值构成：

| 部分 | 量级 | 说明 |
| --- | --- | --- |
| 单条会话 JSON 文本 + 解析对象 | 数百 KB ~ 数 MB | 逐条处理，批写 24 条 ≈ 1–2 MB |
| 图片 Blob（暂存/提交） | 与图片总量相关（本次 20.5 MB） | Blob 字节通常不算 JS 堆，但占进程内存 |
| 分块读/写载荷 | 256 KB + 341 KB 字符串 | 单块上限，与文件总大小无关 |
| 基线常驻 | 数 MB | 账本、摘要 Map、进度 DOM |

实测采样峰值 85.2–102.6 MB（两次运行；改前 226.9 MB）。该数值是**采样下界**且 Chrome 的 GC 在
4 GB 上限下比较懒；真机堆上限更小，GC 会更早介入，实际峰值通常低于桌面采样值。但请注意：
`exportHistorySnapshot()` 仍会先在内存里生成整份备份 ZIP（本次 52.2 MB Blob），这一步的内存上界
仍与「本机数据量」成正比，只是不再额外产生 69.6 MB base64 字符串与跨桥副本。

原生侧（Java）单次调用峰值：

| 方向 | 改前 | 改后 |
| --- | --- | --- |
| 读入 32 MB ZIP | `ByteArrayOutputStream`（扩容峰值可达 ~64 MB）+ 32 MB byte[] + 44 MB base64 String | 256 KB byte[] + 341 KB base64 String |
| 写出 52 MB 备份 | 52 MB byte[] + 44–70 MB base64 String | 临时文件（磁盘）+ 64 KB 复制缓冲 + 256 KB 解码块 |

## 6. 原生方法契约

插件名 `DeepChatFiles`；`native/file-open/README.md` 有同样的表格与更多实现说明。

### 读入

| 方法 | 入参 | 返回 | 错误 |
| --- | --- | --- | --- |
| `hasPendingFile` | — | `{pending: boolean}` | 不会失败 |
| `openPendingFile` | — | `{handle, name, size}` 或 `{name: null}`；`size = -1` 表示未知 | 大小 > 48 MB → reject |
| `readPendingFileChunk` | `{handle, offset, length}`，`1 ≤ length ≤ 262144` | `{data: base64, size, offset, eof}` | 句柄不存在 / offset 越界 / length 非法 / 文件被截断 / 累计 > 48 MB → reject |
| `closePendingFile` | `{handle}` | `{closed: boolean}` | 幂等，不会 reject |

- `openPendingFile` 取走后清空待处理 URI，保证同一个文件不会被处理两次；句柄里的 URI 仍可多次打开。
- `readPendingFileChunk` 读失败会自行丢弃句柄；JS 在 `finally` 里再 close（幂等）。
- `data` 使用 `Base64.NO_WRAP`，否则默认编码器每 76 字符插换行，`atob` 会解错。
- 未知大小时由 JS 循环到 `eof`/`size = 0`，原生用累计字节数兜底 48 MB 上限。

### 写出

| 方法 | 入参 | 返回 | 错误/清理 |
| --- | --- | --- | --- |
| `beginBackup` | `{fileName}` | `{uploadId}` | 文件名含路径分隔符或 `..` → reject；目录建不出 → reject |
| `appendBackupChunk` | `{uploadId, data: base64}` | `{written: 累计字节}` | uploadId 不存在 / 空 data / 累计 > 256 MB → reject，并关闭+删除临时文件 |
| `finishBackup` | `{uploadId}` | `{path}` | 写 Documents 失败 → reject；无论成败临时文件都删除；MediaStore pending 项会回滚删除 |
| `abortBackup` | `{uploadId}` | `{aborted: boolean}` | 幂等：未知 uploadId 也 resolve（供 catch 清理） |

- 临时文件固定在 `getCacheDir()/deepchat-backup/`，`finishBackup` 才落 Documents。
- 单文件读取上限 **48 MB** 保留；备份上传另设 **256 MB** 上限防异常调用写满缓存。

## 7. 回归与验证

```powershell
node scripts/prepare-web.mjs                 # 重放补丁 → web/src
node scripts/sync-native.mjs                 # native/ → android/（写入 1 个文件）
npx tsc -p web/tsconfig.json --noEmit        # 通过
pnpm test:import                             # 55/55 passed
node scripts/real-zip-probe.mjs "<真实 zip>"  # 593 added / failed 0 / 81 图入库
```

`pnpm test:import` 新增/更新的回归：

- **场景 11**：真机路径 `importHistory()` 不死锁；备份走 `beginBackup → appendBackupChunk → finishBackup`，
  分块大小 ≤ 256 KB。
- **场景 12**：内存 ZIP 通过分块桥桩（`openPendingFile / readPendingFileChunk / closePendingFile`）
  逐块喂给真实的 `consumePendingFile()`，300 KB 正文导致多块读取，导入后正文长度一致；同一路径下的
  备份也走分块协议。
- **场景 13**：`putStagingSessions` 批量写 + `collectStagingFileTypes` 游标收集 +
  `updateStagingImageTypes` 定向回填。
- **场景 14**：备份分块上传中途失败 → `abortBackup` 被调用、导入中止、正式会话数不变。

真实归档探针改后关键输出（节选，最后一轮）：

```jsonc
{
  "marks": {
    "2_mergeImportEmptyDb": 3255,
    "3_mergeImportPopulatedDb": 8205,
    "5_loadList": 8229
  },
  "heap": { "peakUsed": 89371418 },                   // 85.2 MB（另一轮 102.6 MB）
  "native": {
    "legacyBackupBase64": 0,                          // 不再有整包 base64
    "chunkMax": 349528,                               // 单块 base64 字符串 ≤ 341 KB
    "chunkCount": 210,
    "backupBytes": 54699072,
    "backupFinished": true
  },
  "result": { "added": 593, "failed": 0 },
  "storedFiles": 81
}
```

## 8. 剩余限制与风险

1. **没有真机验证**：本文所有数字来自桌面无头 Chrome。Android WebView 的 IndexedDB 落盘、
   `setTimeout(0)` / rAF 节流、GC 行为都可能不同；低端机上的绝对耗时会更长（趋势应一致）。
2. **Java 内存无法本地验证**：本机没有跑 APK 构建与 `adb` 内存采样。改后的 Java 峰值是按代码路径
   估算的「单块量级」，最终仍需 Lead 在真机/模拟器上用 APK 构建 + `adb shell dumpsys meminfo` 验证。
   编译验证也留给最终 APK 构建。
3. **备份导出本身仍是全量内存 ZIP**：`exportHistorySnapshot()`（上游 `exportArchive` + `writeArchive`）
   会把整份备份先建成 Blob（本次 52.2 MB）。分块上传消除了「base64 + 跨桥副本」，但「本机数据量
   决定导出峰值」这一点没有变；本机会话特别多时仍可能吃紧。彻底解决需要流式导出（上游改动），
   不在本次范围。
4. **JSON 解析仍在主线程**：593 条会话的 `JSON.parse` / 字段校验 / 树重建无法在本次拆到 Worker
   （上游代码耦合 DOM 无关但依赖同步返回），大归档下仍有秒级主线程占用。批间让帧保证进度条能画，
   但界面响应会有卡顿感。
5. **原生端未知大小的 content URI**：少数 provider 不返回 size，只能按块读到 EOF，并用累计字节数
   兜底 48 MB 上限；导入进度在读完之前是「已读 N 字节」而非百分比。
6. **非顺序读的兜底成本**：若调用方要求乱序 offset，原生会重新打开并 skip 到目标位置（保证
   content URI 可多次打开的正确性）。当前 JS 只做顺序读，所以走不到这条路径；未来扩展读取方式时
   需要注意别退化成 O(n²)。
7. **桌面端不受影响**：浏览器 / PWA 没有原生桥，仍走上游的覆盖式导入；本次改动只在
   `isNativeShell()` 为真的 APK 路径生效。

## 9. 0.2.5：合并提交、账本 v2 与按需备份

0.2.1 的优化把导入从「闪退 + 分钟级」压到桌面 3.2 s，但真机仍然慢：前面的校验要等很久，
随后大约「一秒一条」。0.2.5 又做了五处改动，完整理由见
[`../patches/import-speed.md`](../patches/import-speed.md)。

| 变化 | 说明 |
| --- | --- |
| 中央目录整读 | 677 条目 × 3~4 次小块读 → 1 次整读；`checkArchiveFormat` 444 ms → **14 ms** |
| 条目头整读 | 本地头 + 文件名一次读，`extra` 非空才再读 |
| 会话字节直读 | 新增 `readEntryBytes()`，不再为每条会话造 8 KB Blob 串 |
| 增量提交 | `commitMergeStaging()` 只写「本次导入」，不再复制并集 / 清空正式表 |
| 账本 v2 | 键改为 `id\|CRC\|大小`，命中即 `discard()`（不 inflate、不 parse、不写库） |
| 备份按需 | 先解析再决定备份；本机无会话/无新增/上次备份后数据未变/用户关闭 → 跳过 |
| 备份批量读 | 600 次 `loadSession` 单条事务 → 约 24 个批量事务 |
| 1 MB 分块 | 备份上传/外部文件读取的桥往返少 4 倍 |
| 让帧 + 常亮 | `MessageChannel` 让出（后台不被钳到 1 s）+ `navigator.wakeLock` |
| 进度 UI | 去掉全屏 `backdrop-filter`、更新限频 12 Hz、结果显示阶段耗时 |

同一归档（31.3 MB / 677 条目 / 593 会话 / 81 图）在桌面无头 Chrome 的前后对比：

| 指标 | 0.2.4 | 0.2.5 |
| --- | --- | --- |
| 格式校验 | 444 ms | 14 ms |
| 空库导入 593 条 | 3218 / 3255 ms | 3206 / 3244 ms |
| 已有 593 条时重复导入（全部已导入过） | 7967 / 8205 ms | 917 / 950 ms |
| 重复导入实际解压解析的会话数 | 593 | 0 |
| 峰值 JS heap | 85.2–102.6 MB | 73.6 MB |

空库导入没有明显变快：它的时间主要花在解压 + `JSON.parse` + 严格校验 + 树重建上，
这部分是数据完整性检查，0.2.5 没有砍。重复导入（用户最常遇到的场景）从 8.2 s 降到 0.95 s。

### 9.1 Android 模拟器实测（MuMu，API 32，同一 32.8 MB 归档）

> 注意：此前文档里写的「真机 HONOR BVL-AN16 / HarmonyOS 4.3」是错的 —— 那是 Android 模拟器
> （MuMu，设备档案名 BVL-AN16），系统是 Android 12 / API 32。下面的数字只代表模拟器。

| 场景 | 0.2.5 中间版本 | 0.2.5 最终 | 组成（最终） |
| --- | --- | --- | --- |
| 空库首次导入 593 条 | 42.9 s | 4.1 s | 读取 126 ms + 校验 27 ms + 解析 2.9 s + 写入 1.2 s |
| 已有 593 条时重复导入 | 36.3 s | 1.6 s | 读取 112 ms + 校验 41 ms + 解析 1.5 s + 写入 0.14 s |

「中间版本」指已经做了账本 v2 / 增量提交，但还没加「一次性读入内存」的构建。第二轮的 36 s
全部花在跳过已导入会话上，暴露出大头：**Android 文件选择器给的是 `content://` 流，
每次 `File.slice().arrayBuffer()` 都会重新 open + seek，几十次小块读退化成 O(n²) 的
provider 读取**。0.2.5 的 `materializeArchive` 只在 ≤ 48 MB 时生效。

### 9.2 用户真机（截图反馈，0.2.5，594 条，同一份导出）

| 场景 | 读取 | 校验 | 解析 | 写入 | 合计 |
| --- | --- | --- | --- | --- | --- |
| 首次导入（空库） | 6 ms | 88 ms | 96.1 s | 8.2 s | 104.4 s |
| 增量导入（全部已导入） | 4 ms | 90 ms | 75.2 s | 231 ms | 75.6 s |

第二行是决定性证据：**没有解析任何会话、也没有写暂存/提交**（结果页写明「其中 594 条已导入过，
未重新解析」），却仍花 75.2 s。时间不在 JSON/转换/事务上，而在逐条目读 ZIP 本身。
`读取 4 ms` 又说明 `materializeArchive` 没执行 —— 即用户的归档 **> 48 MB**，0.2.5 的读取修复
等于没生效；0.2.4「一秒一条」也正是同一个随机读退化（当时还有每条一个事务的放大）。

### 9.3 0.2.6：读取上限放开 + 事务合并

- `materializeArchive`：≤ 128 MB 用 `arrayBuffer()` 一次读入；128–256 MB 用 `file.stream()`
  收进 Blob 分片；原生「用其他应用打开」的 File 已在内存，跳过拷贝。
- 事务数：会话暂存 24 条/批 → 8 MB / 250 条（按先到者）；图片 4 MB/16 → 16 MB/64。
- 结果页开始显示 ZIP 大小、读取方式、解析子桶（解压/JSON/转换/写暂存/图片）与事务次数。

用 51.0 MB 合成归档（250 条 × 约 213 KB）在模拟器上验证（该归档超过 0.2.5 的 48 MB 上限，
正好复现用户场景）：

| 场景 | 0.2.5 | 0.2.6 |
| --- | --- | --- |
| 首次导入（空库） | 11.3 s（读取 5 ms，解析 10.4 s） | **2.6 s**（读取 185 ms，解析 1.6 s，暂存 7 次） |
| 增量导入（全部已导入） | 8.8 s（解析 8.6 s） | **0.72 s**（解析 0.48 s，读取 172 ms） |

真机（用户的 594 条归档）复测数据待用户安装 0.2.6 后补；预期主要收益在读取路径，
首次导入的剩余时间会是「解压 + JSON + 转换 + 写暂存」。

真机上的阶段耗时由导入结果页直接显示（读取 / 校验 / 解析子桶 / 备份 / 写入 / ZIP 大小 /
读取方式 / 事务次数），也可以从 `adb logcat -s Capacitor/Console` 里筛 `[import-perf]`
拿到同样的 JSON —— 排查「慢在哪」不需要再连电脑调试 WebView。
