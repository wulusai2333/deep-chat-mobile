package com.deepchat.app.plugins;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 文件相关的两件事：保存备份 ZIP、接收外部 ZIP。
 *
 * <p>【为什么走分块，而不是「整包 base64 一次过桥」】
 * 32 MB 的历史归档转成 base64 是 44 MB 字符串。旧实现一次把整包塞进
 * {@code PluginCall}，峰值内存要同时容纳：Java 的 byte[]（32 MB）+ base64 字符串
 * （44 MB，且 String 是 UTF-16，实际约 88 MB）+ WebView 侧的 JSON 拷贝与 JS 字符串
 * （44 MB）—— 低端机（128–256 MB 堆）在这里直接 OOM 闪退；即使不崩，
 * 一次 44 MB 的字符串跨桥也要好几秒。
 *
 * <p>现在两个方向都改成 256 KB 一块：
 * <ul>
 *   <li><b>读入</b>：{@link #openPendingFile} 只返回 handle / name / size，
 *       {@link #readPendingFileChunk} 每块 ≤ 256 KB（base64 约 341 KB 字符串），
 *       JS 侧逐块拼 Blob，{@link #closePendingFile} 释放句柄。</li>
 *   <li><b>写出</b>：{@link #beginBackup} 先在应用缓存里建临时文件，
 *       {@link #appendBackupChunk} 逐块追加，{@link #finishBackup} 再流式落到 Documents，
 *       {@link #abortBackup} 删除临时文件。失败时不会留下半截备份。</li>
 * </ul>
 * 单文件上限仍是 48 MB；备份上限 256 MB（防止异常调用把缓存写满）。
 *
 * <p>【为什么不需要任何存储权限】
 * <ul>
 *   <li><b>保存</b>：API 29+ 走 MediaStore（分区存储），写入公共 Documents 无需权限；
 *       API 24–28 走应用专属外部目录（{@code Android/data/<pkg>/files/Documents}），
 *       同样无需权限。</li>
 *   <li><b>读取</b>：外部传进来的 ZIP 用 ContentResolver 打开 URI 流，
 *       SAF 已经授予了单文件临时权限，不需要 READ_EXTERNAL_STORAGE。</li>
 *   <li><b>导入</b>：用户主动选文件走 {@code <input type="file">}，
 *       Capacitor 的 showFilePicker 会拉起系统文件选择器，同样是 SAF。</li>
 * </ul>
 *
 * <p>【冷启动 vs 热启动】
 * 应用可能因为「用文件管理器打开 ZIP」而被拉起（冷启动），也可能在后台被唤醒
 * （热启动，走 onNewIntent）。两条路径都把 URI 存进 {@link #pendingUri}，
 * 由网页在合适时机先问 {@link #hasPendingFile}，再 {@link #openPendingFile}。
 * 不用事件推送，因为事件需要前端维护监听器生命周期，而轮询「有没有待处理文件」
 * 更简单也更稳。
 *
 * <p>【句柄为什么要保留 Uri，而不是只保留打开的流】
 * content URI 的读权限来自 Intent 授予，取走后仍然有效。读句柄同时保留 Uri 与
 * 当前打开的流：顺序读时直接续读（避免每块重新打开 + skip，那是 O(n²) 拷贝）；
 * 只有调用方要求非顺序 offset、或流在异常后被关闭时，才重新
 * {@code openInputStream} + 完整 skip 到目标位置。这样即使页面被系统暂停、
 * 流状态丢失，也能从任意 offset 继续读。
 */
@CapacitorPlugin(name = "DeepChatFiles")
public class FileOpenPlugin extends Plugin {

    /** 单文件上限：超过就不读了，避免 OOM。48 MB 足够容纳正常的历史导出。 */
    private static final long MAX_BYTES = 48L * 1024 * 1024;

    /**
     * 单次桥调用携带的原始字节上限；base64 后约 1.4 MB 字符串。
     *
     * 0.2.5 从 256 KB 提到 1 MB：备份 ZIP 动辄 50 MB，256 KB 分块意味着 200 次
     * WebView→原生往返（每次都 base64 编解码 + JSON 序列化）。1 MB 后往返少 4 倍，
     * 单次内存占用仍然很小（1 MB byte[] + 1.4 MB String）。
     * 必须与 web-patches/native-backup.ts 的 NATIVE_CHUNK_BYTES 保持一致。
     */
    private static final int MAX_CHUNK_BYTES = 1024 * 1024;

    /** 备份上传上限，防止异常调用把应用缓存写满。 */
    private static final long MAX_BACKUP_BYTES = 256L * 1024 * 1024;

    /** 备份上传的临时文件目录（应用缓存，失败/取消时删除）。 */
    private static final String BACKUP_TEMP_DIR = "deepchat-backup";

    /** 待处理的导入文件。由 MainActivity 在 onCreate / onNewIntent 时塞进来。 */
    private static Uri pendingUri;

    /** 打开中的导入文件句柄：handle → 状态 */
    private final Map<String, PendingHandle> pendingHandles = new HashMap<>();

    /** 进行中的备份上传：uploadId → 状态 */
    private final Map<String, UploadHandle> uploads = new HashMap<>();

    /**
     * 由 MainActivity 调用。静态字段是刻意的：冷启动时 Activity.onCreate
     * 早于插件实例化，没有实例可调。
     */
    public static void setPendingUri(Uri uri) {
        pendingUri = uri;
    }

    // ── 读入：外部打开的 ZIP ────────────────────────────────────────────────

    /** 当前是否有待处理文件。前端在页面重新可见时用来决定要不要取。 */
    @PluginMethod
    public void hasPendingFile(PluginCall call) {
        JSObject result = new JSObject();
        result.put("pending", pendingUri != null);
        call.resolve(result);
    }

    /**
     * 取走待处理的导入文件并建立读句柄。
     * 入参：无。返回 {@code {handle, name, size}} 或 {@code {name: null}}。
     * {@code size} 未知时为 -1（少数 provider 不提供文件大小）。
     *
     * <p>取走后立刻清空 {@link #pendingUri}：同一个文件不会被处理两次。
     * 但句柄里的 Uri 仍然可用，所以后续 readChunk 可以多次打开同一个 content URI。
     */
    @PluginMethod
    public void openPendingFile(PluginCall call) {
        Uri uri = pendingUri;
        pendingUri = null;
        JSObject result = new JSObject();
        if (uri == null) {
            result.put("name", null);
            call.resolve(result);
            return;
        }
        try {
            long size = sizeOf(uri);
            if (size > MAX_BYTES) {
                call.reject("file is larger than 48 MB");
                return;
            }
            String handle = UUID.randomUUID().toString();
            String name = displayName(uri);
            pendingHandles.put(handle, new PendingHandle(uri, name, size));
            result.put("handle", handle);
            result.put("name", name);
            result.put("size", size);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("failed to open incoming file: " + error.getMessage(), error);
        }
    }

    /**
     * 读一块文件内容。
     * 入参：{@code {handle, offset, length}}（length ≤ 256 KB）。
     * 返回：{@code {data: base64, size: 本块字节数, offset, eof}}。
     *
     * <p>错误语义：句柄不存在、offset 越界、length 非法、文件被截断、总大小超过 48 MB
     * 都 reject，JS 侧必须随后调 {@link #closePendingFile} 清理。
     */
    @PluginMethod
    public void readPendingFileChunk(PluginCall call) {
        String handleId = call.getString("handle");
        PendingHandle handle = handleId == null ? null : pendingHandles.get(handleId);
        if (handle == null) {
            call.reject("unknown file handle");
            return;
        }
        Integer offsetArg = call.getInt("offset");
        Integer lengthArg = call.getInt("length");
        if (offsetArg == null || offsetArg < 0) {
            call.reject("offset must be a non-negative integer");
            return;
        }
        int length = lengthArg == null ? MAX_CHUNK_BYTES : lengthArg;
        if (length <= 0 || length > MAX_CHUNK_BYTES) {
            call.reject("length must be between 1 and " + MAX_CHUNK_BYTES);
            return;
        }
        long offset = offsetArg;
        if (handle.size >= 0 && offset > handle.size) {
            call.reject("offset is beyond the end of the file");
            return;
        }
        try {
            JSObject result = new JSObject();
            if (handle.size >= 0 && offset == handle.size) {
                result.put("data", "");
                result.put("size", 0);
                result.put("offset", offset);
                result.put("eof", true);
                call.resolve(result);
                return;
            }
            byte[] buffer = new byte[length];
            int filled = readAt(handle, offset, buffer);
            if (handle.position > MAX_BYTES) {
                closePending(handleId);
                call.reject("file is larger than 48 MB");
                return;
            }
            boolean eof = handle.size >= 0 ? handle.position >= handle.size : filled < length;
            result.put("data", Base64.encodeToString(buffer, 0, filled, Base64.NO_WRAP));
            result.put("size", filled);
            result.put("offset", offset);
            result.put("eof", eof);
            call.resolve(result);
        } catch (Exception error) {
            // 读失败后句柄状态不可信，直接丢弃；JS 侧会在 finally 里 close（幂等）。
            closePending(handleId);
            call.reject("failed to read incoming file: " + error.getMessage(), error);
        }
    }

    /** 释放读句柄。幂等：句柄不存在也 resolve（清理路径不应该再抛错）。 */
    @PluginMethod
    public void closePendingFile(PluginCall call) {
        String handleId = call.getString("handle");
        boolean closed = handleId != null && closePending(handleId);
        JSObject result = new JSObject();
        result.put("closed", closed);
        call.resolve(result);
    }

    // ── 写出：导入前备份（分块上传）────────────────────────────────────────

    /**
     * 开始一次备份上传。
     * 入参：{@code {fileName}}；返回 {@code {uploadId}}。
     * 临时文件建在应用缓存目录；此时还没有碰 Documents，失败不会留下半截备份。
     */
    @PluginMethod
    public void beginBackup(PluginCall call) {
        String fileName = call.getString("fileName");
        String safeName = sanitizeName(fileName);
        if (safeName == null) {
            call.reject("invalid file name");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), BACKUP_TEMP_DIR);
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("cannot create backup temp directory");
            }
            File temp = new File(dir, "backup-" + UUID.randomUUID() + ".part");
            FileOutputStream stream = new FileOutputStream(temp);
            String uploadId = UUID.randomUUID().toString();
            uploads.put(uploadId, new UploadHandle(safeName, temp, stream));
            JSObject result = new JSObject();
            result.put("uploadId", uploadId);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("failed to start backup: " + error.getMessage(), error);
        }
    }

    /**
     * 追加一块备份数据。
     * 入参：{@code {uploadId, data: base64}}；返回 {@code {written: 累计字节数}}。
     * 写失败/超限时自动关闭并删除临时文件，再 reject。
     */
    @PluginMethod
    public void appendBackupChunk(PluginCall call) {
        String uploadId = call.getString("uploadId");
        UploadHandle upload = uploadId == null ? null : uploads.get(uploadId);
        if (upload == null) {
            call.reject("unknown backup upload");
            return;
        }
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("data is required");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (upload.written + bytes.length > MAX_BACKUP_BYTES) {
                failUpload(uploadId, upload);
                call.reject("backup is larger than 256 MB");
                return;
            }
            upload.stream.write(bytes);
            upload.written += bytes.length;
            JSObject result = new JSObject();
            result.put("written", upload.written);
            call.resolve(result);
        } catch (Exception error) {
            failUpload(uploadId, upload);
            call.reject("failed to write backup chunk: " + error.getMessage(), error);
        }
    }

    /**
     * 结束上传：把临时文件流式落到 Documents，返回 {@code {path}}。
     * 失败时 reject，并保证临时文件被删除、Documents 里不出现半截文件。
     */
    @PluginMethod
    public void finishBackup(PluginCall call) {
        String uploadId = call.getString("uploadId");
        UploadHandle upload = uploadId == null ? null : uploads.remove(uploadId);
        if (upload == null) {
            call.reject("unknown backup upload");
            return;
        }
        try {
            upload.stream.flush();
            upload.stream.close();
            upload.stream = null;
            String path = writeArchiveFile(upload.fileName, upload.temp);
            JSObject result = new JSObject();
            result.put("path", path);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("failed to save backup: " + error.getMessage(), error);
        } finally {
            deleteQuietly(upload.temp);
        }
    }

    /**
     * 放弃上传：关闭流、删除临时文件。幂等（未知 uploadId 也 resolve），
     * 因为 JS 的 catch 清理路径不应该再抛错。
     */
    @PluginMethod
    public void abortBackup(PluginCall call) {
        String uploadId = call.getString("uploadId");
        UploadHandle upload = uploadId == null ? null : uploads.remove(uploadId);
        if (upload != null) {
            closeUpload(upload);
            deleteQuietly(upload.temp);
        }
        JSObject result = new JSObject();
        result.put("aborted", upload != null);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        for (String handleId : pendingHandles.keySet().toArray(new String[0])) {
            closePending(handleId);
        }
        for (String uploadId : uploads.keySet().toArray(new String[0])) {
            UploadHandle upload = uploads.remove(uploadId);
            if (upload != null) {
                closeUpload(upload);
                deleteQuietly(upload.temp);
            }
        }
        super.handleOnDestroy();
    }

    // ── 实现细节 ────────────────────────────────────────────────────────────

    private static final class PendingHandle {
        final Uri uri;
        final String name;
        /** 文件大小；provider 不提供时为 -1（未知）。 */
        final long size;
        InputStream stream;
        long position;

        PendingHandle(Uri uri, String name, long size) {
            this.uri = uri;
            this.name = name;
            this.size = size;
        }
    }

    private static final class UploadHandle {
        final String fileName;
        final File temp;
        FileOutputStream stream;
        long written;

        UploadHandle(String fileName, File temp, FileOutputStream stream) {
            this.fileName = fileName;
            this.temp = temp;
            this.stream = stream;
        }
    }

    private boolean closePending(String handleId) {
        PendingHandle handle = pendingHandles.remove(handleId);
        if (handle == null) {
            return false;
        }
        closeStream(handle);
        return true;
    }

    private static void closeStream(PendingHandle handle) {
        if (handle.stream != null) {
            try {
                handle.stream.close();
            } catch (IOException ignored) {
                // 关闭失败不影响句柄释放
            }
            handle.stream = null;
        }
    }

    private static void closeUpload(UploadHandle upload) {
        if (upload.stream != null) {
            try {
                upload.stream.close();
            } catch (IOException ignored) {
                // 关闭失败仍然要删临时文件
            }
            upload.stream = null;
        }
    }

    private void failUpload(String uploadId, UploadHandle upload) {
        uploads.remove(uploadId);
        closeUpload(upload);
        deleteQuietly(upload.temp);
    }

    /**
     * 从 offset 处读满 buffer（或读到 EOF），返回实际读到的字节数。
     *
     * <p>顺序读时复用同一个输入流；offset 不连续（或流已被丢弃）时才重新打开并
     * skip 到目标位置。重新打开保证「content URI 取走后仍可多次打开」。
     */
    private int readAt(PendingHandle handle, long offset, byte[] buffer) throws IOException {
        if (handle.stream == null || handle.position != offset) {
            closeStream(handle);
            InputStream stream = getContext().getContentResolver().openInputStream(handle.uri);
            if (stream == null) {
                throw new IOException("cannot open the selected file");
            }
            try {
                skipFully(stream, offset);
            } catch (IOException error) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 忽略
                }
                throw error;
            }
            handle.stream = stream;
            handle.position = offset;
        }
        int filled = 0;
        while (filled < buffer.length) {
            int read = handle.stream.read(buffer, filled, buffer.length - filled);
            if (read == -1) {
                break;
            }
            filled += read;
        }
        handle.position += filled;
        return filled;
    }

    /** 跳过 count 字节；部分 provider 的 skip() 可能返回 0，用 read 兜底。 */
    private static void skipFully(InputStream stream, long count) throws IOException {
        long remaining = count;
        byte[] scratch = new byte[64 * 1024];
        while (remaining > 0) {
            long skipped = stream.skip(remaining);
            if (skipped > 0) {
                remaining -= skipped;
                continue;
            }
            int read = stream.read(scratch, 0, (int) Math.min(scratch.length, remaining));
            if (read < 0) {
                throw new IOException("unexpected end of file");
            }
            remaining -= read;
        }
    }

    /**
     * 写 ZIP。
     * API 29+ 用 MediaStore 落到公共 Documents/DeepChat（用户能在「文件」里直接看到）；
     * API 24–28 没有免权限的公共目录，退到应用专属目录，并如实返回该路径。
     */
    private String writeArchiveFile(String fileName, File source) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
            values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOCUMENTS + File.separator + "DeepChat");
            // IS_PENDING 保证其他应用在写完之前看不到半截文件
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = resolver.insert(collection, values);
            if (item == null) {
                throw new IllegalStateException("MediaStore refused to create the file");
            }
            try {
                try (OutputStream stream = resolver.openOutputStream(item)) {
                    if (stream == null) {
                        throw new IllegalStateException("cannot open output stream");
                    }
                    copy(source, stream);
                    stream.flush();
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(item, values, null, null);
                return "Documents/DeepChat/" + fileName;
            } catch (Exception error) {
                // 失败时删掉已插入的 pending 项，避免 Documents 里留下不可见的半截文件
                try {
                    resolver.delete(item, null, null);
                } catch (Exception ignored) {
                    // 删除失败也只能尽力而为
                }
                throw error;
            }
        }

        // API 24–28：应用专属目录，免权限；卸载应用会一并删除
        File dir = new File(
                getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "DeepChat");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create backup directory");
        }
        File target = new File(dir, fileName);
        try (FileOutputStream stream = new FileOutputStream(target)) {
            copy(source, stream);
            stream.flush();
        } catch (Exception error) {
            deleteQuietly(target);
            throw error;
        }
        return target.getAbsolutePath();
    }

    /** 临时文件 → 目标流；64 KB 一块，避免把整份备份再读进内存。 */
    private static void copy(File source, OutputStream target) throws IOException {
        try (InputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                target.write(buffer, 0, read);
            }
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            // 下次启动时缓存目录会被系统清理；这里不打断主流程
        }
    }

    /** 查询文件大小：优先 OpenableColumns.SIZE，其次 AssetFileDescriptor；都没有返回 -1。 */
    private long sizeOf(Uri uri) {
        try (Cursor cursor = getContext()
                .getContentResolver()
                .query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) {
                    return cursor.getLong(index);
                }
            }
        } catch (Exception ignored) {
            // 继续尝试 AssetFileDescriptor
        }
        try (AssetFileDescriptor descriptor =
                getContext().getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (descriptor != null) {
                long length = descriptor.getLength();
                if (length >= 0) {
                    return length;
                }
            }
        } catch (Exception ignored) {
            // 未知大小：交给 readChunk 直到 EOF，并用 48 MB 上限兜底
        }
        return -1;
    }

    /** 查询显示名，用于给网页一个像样的 File 对象名字 */
    private String displayName(Uri uri) {
        try (Cursor cursor = getContext()
                .getContentResolver()
                .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception ignored) {
            // 查询失败就用兜底名，不影响导入
        }
        return "deep-chat-import.zip";
    }

    /** 文件名清洗：不允许路径分隔符与 `..`（外部可控输入，必须挡住目录穿越）。 */
    private static String sanitizeName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return null;
        }
        String safeName = fileName.replace('/', '_').replace('\\', '_');
        if (safeName.isEmpty() || safeName.contains("..")) {
            return null;
        }
        return safeName;
    }

    /** 供 MainActivity 判断某个 Intent 是不是「打开一个 ZIP」 */
    public static boolean isZipIntent(Intent intent) {
        if (intent == null) {
            return false;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) {
            return false;
        }
        Uri data = Intent.ACTION_SEND.equals(action)
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM)
                : intent.getData();
        if (data == null) {
            return false;
        }
        String type = intent.getType();
        if (type != null && type.contains("zip")) {
            return true;
        }
        String path = data.getLastPathSegment();
        return path != null && path.toLowerCase().endsWith(".zip");
    }

    /** 供 MainActivity 使用：从 Intent 里取出文件 URI */
    public static Uri uriFrom(Intent intent) {
        if (intent == null) {
            return null;
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        return intent.getData();
    }

    /** 供 MainActivity 用于给 URI 授予读权限（部分来源需要显式 grant） */
    public static void grantRead(android.content.Context context, Intent intent, Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            context.grantUriPermission(context.getPackageName(), uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // 没权限授予也无妨：同一进程内 ContentResolver 通常仍可读取
        }
    }
}
