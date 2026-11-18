/**
 * 补丁镜像：上游 `src/components/settings/settingsDialogState.ts`（1 处锚点）
 *
 * 【问题】
 * 上游在 App 挂载时调用 `ensureApiKey()`：没有 Key 就 `openSettings('data')`，
 * 直接弹出设置窗口逼用户填。原生壳首启时我们已经有一个引导页在收集 Key，
 * 两个入口同时出现，用户会看到引导层背后又冒出一个设置窗。
 *
 * 【做法】
 * 让 `ensureApiKey()` 在「引导页正在接管」时直接返回 false，不弹窗。
 * 判据是 `window.__CHAT_DEMO_ONBOARDING__`：由 `shell.ts` 在确认没有 Key 时置 true，
 * 引导页结束（成功 / 跳过 / 出错）后一定复位为 false。
 *
 * 【为什么要「一定复位」】
 * 如果引导页在某个异常路径上没复位，`ensureApiKey()` 就永远不再弹设置窗 ——
 * 用户既没有 Key，也没有任何入口去填，应用变成只读。
 * 所以 `onboarding.ts` 里每一条退出路径都写了复位，`shell.ts` 的 catch 也补了一次。
 * `scripts/accept.mjs` 的场景 A/B/C 就是在盯这条链路。
 */

// 锚点：ensureApiKey() 的「已有 Key 就返回」之后、openSettings('data') 之前
//
// 原本：
//   export const ensureApiKey = () => {
//     if (useSettings.getState().apiKey) {
//       return true
//     }
//     openSettings('data')
//     return false
//   }
//
// 插入：
//   // mobile-shell: onboarding owns key prompt —— 原生壳首启时由引导页收集 Key，
//   // 这里不要再弹设置窗，否则两个获取 Key 的入口同时出现。
//   // 引导页被跳过或失败时会把该标志复位，回落到上游行为。
//   if (typeof window !== 'undefined' && window.__CHAT_DEMO_ONBOARDING__) {
//     return false
//   }
