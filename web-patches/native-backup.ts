/**
 * 分块写入手机 Documents —— web-patches/native-backup.ts
 *
 * 【这个文件解决什么】
 * 「导出所有历史对话」和「导入前自动备份」都要把一份完整 ZIP 写到
 * `Documents/DeepChat/`。原生侧只提供一套分块协议：
 *   beginBackup → appendBackupChunk × N → finishBackup（失败则 abortBackup）。
 * 以前这套循环只写在 import-bridge 里，导出按钮用的是浏览器 `<a download>`；
 * 而 Android WebView 没有 DownloadListener，`blob:` 下载是**静默无效**的
 * （不落盘、不报错、没有任何提示）。把循环抽到这里，两个入口共用同一份实现。
 *
 * 【为什么必须分块】
 * 旧实现把整包转成一个 base64 字符串过一次桥：31 MB 归档 → 备份 ZIP 52 MB →
 * 单次桥负载 69.6 MB 字符串。WebView 侧要再序列化 JSON，Java 侧再解码出
 * 52 MB byte[]，低端机直接 OOM。现在每块 256 KB（base64 约 341 KB），
 * 峰值内存与「一块」成正比，与整包大小无关。
 *
 * 【失败语义】
 * 任何一步失败都调 abortBackup 删掉缓存里的临时文件；`finishBackup` 本身
 * 也会在失败时清理，所以 Documents 里不会出现半截文件（API 29+ 还有
 * MediaStore 的 IS_PENDING 兜底）。
 */

import { PLUGIN_FILES, callNative } from './bridge.js'

/**
 * 原生桥单次往返的原始字节上限。
 * 必须与 native/file-open/FileOpenPlugin.java 的 MAX_CHUNK_BYTES 保持一致：
 * 原生对 length > 256 KB 的请求直接 reject。
 */
export const NATIVE_CHUNK_BYTES = 256 * 1024

/**
 * 让出主线程，给浏览器一帧去画进度条。
 *
 * 【为什么叫 paint 而不是 yield】
 * 连续写几十 MB 时每一步都是 await，但 Promise 微任务之间不保证浏览器能拿到
 * 渲染帧。setTimeout(0) 把控制权交回事件循环，rAF 才有机会执行 —— 否则进度条
 * 会整段不动，用户以为卡死。
 */
export const yieldToPaint = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/** Blob → base64，分块拼接避免 `String.fromCharCode(...bigArray)` 爆栈 */
export const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** 保存进度：已写字节数 / 总字节数 */
export type SaveProgress = (written: number, total: number) => void

/**
 * 把一份 ZIP 写到手机 Documents/DeepChat/，返回原生给出的路径。
 *
 * 入参 `report` 在每个 256 KB 块写完后回调，调用方据此画进度条。
 * 文件名由调用方决定（原生会再做一次路径穿越清洗）。
 */
export const saveArchiveToDevice = async (
  blob: Blob,
  fileName: string,
  report: SaveProgress
): Promise<string> => {
  const { uploadId } = await callNative<{ uploadId: string }>(PLUGIN_FILES, 'beginBackup', {
    fileName,
  })
  try {
    const total = blob.size
    let offset = 0
    report(0, total)
    while (offset < total) {
      const end = Math.min(offset + NATIVE_CHUNK_BYTES, total)
      // 每次只把一个 256 KB 切片转 base64：单次桥负载 ≤ 341 KB 字符串。
      const data = await toBase64(blob.slice(offset, end))
      await callNative(PLUGIN_FILES, 'appendBackupChunk', { uploadId, data })
      offset = end
      report(offset, total)
      // 几十 MB 也是秒级到分钟级；块间让出主线程，进度条才动得了
      await yieldToPaint()
    }
    const { path } = await callNative<{ path: string }>(PLUGIN_FILES, 'finishBackup', {
      uploadId,
    })
    return path
  } catch (error) {
    // 任何一步失败都要 abort：原生删掉缓存里的临时文件，Documents 里不会出现半截文件
    await callNative(PLUGIN_FILES, 'abortBackup', { uploadId }).catch(() => {})
    throw error
  }
}
