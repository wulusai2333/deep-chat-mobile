package com.deepchat.app.plugins;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
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
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 文件相关的两件事：保存备份 ZIP、接收外部 ZIP。
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
 * 这是需求 §3「只申请 INTERNET 与 RECORD_AUDIO」的直接结果 —— 换来的代价是
 * API 24–28 上备份落在应用专属目录，用户需要通过文件管理器的 Android/data 进去拿。
 * 这一点在 docs/install-harmony.md 里明确写了。
 *
 * <p>【为什么用 base64 把字节交给网页】
 * WebView 无法读取 {@code content://} URI。可行方案有两个：
 * 把字节转 base64 传过去，或让原生起一个本地 HTTP 服务。后者要开端口、
 * 要处理鉴权，对一个「偶尔导入一次」的功能太重。ZIP 通常只有几 MB，
 * base64 膨胀 33% 可以接受，所以选前者，并加了 64 MB 上限保护内存。
 *
 * <p>【冷启动 vs 热启动】
 * 应用可能因为「用文件管理器打开 ZIP」而被拉起（冷启动），也可能在后台被唤醒
 * （热启动，走 onNewIntent）。两条路径都把 URI 存进 {@link #pendingUri}，
 * 由网页在合适时机调 {@link #getPendingFile} 取走。不用事件推送，因为
 * 事件需要前端维护监听器生命周期，而轮询一个「有没有待处理文件」更简单也更稳。
 */
@CapacitorPlugin(name = "DeepChatFiles")
public class FileOpenPlugin extends Plugin {

    /** 单文件上限：超过就不读了，避免 OOM。48 MB 足够容纳正常的历史导出。 */
    private static final long MAX_BYTES = 48L * 1024 * 1024;

    /** 待处理的导入文件。由 MainActivity 在 onCreate / onNewIntent 时塞进来。 */
    private static Uri pendingUri;

    /**
     * 由 MainActivity 调用。静态字段是刻意的：冷启动时 Activity.onCreate
     * 早于插件实例化，没有实例可调。
     */
    public static void setPendingUri(Uri uri) {
        pendingUri = uri;
    }

    /**
     * 保存备份 ZIP。
     * 入参：{@code {fileName: string, data: base64}}；返回 {@code {path: string}}。
     * path 是给人看的位置描述（用户要能照着找到文件），不是可读路径。
     */
    @PluginMethod
    public void saveBackup(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data");
        if (fileName == null || fileName.isEmpty() || data == null) {
            call.reject("fileName and data are required");
            return;
        }
        // 文件名里不允许出现路径分隔符：这是外部可控输入，必须挡住目录穿越
        String safeName = fileName.replace('/', '_').replace('\\', '_');
        if (safeName.contains("..")) {
            call.reject("invalid file name");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String path = writeArchive(safeName, bytes);
            JSObject result = new JSObject();
            result.put("path", path);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("failed to save backup: " + error.getMessage(), error);
        }
    }

    /**
     * 取走待处理的导入文件。返回 {@code {name, data}} 或 {@code {name: null}}。
     * 取走后清空，保证同一个文件不会被处理两次。
     */
    @PluginMethod
    public void getPendingFile(PluginCall call) {
        Uri uri = pendingUri;
        // 立刻清空：即使下面读取失败，也不该无限重试同一个坏文件
        pendingUri = null;
        JSObject result = new JSObject();
        if (uri == null) {
            result.put("name", null);
            call.resolve(result);
            return;
        }
        try {
            String name = displayName(uri);
            byte[] bytes = readAll(uri);
            result.put("name", name);
            result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("failed to read incoming file: " + error.getMessage(), error);
        }
    }

    /** 当前是否有待处理文件。前端在页面重新可见时用来决定要不要取。 */
    @PluginMethod
    public void hasPendingFile(PluginCall call) {
        JSObject result = new JSObject();
        result.put("pending", pendingUri != null);
        call.resolve(result);
    }

    /**
     * 写 ZIP。
     * API 29+ 用 MediaStore 落到公共 Documents/DeepChat（用户能在「文件」里直接看到）；
     * API 24–28 没有免权限的公共目录，退到应用专属目录，并如实返回该路径。
     */
    private String writeArchive(String fileName, byte[] bytes) throws Exception {
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
            try (OutputStream stream = resolver.openOutputStream(item)) {
                if (stream == null) {
                    throw new IllegalStateException("cannot open output stream");
                }
                stream.write(bytes);
                stream.flush();
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, values, null, null);
            return "Documents/DeepChat/" + fileName;
        }

        // API 24–28：应用专属目录，免权限；卸载应用会一并删除
        File dir = new File(
                getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "DeepChat");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create backup directory");
        }
        File target = new File(dir, fileName);
        try (FileOutputStream stream = new FileOutputStream(target)) {
            stream.write(bytes);
            stream.flush();
        }
        return target.getAbsolutePath();
    }

    /** 从 content:// 读全部字节，带大小上限 */
    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) {
                throw new IllegalStateException("cannot open the selected file");
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = input.read(chunk)) != -1) {
                total += read;
                if (total > MAX_BYTES) {
                    throw new IllegalStateException("file is larger than 48 MB");
                }
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
        }
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
    public static void grantRead(Context context, Intent intent, Uri uri) {
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
