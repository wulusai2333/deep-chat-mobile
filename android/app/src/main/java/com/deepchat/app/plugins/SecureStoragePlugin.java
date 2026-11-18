package com.deepchat.app.plugins;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * API Key 的加密存储 —— 本项目的安全核心。
 *
 * <p>【为什么必须用 EncryptedSharedPreferences】
 * 需求硬性禁止 Key 以明文出现在 localStorage / IndexedDB / 普通 SharedPreferences。
 * EncryptedSharedPreferences 把「加密」交给 Android Keystore：主密钥（MasterKey）由
 * Keystore 生成并保管，密钥材料本身永远不出安全硬件/系统密钥库；
 * 落盘的只有一个用 AES256_GCM 加密后的密文 blob。
 *
 * <p>这样一来：
 * <ul>
 *   <li>apk 反编译 / 应用数据目录被拷走 —— 只拿到密文；</li>
 *   <li>手机丢失 —— 主密钥在 Keystore 里，脱离这台设备无法解密；</li>
 *   <li>应用被卸载 / 数据被清 —— Keystore 里的主密钥一并销毁，不可能恢复。</li>
 * </ul>
 *
 * <p>【密钥用途分开】
 * 主密钥只给本 prefs 用（AES256_GCM）。键名再用 AES256_SIV 加密，
 * 这样连「存了什么键」都不会泄露。
 *
 * <p>【为什么方法这么少】
 * 只需要 get / set / clear 三个动作。业务语义（什么时候写、写什么）
 * 全部在前端（web-patches/keystore-bridge.ts），原生侧只做「安全地存一个字符串」。
 * 原生不解析、不校验、不记录 Key —— 减少泄露面。
 *
 * <p>【线程】
 * PluginMethod 由 Capacitor 在 bridge 的后台线程执行，不在主线程。
 * EncryptedSharedPreferences 首次创建要访问 Keystore（可能几十毫秒），
 * 放在后台线程正合适，不会卡 UI。
 */
@CapacitorPlugin(name = "DeepChatSecureStorage")
public class SecureStoragePlugin extends Plugin {

    /** prefs 文件名。改名会让已存的 Key 丢失，不要动。 */
    private static final String PREFS_NAME = "deep-chat-secure";

    /** 存 Key 的键名 */
    private static final String KEY_API_KEY = "api-key";

    private SharedPreferences prefs;

    /**
     * 懒加载 + 双检锁。
     * 不在 load() 里初始化：插件在 Activity 创建时就实例化，此时做 Keystore 操作
     * 会拖慢冷启动；而用户可能根本不填 Key。
     */
    private SharedPreferences prefs() throws Exception {
        if (prefs != null) {
            return prefs;
        }
        synchronized (SecureStoragePlugin.class) {
            if (prefs != null) {
                return prefs;
            }
            Context context = getContext();
            MasterKey masterKey = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    context,
                    PREFS_NAME,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
            return prefs;
        }
    }

    /**
     * 读取已保存的 Key。
     * 没有时返回 {@code {value: null}} 而不是报错 —— 「还没配」是正常状态，
     * 前端据此决定是否显示首次引导。
     */
    @PluginMethod
    public void read(PluginCall call) {
        try {
            JSObject result = new JSObject();
            String value = prefs().getString(KEY_API_KEY, null);
            // 空串按「没有」处理，避免引导层判断逻辑分散在两处
            result.put("value", value == null || value.isEmpty() ? null : value);
            call.resolve(result);
        } catch (Exception error) {
            // 解密失败通常意味着 Keystore 里的主密钥已失效（换机恢复、系统升级异常）。
            // 这时把残留密文清掉，让用户重新输入，而不是永久卡在启动失败。
            resetQuietly();
            call.reject("failed to read secure storage: " + error.getMessage(), error);
        }
    }

    /** 写入 Key。{@code value} 为空等同删除，避免留下空串密文。 */
    @PluginMethod
    public void write(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.isEmpty()) {
            remove(call);
            return;
        }
        try {
            SharedPreferences.Editor editor = prefs().edit();
            editor.putString(KEY_API_KEY, value);
            // commit 而不是 apply：调用方紧接着可能就要读回或杀进程，
            // 必须确保落盘完成才 resolve。
            if (!editor.commit()) {
                call.reject("failed to persist api key");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("failed to write secure storage: " + error.getMessage(), error);
        }
    }

    /** 删除 Key（换 Key、清除本机数据、退出时用）。 */
    @PluginMethod
    public void remove(PluginCall call) {
        try {
            prefs().edit().remove(KEY_API_KEY).commit();
            call.resolve();
        } catch (Exception error) {
            call.reject("failed to clear secure storage: " + error.getMessage(), error);
        }
    }

    /**
     * 尽力清理。用于解密失败后的自愈 —— 此时代价最小的选择是清空，
     * 让用户重新输入 Key；抛错只会让应用永久不可用。
     */
    private void resetQuietly() {
        try {
            prefs().edit().clear().commit();
        } catch (Exception ignored) {
            // prefs 本身不可用，无需处理
        }
    }
}
