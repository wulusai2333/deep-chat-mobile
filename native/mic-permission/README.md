# ChatDemoMic —— 麦克风权限插件

只做三件事：查状态、申请授权、跳系统设置。**不录音** —— 录音仍由网页的
`getUserMedia` + `MediaRecorder`-风格脚本完成（见上游 `services/speech/recorder.ts`）。

---

## 为什么需要这个插件

Capacitor 本身已经能处理麦克风授权：网页调 `getUserMedia` 时，
`BridgeWebChromeClient.onPermissionRequest` 会拉起系统授权框。**首次授权不需要这个插件。**

它解决的是「首授权之后」的那一段：

| 情况 | Capacitor 自带 | 本插件 |
| --- | --- | --- |
| 首次请求麦克风 | ✅ 弹系统框 | — |
| 用户选了「不再询问」 | ❌ 永远 `NotAllowedError`，不弹框 | ✅ 能查出「已永久拒绝」并引导去设置 |
| 从系统设置授权后返回 | ❌ 没有回前台刷新机制 | ✅ 重新 `check` 得到最新状态 |
| 语音按钮前置灰 | ❌ 无法判断 | ✅ `check` 返回 `blocked` |

关键区别：`shouldShowRequestPermissionRationale()` 只有原生能读到。
网页侧无论被拒绝还是被永久拒绝，拿到的都是同一个 `NotAllowedError` —— 分不出来。

---

## API

插件名：`ChatDemoMic`

### `check()`

```ts
type Result = {
  /** granted=已授权；prompt=未请求过；denied=被拒但还能再问；
   *  prompt-with-rationale=被拒过一次，下次请求会带说明 */
  state: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  /** 现在调 request() 是否还有意义（系统还会弹框） */
  canRequest: boolean
  /** 已被永久拒绝 —— 只能去系统设置，request() 不会再弹框 */
  blocked: boolean
  /** 这个系统版本上「只允许一次」是否生效（Android 11+） */
  oneTimeSupported: boolean
}
```

不弹任何框，随时可调。

### `request()`

拉起系统授权框并等待结果。返回结构与 `check()` 相同（即申请后的最新状态）。

- 已经授权 → 直接返回 `granted`，不弹框
- 已永久拒绝 → 直接返回 `blocked: true`，不弹框（**调用方应改为引导去设置**）

### `openSettings()`

跳到本应用的系统权限页（`Settings.ACTION_APPLICATION_DETAILS_SETTINGS`）。
没有返回值，用户是否真的开了权限只能靠之后的 `check()` 得知。

---

## 网页侧怎么用

见 `web-patches/mic-guide.ts`。策略是**只在失败路径上介入**：

```
点录音
  → getUserMedia
     ├─ 成功 → 正常录音（零额外 IPC）
     └─ NotAllowedError
          → check()
             ├─ blocked=true  → 弹「去设置」浮层，接管这个错误
             └─ 否则          → 走上游原有的 toast
```

**为什么不在点击时先 `check()`**：预检需要在手势内多一次 IPC 往返，会推迟
`getUserMedia` 的调用；而 `AudioContext` 需要用户手势才能 `resume()`，
推迟可能错过窗口，导致录到了但放不出声。让正常路径零成本。

---

## 关于 MODIFY_AUDIO_SETTINGS

`@Permission` 里只声明了 `RECORD_AUDIO`，但 manifest 里必须有 `MODIFY_AUDIO_SETTINGS`，
且本插件的 `granted()` 会同时检查两者。

原因在 `BridgeWebChromeClient.onPermissionRequest`：

```java
// 第 108-109 行
permissionLauncher.launch(new String[] {
    Manifest.permission.MODIFY_AUDIO_SETTINGS,
    Manifest.permission.RECORD_AUDIO
});
// 只有全部 granted 才算 granted
```

manifest 缺一个 → 系统判 denied（不弹框）→ 整组失败 → 网页 `getUserMedia` 抛 `NotAllowedError`。
表现为「系统设置里麦克风明明允许，点了就是失败」。

`MODIFY_AUDIO_SETTINGS` 是 `normal` 级（安装即授予、不弹框、无额外数据访问），
加上它不违背最小权限原则。完整说明见 `android/app/src/main/AndroidManifest.xml` 的注释
与 `docs/build.md §11`。

---

## 「只允许一次」（Android 11+）

Android 11 起系统多了「仅本次允许」选项。用户选它之后：

- 应用退到后台再回来，权限**自动收回**
- 下次 `check()` 返回 `prompt`（不是 `denied`），可以再申请
- 所以 `oneTimeSupported` 只用于 UI 提示，不该据此禁用功能

---

## 实现要点

- `requested` 标志存在 `chat-demo-mic` 普通 SharedPreferences（**不是**加密存储 ——
  这里没有任何敏感数据，只是一个「问过没有」的布尔值）
- 标志在 `requestPermissionForAlias` **之前**置位。因为 `Plugin` 没有
  `onRequestPermissionsResult` 这种钩子，结果只通过 `@PermissionCallback` 回来；
  如果等回来再置位，用户在框上直接划掉（无回调）就会永远显示「没问过」
- `canRequest = !granted && (rationale || !requested)` —— 有 rationale 说明还能问
- `openSettings` 带 `FLAG_ACTIVITY_NEW_TASK`：从非 Activity context 启动必须加

---

## 测试

```powershell
# 装 debug 包后
adb shell pm revoke com.example.chatdemo android.permission.RECORD_AUDIO
adb shell pm clear-permission-flags com.example.chatdemo android.permission.RECORD_AUDIO user-set user-fixed
```

`clear-permission-flags` 里的 `user-fixed` 就是「不再询问」的标志位 —— 清掉它才能重新弹框。
