/**
 * 用户手动「导出所有历史对话」的原生落盘编排 —— web-patches/export-bridge.ts
 *
 * 【为什么需要它：上游的导出在 Android 上是静默无效的】
 * 上游 `SettingsDialog` 的导出是 `URL.createObjectURL(blob)` + `<a download>` + click。
 * 桌面浏览器正常；但 Android WebView（Capacitor 8）没有注册 `DownloadListener`，
 * `blob:` 下载会被直接丢弃 —— 不落盘、不报错、没有任何提示。
 * 用户实测：点「下载」什么都不会发生，不知道进度，也不知道是否失败。
 *
 * 原生壳必须把 Blob 分块交给原生写进 MediaStore/Documents（协议见
 * native-backup.ts），并且自己画进度与结果 —— 这个文件负责编排。
 *
 * 【两段进度】
 *   generate —— 读 IndexedDB、序列化会话、打 ZIP：0–60%
 *   save     —— 256 KB 分块过桥 + 原生落盘：60–100%
 * 两段各自从 0 开始会让用户以为任务重启了，所以合成一条单调递增的进度。
 *
 * 【失败与重试】
 * 失败时浮层不关闭，给「重试 / 关闭」。重试会重新生成并重新上传 ——
 * 导出是只读操作，重试没有任何数据风险；上一次的临时文件由原生 abort 清掉。
 * 关闭后 resolve(null)，调用方（SettingsDialog）只在成功时写状态文字。
 */

import { exportHistory } from '../services/chat/backup.js'
import { BackupError } from '../services/chat/history/errors.js'
import { translate } from '../i18n/index.js'
import { saveArchiveToDevice } from './native-backup.js'
import { showExportDialog } from './export-ui.js'

const pad = (value: number): string => String(value).padStart(2, '0')

/** 精确到秒：MediaStore 同名会重名、API 24–28 的直接文件写入还会覆盖旧文件 */
const exportFileName = (date: Date): string => {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `deep-chat-export-${stamp}.zip`
}

/** 把原生/归档错误翻译成用户能看懂的一句话；认不出的保留原始 message 便于排查 */
export const describeExportError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BackupError) {
    return translate(error.key)
  }
  if (/ZIP64|archive requires unsupported/i.test(message)) {
    return '会话数据超过 ZIP 格式上限（4 GB），无法一次性导出。'
  }
  if (/larger than 256 MB/i.test(message)) {
    return '导出文件超过应用 256 MB 的写入上限，请先清理部分会话后再试。'
  }
  if (/failed to save backup|failed to write backup/i.test(message)) {
    return `写入 Documents 失败，可能是存储空间不足。\n${message}`
  }
  if (/unknown backup upload/i.test(message)) {
    return '保存会话已失效，请重试。'
  }
  return message || '未知错误'
}

/**
 * 导出全部历史会话到手机 Documents/DeepChat/。
 *
 * 成功：浮层显示完整路径，返回 path；
 * 失败：浮层显示原因并可重试，关闭后返回 null（不抛错 —— 失败的提示由浮层负责，
 *       调用方不需要再写一遍状态文字）。
 */
export const exportHistoryToDevice = (): Promise<string | null> => {
  const ui = showExportDialog()
  return new Promise<string | null>((resolve) => {
    let running = false
    const run = async (): Promise<void> => {
      if (running) {
        return
      }
      running = true
      ui.reset()
      try {
        const { blob } = await exportHistory((done, total) => {
          ui.update({
            kind: 'generate',
            phase: done >= total ? '正在打包 ZIP…' : '正在生成备份文件',
            done,
            total,
          })
        })
        const fileName = exportFileName(new Date())
        ui.update({ kind: 'save', phase: '正在保存到手机…', done: 0, total: blob.size })
        const path = await saveArchiveToDevice(blob, fileName, (written, total) => {
          ui.update({
            kind: 'save',
            phase: written >= total ? '正在写入 Documents…' : '正在保存到手机…',
            done: written,
            total,
          })
        })
        ui.succeed(path, blob.size)
        resolve(path)
      } catch (error) {
        ui.fail(describeExportError(error), {
          onRetry: () => {
            void run()
          },
          onClose: () => {
            ui.close()
            resolve(null)
          },
        })
      } finally {
        running = false
      }
    }
    void run()
  })
}
