/**
 * 原生壳「导出所有历史对话」的补丁说明 —— 对应 `scripts/prepare-web.mjs` 里的
 * 「mobile-shell: device export import」与「mobile-shell: device export」两处替换，
 * 以及新增的壳层文件 web-patches/native-backup.ts、export-bridge.ts、export-ui.ts。
 *
 * 【问题：导出在 Android 上一直是静默无效的】
 * 上游 `SettingsDialog` 的导出实现是：
 *   const { name, blob } = await exportHistory()
 *   const url = URL.createObjectURL(blob)
 *   const link = document.createElement('a')
 *   link.href = url; link.download = name; link.click()
 * 在桌面浏览器里这没问题。但 Capacitor 8 的 Android WebView **没有注册
 * `DownloadListener`**：`blob:` + `download` 的点击会被直接丢弃 —— 不落盘、
 * 不报错、没有任何提示。0.2.3 及以前的真机表现就是「点了下载什么都不会发生」，
 * 用户既不知道进度，也不知道是否失败。这不是样式问题，是路径本身没通。
 *
 * 【为什么不「给 WebView 补一个 DownloadListener」】
 * DownloadListener 拿到的是 `blob:https://localhost/...` 这样的 URL，原生侧
 * 无法读取 WebView 内部的 Blob。要拿到字节只能在网页侧读 —— 也就是必须走桥。
 *
 * 【方案：复用导入前备份已经验证过的分块原生协议】
 *   beginBackup → appendBackupChunk × N（256 KB/块）→ finishBackup
 * 失败 abortBackup 删临时文件；finish 时原生再流式写 Documents（API 29+ 走
 * MediaStore + IS_PENDING，API 24–28 写应用专属外部目录）。
 * 这条链路在 0.2.1 的大归档导入里已经跑过真实数据（单次桥负载从 69.6 MB 降到
 * ≤341 KB），所以这里不再新造协议。
 *
 * 文件职责：
 *   native-backup.ts —— 分块循环 `saveArchiveToDevice()`（导入备份也复用它）
 *   export-bridge.ts —— 编排：生成 ZIP（0–60%）→ 保存（60–100%）→ 成功/失败/重试
 *   export-ui.ts     —— 三态浮层；成功时显示完整落盘路径，失败时显示原因 + 重试
 *
 * 【为什么只改原生分支】
 * `SettingsDialog` 是桌面端共享组件，不能为了手机改变浏览器行为。
 * 因此在 `onExport` 里用 `isNativeShell()` 分叉：原生壳走新链路，浏览器原样保留
 * 上游的 blob 下载。桌面端渲染、布局、交互零变化。
 *
 * 【文件名与目录】
 * 原生壳写 `Documents/DeepChat/deep-chat-export-<YYYYMMDD>-<HHMMSS>.zip`。
 * 精确到秒是刻意的：MediaStore 允许同名（会变成 xxx (1).zip，返回路径对不上），
 * API 24–28 的直接文件写入甚至会同名覆盖 —— 用户第二次导出就会丢上一份。
 * 与导入前备份 `deep-chat-backup-<时间>.zip` 同目录、同前缀风格。
 *
 * 【失败语义】
 * 导出是只读操作，失败时本机会话零改动。浮层不关闭，提供「重试 / 关闭」；
 * 重试会重新生成并重新上传，上一次的临时文件由原生 abort 清掉。
 */

// ── 改动 1：原生分支的 import ───────────────────────────────────────────────
import { isNativeShell } from '../../shell/bridge.js'
import { exportHistoryToDevice } from '../../shell/export-bridge.js'

// ── 改动 2：onExport 里的原生分支（浏览器路径原样保留） ─────────────────────
const onExport = async () => {
  setBusy(true)
  setStatus(null)
  try {
    if (isNativeShell()) {
      const path = await exportHistoryToDevice()
      if (path) {
        // 浮层关闭后设置页仍能看到「已保存到 …」，用户回头找得到
        setStatus({ key: 'historyExportSaved', params: { path } })
      }
      return
    }
    const { name, blob } = await exportHistory()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (error) {
    setStatus(errorStatus('historyExportFailed', error))
  } finally {
    setBusy(false)
  }
}

// ── 改动 3：进度回调（backup.ts 的 snapshot 版） ────────────────────────────
const { blob } = await exportHistory((done, total) => {
  ui.update({
    kind: 'generate',
    phase: done >= total ? '正在打包 ZIP…' : '正在生成备份文件',
    done,
    total,
  })
})

// ── 改动 4：分块落盘 + 结果浮层 ─────────────────────────────────────────────
const path = await saveArchiveToDevice(blob, fileName, (written, total) => {
  ui.update({
    kind: 'save',
    phase: written >= total ? '正在写入 Documents…' : '正在保存到手机…',
    done: written,
    total,
  })
})
ui.succeed(path, blob.size)
