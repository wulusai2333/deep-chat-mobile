/**
 * 加密 Key 桥 —— web-patches/keystore-bridge.ts
 *
 * 责任：在原生壳里给上游 settings.ts 提供一个"同步可读、异步可写"的 Key 存储。
 *
 * 【为什么是同步读】
 * 上游 `useSettings` 在模块初始化时就 `apiKey: read(KEYS.apiKey)`，是同步求值。
 * 改成异步会波及所有调用方（`useSettings.getState().apiKey` 遍布全项目），
 * 属于大改，违反「最小 diff」。所以采取：
 *   1. 原生在页面脚本执行**之前**用 `evaluateJavascript` 写入 `window.__RUNTIME_KEY__`，
 *      保证模块初始化时 Key 已在内存里（见 MainActivity/Bridge 的注入时机）；
 *   2. 万一时序没赶上（冷启动竞态），下面用 `chat-demo:runtime-key` 事件补一次同步。
 * 这样 settings.ts 只需要"优先读 window.__RUNTIME_KEY__"，改动三行以内。
 *
 * 【写入路径】
 * 调原生 EncryptedSharedPreferences。前端**只**把 Key 放在内存和加密存储里，
 * 绝不回写 localStorage —— 这一点在 settings.ts 的 setApiKey 里显式保证了。
 *
 * 【清除】
 * 「清除本机数据」时同时清 IndexedDB（上游 clearHistory）与加密存储（这里）。
 */

import { PLUGIN_SECURE_STORAGE, callNative, isNativeShell } from './bridge.js'
import { writeLocalStorage } from './storage-utils.js'

/** 原生侧返回结构，见 native/secure-storage/ */
type ReadResult = { value: string | null }

/**
 * 把 Key 从加密存储读进内存。只应在启动时调用一次。
 * 返回 true 表示拿到 Key 并已注入 window.__RUNTIME_KEY__。
 */
export const hydrateRuntimeKey = async (): Promise<boolean> => {
  if (!isNativeShell()) {
    return false
  }
  const { value } = await callNative<ReadResult>(PLUGIN_SECURE_STORAGE, 'read')
  const apiKey = typeof value === 'string' && value.length > 0 ? value : null
  window.__RUNTIME_KEY__ = apiKey
  // 通知 settings.ts 同步 store（模块可能已经初始化完毕）
  window.dispatchEvent(new Event('chat-demo:runtime-key'))
  return apiKey !== null
}

/** 供 settings.ts 调用的写入端（写加密存储，不碰 localStorage） */
export const installKeyStore = (): void => {
  if (!isNativeShell()) {
    return
  }
  window.__CHAT_DEMO_KEYSTORE__ = {
    get: async () => {
      const { value } = await callNative<ReadResult>(PLUGIN_SECURE_STORAGE, 'read')
      return typeof value === 'string' && value.length > 0 ? value : null
    },
    set: async (value) => {
      if (value === null || value === '') {
        await callNative(PLUGIN_SECURE_STORAGE, 'remove')
        return
      }
      await callNative(PLUGIN_SECURE_STORAGE, 'write', { value })
    },
    clear: async () => {
      await callNative(PLUGIN_SECURE_STORAGE, 'remove')
    },
  }
  // 上游历史版本可能把明文 Key 留在了 localStorage（例如用户先装过 PWA）。
  // 这里主动抹掉，避免"已经加密存储、但明文还躺着一份"。
  if (window.__RUNTIME_KEY__) {
    writeLocalStorage('chat-demo:api-key', null)
  }
}
