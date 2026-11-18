/**
 * 补丁镜像：上游 `src/services/settings.ts`
 * 由 `scripts/prepare-web.mjs` 重放（4 处锚点）。
 *
 * 【为什么这是整个项目改动最小、风险最低的一处】
 * 上游把 API Key 当成普通偏好存在 localStorage（`chat-demo:api-key`）。
 * `client.ts` 并不自己去读 localStorage —— 它接收 `apiKey` 参数，
 * 所有调用方都从 `useSettings.getState().apiKey` 取值。
 * 也就是说 Key 的读写口子只有这一个文件的两个函数（初始化 + setApiKey）。
 * 不去动 client.ts、不去动任何 UI，就能把明文存储整条掐掉。
 *
 * 【读取优先级】
 *   1. `window.__RUNTIME_KEY__` —— 原生壳启动时从 EncryptedSharedPreferences
 *      读出后注入到内存。只存在于内存，进程一结束就没了。
 *   2. localStorage —— 仅桌面浏览器 / PWA 回退路径。
 *
 * 【为什么有 `chat-demo:runtime-key` 这个事件】
 * 冷启动存在竞态：React 可能在原生注入完成之前就求值了初始 state。
 * `shell.ts` 会在拿到 Key 后 dispatch 该事件，这里监听并同步进 store，
 * 避免「明明有 Key 却显示未配置」。
 *
 * 【绝不回写 localStorage】
 * 从原生拿到的 Key 一旦写回 localStorage，加密就白做了。
 * `scripts/verify.mjs` 的 C 组专门检查 setApiKey 里的 keystore 分支
 * 必须**先 return**，防止有人后来加了 `write()` 在上面。
 */

// ── mobile-shell: secure api key ────────────────────────────────────────────
// 原生壳（APK）里的 Key 不允许落明文。读取顺序：
//   1. window.__RUNTIME_KEY__ —— 原生在页面脚本执行前注入，只存在于内存；
//   2. localStorage —— 仅桌面浏览器 / PWA 回退路径会走到这里。
// 写入：有 Keystore 桥时交给原生加密保存；没有时（浏览器）才走 localStorage。
// 运行时从原生取得的 Key 绝不写回 localStorage，否则等于明文落地。
type ShellKeyStore = {
  get(): Promise<string | null>
  set(value: string | null): Promise<void>
  clear(): Promise<void>
}
declare global {
  interface Window {
    __RUNTIME_KEY__?: string | null
    __CHAT_DEMO_KEYSTORE__?: ShellKeyStore
  }
}

const injectedApiKey = (): string | null => {
  const value = typeof window === 'undefined' ? null : window.__RUNTIME_KEY__
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 原生在页面加载后才注入时（冷启动竞态兜底），同步到 store */
if (typeof window !== 'undefined') {
  window.addEventListener('chat-demo:runtime-key', () => {
    const value = injectedApiKey()
    if (value !== useSettings.getState().apiKey) {
      useSettings.setState({ apiKey: value })
    }
  })
}
// ── mobile-shell: secure api key end ───────────────────────────────────────

// ── 锚点 2：初始 state ──
// 原本：apiKey: read(KEYS.apiKey),
// 现在：  apiKey: injectedApiKey() ?? read(KEYS.apiKey),
//
// ── 锚点 3：setApiKey（有桥时先 return）──
// 原本：
//   export const setApiKey = (apiKey: string | null) => {
//     write(KEYS.apiKey, apiKey)
//     useSettings.setState({ apiKey })
//   }
// 现在：
//   export const setApiKey = (apiKey: string | null) => {
//     const keystore = typeof window === 'undefined' ? undefined : window.__CHAT_DEMO_KEYSTORE__
//     if (keystore) {
//       window.__RUNTIME_KEY__ = apiKey
//       void keystore.set(apiKey).catch((error: unknown) => {
//         console.error('[mobile-shell] failed to persist api key', error)
//       })
//       useSettings.setState({ apiKey })
//       return            // ← 必须 return：不回写 localStorage
//     }
//     write(KEYS.apiKey, apiKey)
//     useSettings.setState({ apiKey })
//   }
