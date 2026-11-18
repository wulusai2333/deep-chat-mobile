package com.example.chatdemo.plugins;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 麦克风权限的查询 / 申请 / 引导 —— 语音输入的前置条件。
 *
 * <p>【为什么 WebView 的 getUserMedia 还需要这个插件】
 * Capacitor 的 BridgeWebChromeClient 已经处理了 RESOURCE_AUDIO_CAPTURE，
 * 所以只要 manifest 里有 RECORD_AUDIO，网页里的 getUserMedia 就能工作。
 * 但有两个真实问题网页层解决不了：
 *
 * <ol>
 *   <li><b>「已永久拒绝」无法区分</b>
 *       网页拿到的永远是 NotAllowedError，分不清是"这次点了拒绝"还是
 *       "已经选了不再询问"。后者再调 getUserMedia 不会弹窗，用户会以为功能坏了。</li>
 *   <li><b>没有「去系统设置」的入口</b>
 *       永久拒绝后唯一出路是让用户手动去 设置 → 应用 → 权限 → 麦克风。
 *       网页无法发起这个跳转。</li>
 * </ol>
 *
 * <p>插件只做三件事：check（带理由的状态）、request（申请）、openSettings（跳设置）。
 * 录音本身仍由网页的 getUserMedia 完成 —— 不把音频数据穿过 JS 桥，
 * 避免牺牲音质与延迟。
 *
 * <p>【只声明必要的权限】
 * 除 RECORD_AUDIO 外还声明了 MODIFY_AUDIO_SETTINGS。这不是"多要权限"，
 * 而是 Capacitor 的录音链路要求：BridgeWebChromeClient.onPermissionRequest 处理
 * AUDIO_CAPTURE 时会同时申请这两个权限，并对结果做「全部 granted 才算 granted」
 * 的与运算。manifest 缺一个，系统直接判 denied（连框都不弹），
 * 网页侧 getUserMedia 就抛 NotAllowedError —— 表现为"系统里麦克风明明允许了但就是不行"。
 * MODIFY_AUDIO_SETTINGS 是 normal 级权限，安装时自动授予、不弹框、不给额外数据访问。
 * 存储权限一个都不要：导入走 SAF，备份走 MediaStore。
 */
@CapacitorPlugin(
        name = "ChatDemoMic",
        permissions = {
            @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
        })
public class MicPermissionPlugin extends Plugin {

    /** 记录「是否已经弹过系统权限窗」，用于区分「还没问」与「不再询问」 */
    private static final String PREFS_NAME = "chat-demo-mic";
    private static final String KEY_REQUESTED = "requested";

    /**
     * 查询当前权限状态。
     * 返回的 {@code canRequest} 是网页侧做决策的关键：
     * true → 可以调 request() 弹系统窗；false → 只能引导用户去系统设置。
     */
    @PluginMethod
    public void check(PluginCall call) {
        call.resolve(state());
    }

    /** 申请权限。用户已选「不再询问」时不会再弹窗，直接回 denied。 */
    @PluginMethod
    public void request(PluginCall call) {
        if (granted()) {
            call.resolve(state());
            return;
        }
        // 必须在发起申请前记下「问过了」：系统回调后 shouldShowRequestPermissionRationale
        // 才能和这个标记配合，判断出「不再询问」。
        prefs().edit().putBoolean(KEY_REQUESTED, true).apply();
        requestPermissionForAlias("microphone", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        // 无论用户选了什么，都把最新状态回给前端 —— 由前端决定重试还是引导
        call.resolve(state());
    }

    /**
     * 跳到本应用的系统设置页。
     * 这是「永久拒绝」之后唯一的恢复路径，必须提供。
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("failed to open app settings: " + error.getMessage(), error);
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private boolean granted() {
        // 两个权限都要在：见类注释里对 MODIFY_AUDIO_SETTINGS 的说明。
        // 后者是 normal 级、安装即授予，实际只是用来确认 manifest 声明齐全 ——
        // 若它缺失，这里会立刻返回 false，而不是等 getUserMedia 报一个看不懂的错。
        boolean record = ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean audio = ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.MODIFY_AUDIO_SETTINGS) == PackageManager.PERMISSION_GRANTED;
        return record && audio;
    }

    private JSObject state() {
        boolean isGranted = granted();
        // shouldShowRequestPermissionRationale 在「还没问过」和「选了不再询问」时
        // 都返回 false，所以必须配合「是否问过」来区分这两种情况。
        boolean rationale = getActivity().shouldShowRequestPermissionRationale(
                Manifest.permission.RECORD_AUDIO);
        boolean requested = prefs().getBoolean(KEY_REQUESTED, false);
        boolean canRequest = !isGranted && (rationale || !requested);

        JSObject result = new JSObject();
        result.put("state", isGranted ? PermissionState.GRANTED.toString()
                : canRequest ? PermissionState.PROMPT.toString()
                : PermissionState.DENIED.toString());
        result.put("canRequest", canRequest);
        // 永久拒绝：问过、且系统不再给弹窗机会 —— 只能去设置页
        result.put("blocked", !isGranted && !canRequest);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+ 支持「仅本次允许」，插件的 check 结果里带上供前端提示
            result.put("oneTimeSupported", true);
        }
        return result;
    }
}
