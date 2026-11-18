/**
 * 原生桥的极薄封装 —— web-patches/bridge.ts
 *
 * 【为什么不用 @capacitor/*-plugin 的 npm 包】
 * 上游 chat-demo 的依赖树是钉死的（pnpm-lock.yaml 有 hash 校验）。为了不给上游
 * 引入任何新依赖，壳层直接使用 Capacitor 注入到页面的 `window.Capacitor`：
 * 原生侧 `native-bridge.js` 在文档开始前就会执行（由 JSInjector 注入 HTML），
 * 它在 window 上挂了 `Capacitor.nativePromise(pluginName, method, options)`。
 * 只要插件在原生注册过，这条通道就能用，不需要 JS 侧的 plugin registry。
 *
 * 【在浏览器里】
 * 没有 window.Capacitor，所有调用都应"安静地不可用"——PWA 兜底路径依赖这一点。
 */

/** 原生桥暴露的最小接口（按需裁剪，不声明未用到的字段） */
type CapacitorBridge = {
  nativePromise: (plugin: string, method: string, options?: unknown) => Promise<unknown>
  getPlatform?: () => string
  isNativePlatform?: () => boolean
}

/** 三个自写插件的名字，与 native/ 下各自 @CapacitorPlugin(name=...) 保持一致 */
export const PLUGIN_SECURE_STORAGE = 'DeepChatSecureStorage'
export const PLUGIN_MIC = 'DeepChatMic'
export const PLUGIN_FILES = 'DeepChatFiles'

const bridge = (): CapacitorBridge | undefined => {
  const capacitor = (globalThis as { Capacitor?: CapacitorBridge }).Capacitor
  return capacitor && typeof capacitor.nativePromise === 'function' ? capacitor : undefined
}

/** 是否跑在 APK 壳里（浏览器 / PWA 下为 false） */
export const isNativeShell = (): boolean => bridge() !== undefined

/**
 * 调用原生方法。桥不存在时抛出带明确标记的错误，
 * 调用方据此决定是"降级到浏览器行为"还是"提示用户"。
 */
export const callNative = async <T>(
  plugin: string,
  method: string,
  options?: unknown
): Promise<T> => {
  const capacitor = bridge()
  if (!capacitor) {
    throw Object.assign(new Error(`native bridge unavailable: ${plugin}.${method}`), {
      code: 'NOT_NATIVE',
    })
  }
  return (await capacitor.nativePromise(plugin, method, options ?? {})) as T
}

/** 桥不存在时不抛错，返回 fallback；用于可选能力 */
export const tryNative = async <T>(
  plugin: string,
  method: string,
  options: unknown,
  fallback: T
): Promise<T> => {
  try {
    return await callNative<T>(plugin, method, options)
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_NATIVE') {
      return fallback
    }
    throw error
  }
}
