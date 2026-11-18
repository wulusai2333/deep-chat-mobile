/**
 * 补丁镜像：上游 `src/main.tsx`（2 处锚点）
 *
 * 【改了什么】
 * 把 `createRoot(...).render(<App />)` 从「立即执行」改成「等 `shellReady` 再执行」。
 *
 * 【为什么必须等】
 * 上游 `App.tsx` 挂载时的 effect 会调 `ensureApiKey()`：
 *
 *   void initChat()
 *   ensureApiKey()      // 没有 Key → 立刻 openSettings('data')
 *
 * 而原生壳的 Key 在 `EncryptedSharedPreferences` 里，要经过一次异步的
 * 「桥调用 → 解密 → 注入 window」才能拿到。如果不 await：
 *
 *   render → effect → ensureApiKey() → apiKey 还是 null → 设置窗弹出
 *   （几十毫秒后 Key 才到，但用户已经看到一个莫名其妙的设置窗）
 *
 * 这个竞态是间歇性的：设备快的时候可能刚好躲过去，慢的时候必现。
 * 属于「本地测不出来、用户天天遇到」的典型。
 *
 * 【为什么让前端自己 await，而不是原生 evaluateJavascript 注入】
 * 试过两条原生路子，都不可行：
 *   - `onPageStarted`：太早，此时 `window` 还是旧文档的，注入会被丢弃；
 *   - `onPageFinished`：太晚，React 早已渲染完，竞态已经发生。
 * 而让前端在 render 之前 await 一个 Promise，时序上是确定性的。
 * `MainActivity` 因此只负责注册插件和接收 ZIP intent。
 *
 * 【浏览器下会慢吗】
 * 不会。`isNativeShell()` 为 false 时 `shellReady` 是一个已 resolve 的 Promise，
 * `.then()` 在下一个微任务执行 —— 与上游的同步 render 对用户完全等价。
 *
 * 【超时兜底】
 * `shell.ts` 里 `hydrateRuntimeKey()` 包了 1.5 秒超时。万一原生桥卡住（极罕见），
 * 也一定会 resolve，不会永远白屏。代价是这种情况下引导页会出现，
 * 用户重新填一次 Key —— 比白屏好得多。
 */

// ── 锚点 1：import 区 ──
// 原本：
//   import { createRoot } from 'react-dom/client'
// 插入：
//   // mobile-shell: bootstrap —— 原生壳入口（安全区 / 加密 Key / ZIP 导入 / 首启引导）。
//   // 放在所有渲染之前，保证安全区样式先于首屏生效；不是原生壳时整段是空操作。
//   import { shellReady } from './shell/shell.js'

// ── 锚点 2：末尾 render ──
// 原本：
//   createRoot(document.getElementById('root') as HTMLElement).render(<App />)
// 现在：
//   // mobile-shell: await shell —— 原生壳要先把加密存储里的 Key 读进内存，
//   // 否则 App 挂载时的 ensureApiKey() 会因为「暂时没 Key」而误弹设置窗。
//   // 浏览器下 shellReady 已 resolve，等价于上游的直接 render。
//   void shellReady.then(() => {
//     createRoot(document.getElementById('root') as HTMLElement).render(<App />)
//   })
