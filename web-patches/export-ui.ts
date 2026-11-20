/**
 * 导出浮层 —— web-patches/export-ui.ts
 *
 * 【为什么需要三态而不是一个 toast】
 * 用户实测的反馈是「点了导出没有提示，不知道进度，也不知道是否失败」。
 * 导出在手机上是分钟级操作：生成 ZIP（读 IndexedDB、序列化会话、打包）→
 * 分块过桥 → 原生写 Documents。任何一个环节失败都必须让用户看见，
 * 而且成功时要把**落盘路径**明确写出来 —— 否则用户不知道去哪找文件。
 *
 * 三态：
 *   progress —— 阶段文案 + 进度条 + 计数；导出期间不可关闭（避免用户以为取消了）
 *   success  —— 完整路径 + 文件大小，一个「知道了」
 *   failure  —— 失败原因 + 「重试 / 关闭」；本机数据零改动
 *
 * 【为什么用纯 DOM 而不是 React】
 * 与 import-ui.ts 同理：不改上游 .tsx、不依赖 CSS Modules 的哈希类名、
 * 不随 App 重渲染消失。颜色用 ui.ts 的最小色板，深浅色跟随系统。
 *
 * 【测试钩子】
 * 根节点写 data-export-state / data-export-percent / data-export-path，
 * accept 场景据此断言「进度可见」「路径正确」「失败可重试」，
 * 而不是去猜文案或像素。
 */

import { button, createDialog, palette, paragraph, row, title } from './ui.js'

export type ExportView = {
  /** generate = 正在生成 ZIP；save = 正在写入 Documents */
  kind: 'generate' | 'save'
  /** 当前阶段的人话描述 */
  phase: string
  /** 已完成量（会话条数 / 字节数） */
  done: number
  /** 总量（会话条数 / 字节数） */
  total: number
}

export type ExportDialog = {
  /** 回到「进行中」并清零（失败后重试用） */
  reset: () => void
  update: (view: ExportView) => void
  succeed: (path: string, size: number) => void
  fail: (message: string, actions: { onRetry: () => void; onClose: () => void }) => void
  close: () => void
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 生成阶段占 0–60%，保存阶段占 60–100%；两段合成一条单调递增的进度 */
const percentOf = (view: ExportView): number => {
  const ratio = view.total > 0 ? Math.min(1, view.done / view.total) : 0
  const raw = view.kind === 'generate' ? ratio * 60 : 60 + ratio * 40
  return Math.max(0, Math.min(100, Math.round(raw)))
}

export const showExportDialog = (): ExportDialog => {
  const c = palette()
  const { host, card } = createDialog('shell-export')
  host.setAttribute('data-export-state', 'progress')
  host.setAttribute('data-export-percent', '0')
  document.body.append(host)

  const clear = (): void => {
    card.textContent = ''
  }

  // 进行中的 DOM 引用；切到成功/失败后置空，update() 便不再写它们
  let phaseLine: HTMLDivElement | null = null
  let fill: HTMLDivElement | null = null
  let counter: HTMLDivElement | null = null

  const reset = (): void => {
    clear()
    host.setAttribute('data-export-state', 'progress')
    host.setAttribute('data-export-percent', '0')
    delete host.dataset.exportPath
    card.append(title('正在导出历史会话'))
    phaseLine = paragraph('准备中…', c.text)
    phaseLine.style.marginTop = '4px'
    card.append(phaseLine)

    const track = document.createElement('div')
    track.style.cssText = [
      'margin-top:16px',
      'height:6px',
      'border-radius:3px',
      `background:${c.field}`,
      'overflow:hidden',
    ].join(';')
    fill = document.createElement('div')
    fill.style.cssText = [
      'height:100%',
      'width:0%',
      'border-radius:3px',
      `background:${c.primary}`,
      'transition:width 120ms linear',
    ].join(';')
    track.append(fill)
    card.append(track)

    counter = paragraph('', c.muted)
    counter.style.marginTop = '8px'
    card.append(counter)

    const hint = paragraph('导出期间请保持应用在前台，不要关闭本应用。', c.muted)
    hint.style.marginTop = '12px'
    card.append(hint)
  }

  /**
   * 更新进度。
   *
   * 导出生成阶段每处理一条会话就回调一次；直接写 DOM 会拖慢本来就慢的导出，
   * 因此同一帧内只渲染最后一次。保存阶段块与块之间本来就让过帧，这里同样合并。
   */
  let pending: ExportView | null = null
  let scheduled = false
  const flush = (): void => {
    scheduled = false
    const view = pending
    pending = null
    if (!view || !phaseLine || !fill || !counter) {
      return
    }
    const percent = percentOf(view)
    host.setAttribute('data-export-percent', String(percent))
    phaseLine.textContent = view.phase
    fill.style.width = `${percent}%`
    counter.textContent =
      view.kind === 'generate'
        ? `${view.done} / ${view.total} 个会话（${percent}%）`
        : `${formatBytes(view.done)} / ${formatBytes(view.total)}（${percent}%）`
  }

  const update = (view: ExportView): void => {
    pending = view
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }

  const succeed = (path: string, size: number): void => {
    phaseLine = null
    fill = null
    counter = null
    clear()
    host.setAttribute('data-export-state', 'success')
    host.setAttribute('data-export-percent', '100')
    host.setAttribute('data-export-path', path)
    card.append(title('导出完成'))
    card.append(paragraph(`已保存到：${path}`, c.text))
    card.append(paragraph(`文件大小 ${formatBytes(size)}`, c.muted))
    const hint = paragraph('可在「文件管理 → 文档 → DeepChat」中找到这个 ZIP。', c.muted)
    hint.style.marginTop = '8px'
    card.append(hint)

    const actions = row()
    actions.append(button('知道了', 'primary', close))
    card.append(actions)
  }

  const fail = (
    message: string,
    actions: { onRetry: () => void; onClose: () => void }
  ): void => {
    phaseLine = null
    fill = null
    counter = null
    clear()
    host.setAttribute('data-export-state', 'error')
    delete host.dataset.exportPath
    card.append(title('导出失败'))
    const reason = paragraph(message, c.danger)
    reason.style.wordBreak = 'break-word'
    card.append(reason)
    const hint = paragraph('本机已有的会话没有被改动。可以重试，或先检查手机剩余空间。', c.muted)
    hint.style.marginTop = '12px'
    card.append(hint)

    const buttons = row()
    buttons.append(button('重试', 'primary', actions.onRetry))
    buttons.append(button('关闭', 'outline', actions.onClose))
    card.append(buttons)
  }

  const close = (): void => {
    host.remove()
  }

  // 默认就是「进行中」：调用方即使忘了 reset() 也不会看到一张空卡片
  reset()

  return { reset, update, succeed, fail, close }
}
