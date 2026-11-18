package com.deepchat.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.deepchat.app.plugins.FileOpenPlugin;
import com.deepchat.app.plugins.MicPermissionPlugin;
import com.deepchat.app.plugins.SecureStoragePlugin;
import com.getcapacitor.BridgeActivity;

/**
 * 应用入口。相比 Capacitor 生成的空壳，只多做两件事：
 *
 * <ol>
 *   <li>注册三个原生插件（加密存储 / 麦克风权限 / 文件）；</li>
 *   <li>把「外部打开 ZIP」的 Intent 记下来，覆盖冷启动与热启动两条路径。</li>
 * </ol>
 *
 * <p>【为什么这里不注入 API Key】
 * 最初的方案是用 {@code evaluateJavascript} 在页面加载前把 Key 写进
 * {@code window.__RUNTIME_KEY__}。实测不可行：Capacitor 的
 * {@code WebViewListener.onPageLoaded} 是在 {@code onPageFinished} 时触发的，
 * 此时文档脚本**已经执行完毕**，而上游 {@code settings.ts} 在模块初始化时就
 * 同步读了 Key（{@code apiKey: read(KEYS.apiKey)}），注入必然晚一步。
 *
 * <p>用 {@code onPageStarted} 注入同样不行：那个时机文档还没建立，
 * 写入的变量会随新文档一起被丢弃。
 *
 * <p>所以改成确定性的做法：**前端在渲染 React 之前先 await 一次读 Key**
 * （见 web-patches/shell.ts 与 prepare-web.mjs 对 main.tsx 的补丁）。
 * 一次 EncryptedSharedPreferences 读取只要几十毫秒，换来的是
 * 「首屏出现时 Key 一定已就绪」这个确定性质 —— 比依赖注入时序可靠得多。
 * Key 的读取路径本身没有变化：仍是 EncryptedSharedPreferences，
 * 仍然只在内存与 Keystore 之间流动，从不经过 localStorage。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 插件必须在 super.onCreate 之前注册：BridgeActivity 会在这之后
        // 用 bridgeBuilder 创建 Bridge，错过就注册不上了。
        registerPlugin(SecureStoragePlugin.class);
        registerPlugin(MicPermissionPlugin.class);
        registerPlugin(FileOpenPlugin.class);

        super.onCreate(savedInstanceState);

        // 冷启动：应用是被「用其他应用打开 ZIP」拉起的
        captureIncomingFile(getIntent());
    }

    /**
     * 热启动：应用已在后台，用户又从文件管理器打开了一个 ZIP。
     * 必须同时调 super —— BridgeActivity 要用它处理插件与 Cordova 的回调。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // 更新 Activity 持有的 Intent，避免后续 getIntent() 拿到旧的
        setIntent(intent);
        captureIncomingFile(intent);
    }

    /** 把 Intent 里的 ZIP 交给插件，等网页来取 */
    private void captureIncomingFile(Intent intent) {
        if (!FileOpenPlugin.isZipIntent(intent)) {
            return;
        }
        Uri uri = FileOpenPlugin.uriFrom(intent);
        if (uri == null) {
            return;
        }
        FileOpenPlugin.grantRead(this, intent, uri);
        FileOpenPlugin.setPendingUri(uri);
    }
}
