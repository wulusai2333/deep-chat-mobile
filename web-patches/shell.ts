/**
 * 原生壳启动入口 —— web-patches/shell.ts
 *
 * 由 `prepare-web.mjs` 注入到 `web/src/shell/shell.ts`，并在 main.tsx 顶部被 import。
 * 是整个手机端改动的**唯一入口**：上游代码只多一个 import 和一处 render 包裹，
 * 其余全在这里。
 *
 * 为什么用 import 副作用而不是在 main.tsx 里写逻辑：
 *   上游升级时只要 import 锚点还在，补丁就能重放；逻辑全在本文件里，
 *   改什么都不碰上游源码。同理 safe-area.css 也在这个 import 链上，
 *   由 rspack 打进主 CSS —— 不需要运行时插 <link>，没有 FOUC 和 404 风险。
 *
 * ── 时序（关键，改动前务必读完） ─────────────────────────────────────────────
 *
 * 上游 App.tsx 挂载时会同步调 `ensureApiKey()`，没 Key 就弹设置窗。而加密存储
 * 只能通过异步的原生桥读取（一次 IPC 往返）。所以如果「先渲染、再读 Key」，
 * 每次启动都会先闪一下设置窗再被关掉 —— 这是实测到的行为，不是理论风险。
 *
 * 因此导出 `shellReady`：main.tsx 等它 resolve 之后再 render。
 *   • 浏览器 / PWA：立刻 resolve，行为与上游完全一致；
 *   • 原生壳：最多等一次 Keystore 读取（通常几十毫秒），有 1.5s 超时兜底，
 *     桥挂死也绝不白屏。
 *
 * 首启引导**不**在 shellReady 里等用户输入 —— 那样会卡住整个应用。它在
 * shellReady 之后异步浮上来，同时先把 `__CHAT_DEMO_ONBOARDING__` 置位，
 * 让上游的 ensureApiKey() 知道「首启的 Key 提示由壳层负责」，不去抢着弹自己的窗。
 */

import './safe-area.css'
import { installImportBridge, installIncomingFileHandler, kickIncomingFile } from './import-bridge.js'
import { hydrateRuntimeKey, installKeyStore } from './keystore-bridge.js'
import { maybeShowOnboarding } from './onboarding.js'
import { isNativeShell } from './bridge.js'
import { nextPaint } from './ui.js'

/** 桥挂死时也不能挡住首屏，最多等这么久 */
const HYDRATE_TIMEOUT_MS = 1500

declare global {
  interface Window {
    /** 首启引导是否正在接管 Key 提示；上游 ensureApiKey 会读它 */
    __CHAT_DEMO_ONBOARDING__?: boolean
  }
}

const withTimeout = <T>(task: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    task,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), HYDRATE_TIMEOUT_MS)
    }),
  ])

/**
 * 阶段一：只做「render 之前必须完成」的事 —— 装桥 + 把 Key 读进内存。
 *
 * 这个函数是 shellReady 的全部内容，所以它绝不能等任何用户操作：
 * 一等人点按钮，React 就不渲染，屏幕全白。
 */
const prepare = async (): Promise<void> => {
  // 浏览器 / PWA：整段空操作，上游行为零变化。PWA 回退路线靠的就是这一行。
  if (!isNativeShell()) {
    return
  }

  // 加密存储桥：上游 setApiKey 会检查 window.__CHAT_DEMO_KEYSTORE__ 是否存在
  installKeyStore()

  // 合并导入桥：上游导入按钮据此切到「合并」而不是「覆盖」
  installImportBridge()

  // 外部打开 ZIP 的监听（visibilitychange）。只挂监听，不主动查 ——
  // 首次检查要等 App 挂载后才有意义，见阶段二。
  installIncomingFileHandler()

  // 把加密存储里的 Key 读进内存（window.__RUNTIME_KEY__），并同步进 settings store。
  // 返回 false 说明设备上还没存过 Key，需要走引导。
  const hasKey = await withTimeout(hydrateRuntimeKey(), false)

  if (!hasKey) {
    // 置位后 render 才会发生（本函数在 shellReady 里），
    // 这样 App 挂载时 ensureApiKey() 一定走「别弹窗」的分支。
    window.__CHAT_DEMO_ONBOARDING__ = true
  }

  // 阶段二不 await：它要等用户输入，必须放到 render 之后
  void afterRender(hasKey)
}

/**
 * 阶段二：首帧画完之后的事。App 已挂载、db 与 store 已初始化。
 * 这里出任何错都只打日志，绝不影响已经渲染好的界面。
 */
const afterRender = async (hasKey: boolean): Promise<void> => {
  // 等两帧：保证 React 已经把首屏画到屏幕上，浮层不会盖在空白页上
  await nextPaint()
  try {
    await maybeShowOnboarding(hasKey)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[mobile-shell] onboarding failed', error)
    // 引导挂了就别再拦着上游的提示窗，否则用户永远没地方填 Key
    window.__CHAT_DEMO_ONBOARDING__ = false
  }
  // 引导结束（或被跳过）后处理「外部打开 ZIP」：
  // 此时 db 与 store 已就绪，且导入结果页不会和引导浮层叠在一起。
  kickIncomingFile()
}

/**
 * main.tsx 在 render 之前 await 这个 Promise —— 它只等「Key 就绪」，不等用户操作。
 *
 * 为什么必须分两段：如果让 shellReady 一直等到引导结束，用户没点「下一步」
 * 之前 React 根本不渲染，屏幕就是一片白。所以 shellReady 必须在 render 前
 * resolve，而引导与导入处理放到 afterRender 里。
 */
export const shellReady: Promise<void> = prepare().catch((error: unknown) => {
  // 壳层失败绝不能白屏：捕获后只打日志，让上游 App 照常启动。
  // eslint-disable-next-line no-console
  console.error('[mobile-shell] bootstrap failed', error)
})
