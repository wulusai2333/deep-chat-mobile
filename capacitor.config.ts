import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 壳配置。
 *
 * 关键项（改动前先读 docs/build.md 的「不允许改的项」）：
 * - androidScheme: 'https'
 *   让 WebView 以 https://localhost 载入 assets，得到安全上下文。
 *   getUserMedia（录音）只在安全上下文可用；改成 http 会让 P2 语音链路直接失效。
 * - webDir: 'dist'
 *   dist 由 `pnpm build:web` 从上游 chat-demo 构建产物复制而来，是纯静态资源，无后端。
 * - android.captureInput: false —— 必须是 false
 *   Capacitor 的 captureInput 会装一个 BaseInputConnection 来转发按键事件，代价是
 *   破坏 WebView 的输入法组合（IME composition）。中文输入依赖 composition 事件，
 *   开着它会让拼音上屏异常。上游没有任何依赖按键转发的功能，所以直接关掉。
 * - appendUserAgent
 *   在 UA 尾部打标，便于排查线上问题，也便于前端识别原生壳。
 * - android.minWebViewVersion: 105
 *   保守下限，对应 Chromium 105。若目标机 WebView 内核更低，见 docs/build.md 的
 *   「WebView 内核偏旧」一节（下调 rspack targets 到 chrome >= 99）。
 */
const config: CapacitorConfig = {
  appId: 'com.deepchat.app',
  appName: 'Deep Chat',
  webDir: 'dist',
  // 打包内置资源，不在运行时连本地开发服务器
  bundledWebRuntime: false,
  android: {
    // 安全上下文：https://localhost，录音/剪贴板等能力的前提
    androidScheme: 'https',
    // 只信任系统 CA，禁止用户 CA（见 network_security_config.xml）
    allowMixedContent: false,
    // 必须 false：true 会装 BaseInputConnection，破坏中文输入法的组合输入
    captureInput: false,
    webContentsDebuggingEnabled: false,
    minWebViewVersion: 105,
  },
  // 原生壳标识，前端用 navigator.userAgent 判断是否跑在 APK 里
  appendUserAgent: 'DeepChatMobile/0.2.8',
  // 键盘行为交给 WebView 自身 + useMobileViewport（上游已处理 visualViewport）
  ios: {
    contentInset: 'never',
  },
}

export default config
