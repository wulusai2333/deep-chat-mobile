# DeepChatFiles —— 文件出入插件

负责两件方向相反的事：

1. **出**：把导入前的自动备份写到系统 `Documents/`（网页写不了那里）
2. **入**：接收「用其他应用打开 ZIP」传进来的文件（网页读不到 `content://` URI）

---

## 为什么必须用原生

### 写备份：网页没有可写的位置

- `showSaveFilePicker()`：WebView 里不可用（Chrome 桌面版才有）
- `<a download>`：会落到 `Download/` 且需要用户二次确认，无法静默
- IndexedDB / localStorage：不是「能拿出去的文件」，卸载即失

要写到 `Documents/DeepChat/` 让用户能在文件管理器里找到，只有原生能做。

### 读外部 ZIP：WebView 拿不到 content URI

文件管理器「用其他应用打开」传过来的是 `content://` URI。
WebView 的 JS 层没有 API 能把它变成 `File`/`Blob`。
必须原生读取字节 → base64 → 传给 JS → JS 重建 `File`。

---

## 权限：一个都不要

两条路径都不需要存储权限：

| 操作 | 机制 | 需要的权限 |
| --- | --- | --- |
| 写备份 | Android 10+：`MediaStore.Downloads`/`Documents` 插入 | **无**（分区存储下写自己创建的文件不需权限） |
| | Android 7–9：应用专属外部目录 `getExternalFilesDir()` | **无**（专属目录不需权限） |
| 读外部 ZIP | SAF 传进来的 URI + `grantUriPermission` | **无**（URI 授权代替了权限） |
| 应用内选 ZIP | `<input type="file">` → `BridgeWebChromeClient.showFilePicker` → SAF | **无** |

所以 manifest 里没有任何 `READ_/WRITE_EXTERNAL_STORAGE`，`pnpm verify` 会检查这一点。

---

## API

插件名：`DeepChatFiles`。读写两个方向都走**分块协议**（单块 ≤ 256 KB），
不再有「整包 base64 一次过桥」的方法 —— 32 MB 归档整包 base64 是 44 MB 字符串，
WebView 桥与 Java 堆都要再复制一遍，低端机会直接 OOM 闪退，即使不崩也要好几秒。

### 读入：`hasPendingFile` / `openPendingFile` / `readPendingFileChunk` / `closePendingFile`

```ts
// 1) 有没有「外部打开」传进来、还没被取走的文件。只读，不清除。
hasPendingFile() → { pending: boolean }

// 2) 取走并建立读句柄。取走后 clear pendingUri，但句柄里的 content URI 仍可多次打开。
openPendingFile() → { handle: string, name: string, size: number } | { name: null }
//   size 未知时为 -1；> 48 MB 直接 reject

// 3) 逐块读。length ≤ 262144（256 KB），offset 从 0 开始按返回的 size 前进。
readPendingFileChunk({ handle, offset, length }) → {
  data: '<base64>',   // 本块原始字节，NO_WRAP
  size: number,       // 本块字节数；0 表示已到结尾
  offset: number,
  eof: boolean,
}

// 4) 释放句柄。幂等：句柄不存在也 resolve。
closePendingFile({ handle }) → { closed: boolean }
```

错误语义：句柄不存在、offset 越界、length 非法（0 或 > 256 KB）、文件被截断、
实际大小超过 48 MB 都会 reject；读失败时原生自行丢弃句柄，JS 侧在 `finally`
里再 close 一次（幂等，不会二次抛错）。

### 写出：`beginBackup` / `appendBackupChunk` / `finishBackup` / `abortBackup`

```ts
beginBackup({ fileName }) → { uploadId }
//   在 getCacheDir()/deepchat-backup/ 建临时文件；fileName 的 / \ 会换成 _，含 .. 拒绝

appendBackupChunk({ uploadId, data: '<base64>' }) → { written: 累计字节数 }
//   单块 ≤ 256 KB；累计 > 256 MB 会被拒绝并自动清理

finishBackup({ uploadId }) → { path }
//   flush + close 临时文件，再流式落到 Documents（API 29+ MediaStore，API 24–28
//   应用专属目录）；成功或失败都会删除临时文件；MediaStore 插入失败会删掉 pending 项，
//   Documents 里不会出现半截备份

abortBackup({ uploadId }) → { aborted: boolean }
//   关闭并删除临时文件；幂等（未知 uploadId 也 resolve），供 JS 的 catch 清理路径调用
```

- `fileName` 里的 `/` `\` 会被替换成 `_`，含 `..` 直接拒绝（防路径穿越）
- API 29+ 走 `MediaStore`：`RELATIVE_PATH = Documents/DeepChat`，
  用 `IS_PENDING` 1→0 保证别的应用不会读到写了一半的文件
- API 24–28 走 `getExternalFilesDir(DIRECTORY_DOCUMENTS)/DeepChat`，
  返回绝对路径（那个目录在文件管理器里通常看不见，需要 adb 访问）
- 原读取路径的 **48 MB 上限**保留；备份上传另设 **256 MB** 上限，防止异常调用写满缓存

### 为什么 `hasPendingFile` 与 `openPendingFile` 分开

`hasPendingFile` 很轻（只判空），网页在每次回到前台时都可以问一次；
`openPendingFile` 会建立句柄并清理待处理状态，只在确认有文件时才调。

### 为什么句柄保留 Uri 而不是只保留打开的流

content URI 的读权限来自 Intent 授予，取走后仍然有效。句柄同时保留 Uri 与当前流：
顺序读时直接续读；只有调用方要求非顺序 offset（或流在异常后被关闭）时才重新
`openInputStream` + 完整 skip 到目标位置 —— 这样即使页面被系统暂停、流状态丢失，
也能从任意 offset 继续读，且不会每块都重新打开 + skip（那是 O(n²) 拷贝）。

---

## 「外部打开 ZIP」是怎么接上的

三个环节缺一不可：

### 1. Manifest 的 intent-filter

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <!-- scheme 与 mimeType 必须在同一个 <data> 里（AND 关系）。
         分成两个 <data> 会变成 OR，等于把自己注册成「任何 content:// 都能打开」 -->
    <data android:scheme="content" android:mimeType="application/zip" />
    <data android:scheme="content" android:mimeType="application/x-zip-compressed" />
    ...
</intent-filter>
```

> **踩过的坑**：一个 `<data>` 内部的属性是 **与**，多个 `<data>` 之间是 **或**。
> 早期写法把 `scheme` 和 `mimeType` 拆成两个 `<data>`，结果应用变成了万能内容查看器。

### 2. `MainActivity` 捕获 Intent

`onCreate` 与 `onNewIntent` 都要处理（冷启动 / 应用已在后台）。

因为 `onCreate` 早于插件实例化，没有实例可调，所以用**静态字段**传递：

```java
FileOpenPlugin.setPendingUri(uri);
```

同时必须 `grantUriPermission`：Intent 带来的读权限默认只给 Activity，
进程内其他地方读会被拒。

### 3. 网页轮询

`web-patches/import-bridge.ts` 的 `consumePendingFile()`：

- 启动后查一次（由 `shell.ts` 在引导结束后触发）
- 之后每次 `visibilitychange → visible` 再查（热启动场景）

用轮询而非原生推事件：`onResume` 在 Capacitor 里没有稳定的 JS 事件；
而静态字段本来就只能主动问。一次 IPC 的成本远低于维护监听器的生命周期
（页面可能被系统连杀几次）。

---

## 实现要点

- **单块 ≤ 256 KB**：一次桥调用的 base64 字符串约 341 KB，WebView 的 JSON 参数、
  Java 的 byte[] 与 String 都只在这个量级上分配；整包 32 MB 的做法会同时产生
  32 MB byte[] + 88 MB base64 String，是闪退的直接原因
- **48 MB 上限保留**：文件大小优先从 `OpenableColumns.SIZE` 查，查不到再用
  `AssetFileDescriptor.getLength()`；都拿不到就按块读到 EOF，并用累计字节数兜底
- **临时文件先写缓存**：`beginBackup` 只建 `getCacheDir()/deepchat-backup/backup-*.part`，
  `finishBackup` 才流式落到 Documents；失败/取消由 `abortBackup` 与 `handleOnDestroy`
  删除，不会留下半截备份
- **`DISPLAY_NAME` 从 `OpenableColumns` 取**：直接 `uri.getLastPathSegment()` 拿到的是
  一串数字 id，不是文件名
- **base64 用 `Base64.NO_WRAP`**：默认编码器每 76 字符插换行，JS 的 `atob` 会解错

---

## 测试

```powershell
# 1. 造一个合法的会话 ZIP（从应用内导出即可）
# 2. 推到手机
adb push deepseek_data-<日期>.zip /sdcard/Download/

# 3. 模拟「用其他应用打开」
adb shell am start -a android.intent.action.VIEW `
  -d content://com.android.providers.downloads.documents/document/1 `
  -t application/zip -n com.deepchat.app/.MainActivity

# 4. 看有没有接住
adb logcat -s Capacitor/Console:V Capacitor:V

# 5. 确认备份写出来了
adb shell ls -l /sdcard/Documents/DeepChat/
```

往 `Downloads` 里查也能看到：`adb shell content query --uri content://media/external/downloads`。
