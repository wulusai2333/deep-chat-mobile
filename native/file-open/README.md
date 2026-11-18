# ChatDemoFiles —— 文件出入插件

负责两件方向相反的事：

1. **出**：把导入前的自动备份写到系统 `Documents/`（网页写不了那里）
2. **入**：接收「用其他应用打开 ZIP」传进来的文件（网页读不到 `content://` URI）

---

## 为什么必须用原生

### 写备份：网页没有可写的位置

- `showSaveFilePicker()`：WebView 里不可用（Chrome 桌面版才有）
- `<a download>`：会落到 `Download/` 且需要用户二次确认，无法静默
- IndexedDB / localStorage：不是「能拿出去的文件」，卸载即失

要写到 `Documents/ChatDemo/` 让用户能在文件管理器里找到，只有原生能做。

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

插件名：`ChatDemoFiles`

### `saveBackup({ fileName, data })`

把 base64 编码的 ZIP 写到系统文档目录。

```ts
// 请求
{ fileName: 'chat-demo-backup-20261118-193000.zip', data: '<base64>' }
// 响应
{ path: 'Documents/ChatDemo/chat-demo-backup-20261118-193000.zip' }  // 或 API 24-28 的绝对路径
```

- `fileName` 里的 `/` `\` 会被替换成 `_`，含 `..` 直接拒绝（防路径穿越）
- 上限 **48 MB**，超了抛错
- API 29+ 走 `MediaStore`：`RELATIVE_PATH = Documents/ChatDemo`，
  用 `IS_PENDING` 1→0 保证别的应用不会读到写了一半的文件
- API 24–28 走 `getExternalFilesDir(DIRECTORY_DOCUMENTS)/ChatDemo`，
  返回绝对路径（那个目录在文件管理器里通常看不见，需要 adb 访问）

### `hasPendingFile()`

```ts
{ pending: boolean }
```

有没有「外部打开」传进来、还没被取走的文件。**只读，不清除。**

### `getPendingFile()`

```ts
{ name: string, data: '<base64>' }   // 有
{ name: null }                       // 没有
```

取走并**清空**待处理 URI（取一次就消费掉，避免重复导入）。

### 为什么 `hasPendingFile` 与 `getPendingFile` 分开

`hasPendingFile` 很轻（只判空），网页在每次回到前台时都可以问一次；
`getPendingFile` 要读整个文件并 base64 编码（可能几十 MB），只在确认有文件时才调。

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

- **48 MB 上限**：base64 会放大 4/3，48 MB 原始 ≈ 64 MB 字符串。再大 WebView 传参会爆。
  会话 ZIP 正常在几百 KB 到几 MB，48 MB 已很宽松
- **64 KiB 分块读**：`readAll()` 逐块读，避免一次性分配大数组
- **`DISPLAY_NAME` 从 `OpenableColumns` 取**：直接 `uri.getLastPathSegment()` 拿到的是
  一串数字 id，不是文件名
- **base64 用 `Base64.NO_WRAP`**：默认编码器每 76 字符插换行，JS 的 `atob` 会解错

---

## 测试

```powershell
# 1. 造一个合法的会话 ZIP（从应用内导出即可）
# 2. 推到手机
adb push deepseek_data-20261118.zip /sdcard/Download/

# 3. 模拟「用其他应用打开」
adb shell am start -a android.intent.action.VIEW `
  -d content://com.android.providers.downloads.documents/document/1 `
  -t application/zip -n com.example.chatdemo/.MainActivity

# 4. 看有没有接住
adb logcat -s Capacitor/Console:V Capacitor:V

# 5. 确认备份写出来了
adb shell ls -l /sdcard/Documents/ChatDemo/
```

往 `Downloads` 里查也能看到：`adb shell content query --uri content://media/external/downloads`。
