/**
 * 死锁复现探针 —— scripts/probe.entry.ts
 *
 * 【要证明的事】
 * 真机上「设置 → 数据 → 导入」走的是上游的 importHistory()，它内部用
 * enqueueBackup() 排队；而 mergeImport 里的「导入前自动备份」如果调用同样
 * 会入队的 exportHistory()，就是「任务 A 在队列里等任务 B，而 B 要排在 A 后面」
 * ——队列永远不会前进，Promise 永远不 resolve。
 *
 * 浏览器里跑不出来，因为 isNativeShell() 为 false，备份那一段被整段跳过。
 * 所以这里手工伪造一个 window.Capacitor，把 isNativeShell() 变成 true，
 * 走的就是设备上那条路径。
 */

import { installImportBridge } from '../web/src/shell/import-bridge.js'
import { importHistory, exportHistory, exportHistorySnapshot } from '../web/src/services/chat/backup.js'
import * as db from '../web/src/services/chat/db.js'

declare global {
  interface Window {
    __PROBE__?: (file: File) => Promise<unknown>
  }
}

/** 伪造原生壳：只实现 callNative 需要的那一个方法 */
const installFakeNative = () => {
  const calls: string[] = []
  ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
    nativePromise: async (plugin: string, method: string) => {
      calls.push(`${plugin}.${method}`)
      // saveBackup 的返回值会被当作备份落盘路径
      if (method === 'saveBackup') {
        return { path: '/fake/Documents/deep-chat-backup.zip' }
      }
      return {}
    },
  }
  return calls
}

/** 给 promise 套一个超时，用来把「死锁」和「慢」区分开 */
const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T | string> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`TIMEOUT<${label}> 超过 ${ms} ms 仍未结束（疑似死锁）`), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const log = (message: string) => console.log(`[probe] ${message}`)

window.__PROBE__ = async (file: File) => {
  const report: Record<string, unknown> = {}

  // ── 1. 先确认队列空闲时 exportHistory() 本身是好的 ──
  // 如果这一步也超时，说明问题不在嵌套入队，而在导出本身。
  const idle = await withTimeout(exportHistory(), 15000, 'exportHistory(队列空闲)')
  report.exportHistoryIdle = typeof idle === 'string' ? idle : `OK ${(idle as { blob: Blob }).blob.size} bytes`
  log(`空闲态 exportHistory: ${report.exportHistoryIdle}`)

  const snap = await withTimeout(exportHistorySnapshot(), 15000, 'exportHistorySnapshot')
  report.exportHistorySnapshot = typeof snap === 'string' ? snap : `OK ${(snap as { blob: Blob }).blob.size} bytes`
  log(`exportHistorySnapshot: ${report.exportHistorySnapshot}`)

  // ── 2. 关键一步：伪装成设备，走 importHistory（内部先入队再合并）──
  const calls = installFakeNative()
  log('已伪造 window.Capacitor，isNativeShell() 现在为 true')

  // 关键：桥是在模块加载时按 isNativeShell() 决定装不装的（见 shell.ts 的
  // installImportBridge()）。此刻才补上 Capacitor 已经晚了，必须手动再装一次，
  // 否则 importHistory 里 window.__DEEP_CHAT_IMPORT__ 仍是 undefined，
  // 测到的还是上游覆盖逻辑 —— 那正是第一版探针误报「一切正常」的原因。
  installImportBridge()
  report.bridgeInstalled = Boolean(window.__DEEP_CHAT_IMPORT__)
  log(`合并导入桥已装: ${report.bridgeInstalled}`)

  const before = (await db.loadSessionSummaries()).length
  const started = performance.now()
  const outcome = await withTimeout(importHistory(file), 60000, 'importHistory')
  const elapsed = Math.round(performance.now() - started)
  const after = (await db.loadSessionSummaries()).length

  report.importHistory = typeof outcome === 'string' ? outcome : `OK 返回 ${outcome}`
  report.elapsedMs = elapsed
  report.beforeCount = before
  report.afterCount = after
  report.nativeCalls = calls
  log(`importHistory -> ${report.importHistory}（${elapsed} ms，会话 ${before} -> ${after}）`)
  log(`原生调用: ${JSON.stringify(calls)}`)

  return report
}
