/**
 * 导入结果页 —— web-patches/import-ui.ts
 *
 * 【为什么单独做一个结果页】
 * 需求 §P3 要求导入结束后明确告诉用户 {added, updated, skipped, failed}。
 * 上游的导入只有一句「已导入 N 个对话」，因为它是**覆盖**语义 —— 只有「成/败」两种结果。
 * 改成合并之后，四种情况都可能同时出现，用户必须看到分布，否则
 * 「我导了 300 个对话怎么只多了 12 个」会变成无法解释的疑问。
 *
 * 【为什么失败要逐条列出】
 * 合并导入是「坏的跳过、好的照进」，不会整批失败。如果只报数字不给原因，
 * 用户没法判断该重导还是该修文件。最多列 5 条，避免撑爆屏幕。
 *
 * 【为什么备份路径也要显示】
 * 这是用户唯一的退路。备份失败时导入会直接中止（见 import-bridge.ts），
 * 所以走到这里一定有路径；仍然显式展示，让用户知道去哪里找这份备份。
 */

import type { MergeResult } from './import-bridge.js'
import { button, createDialog, nextPaint, palette, paragraph, row, title } from './ui.js'

type Line = { label: string; value: number; color?: string }

/** 一行统计：`新增 12` */
const statLine = (line: Line): HTMLDivElement => {
  const c = palette()
  const node = document.createElement('div')
  node.style.cssText =
    'display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;font-size:14px'
  const label = document.createElement('span')
  label.textContent = line.label
  label.style.cssText = `color:${c.muted}`
  const value = document.createElement('span')
  value.textContent = String(line.value)
  value.style.cssText = `font-weight:600;font-size:16px;color:${line.color ?? c.text}`
  node.append(label, value)
  return node
}

export const showImportResult = async (result: MergeResult): Promise<void> => {
  await nextPaint()
  const c = palette()
  const { host, card } = createDialog('shell-import-result')

  const total = result.added + result.updated + result.skipped + result.failed
  card.append(title(result.failed > 0 ? '导入完成（部分未导入）' : '导入完成'))
  card.append(paragraph(`ZIP 中共 ${total} 个对话`, c.muted))

  const stats = document.createElement('div')
  stats.style.cssText = 'margin-top:12px'
  stats.append(
    statLine({ label: '新增', value: result.added, color: c.success }),
    statLine({ label: '更新', value: result.updated }),
    statLine({ label: '跳过（已导入过或本机更新）', value: result.skipped }),
    statLine({
      label: '失败',
      value: result.failed,
      color: result.failed > 0 ? c.danger : undefined,
    })
  )
  card.append(stats)

  if (result.errors.length > 0) {
    const box = document.createElement('div')
    box.style.cssText = [
      'margin-top:12px',
      'padding:10px 12px',
      'border-radius:12px',
      `background:${c.field}`,
      `color:${c.muted}`,
      'font-size:12px',
      'line-height:18px',
      'white-space:pre-wrap',
      'word-break:break-all',
    ].join(';')
    box.textContent = result.errors.join('\n')
    card.append(box)
  }

  if (result.backupPath) {
    card.append(
      paragraph(`导入前的备份已保存到：${result.backupPath}`, c.muted)
    )
  }

  const actions = row()
  actions.append(button('知道了', 'primary', () => host.remove()))
  card.append(actions)
  document.body.append(host)
}

/** 导入进度：调用方每次推进时更新这组数值 */
export type ImportProgress = {
  /** 当前阶段的人话描述，如「正在解析会话」「正在写入本机」 */
  phase: string
  /** 已完成数量；未知时为 null */
  done: number | null
  /** 总量；未知时为 null */
  total: number | null
}

/**
 * 导入进度浮层 —— 解决「导入要几分钟，中间完全不知道在干什么」。
 *
 * 【为什么必须做】
 * 用户实测：导入后列表没出现会话，过了好几分钟才静默成功，
 * 期间一直以为失败了。合并导入要解压、逐条解析、逐条写 IndexedDB，
 * 大归档在手机上就是分钟级操作 —— 没有反馈，用户只会当成卡死然后杀掉应用。
 *
 * 【为什么返回 {update, close} 而不是自己管生命周期】
 * 进度浮层必须由调用的那一侧在 try/finally 里关掉，
 * 否则导入抛错时会留一个永远停在 99% 的遮罩，比没有更糟。
 */
export const showImportProgress = (initial: ImportProgress): {
  update: (next: ImportProgress) => void
  close: () => void
} => {
  const c = palette()
  const { host, card } = createDialog('shell-import-progress')

  card.append(title('正在导入历史会话'))
  const phaseLine = paragraph(initial.phase, c.text)
  phaseLine.style.marginTop = '4px'
  card.append(phaseLine)

  // 进度条：外层轨道 + 内层填充
  const track = document.createElement('div')
  track.style.cssText = [
    'margin-top:16px',
    'height:6px',
    'border-radius:3px',
    `background:${c.field}`,
    'overflow:hidden',
  ].join(';')
  const fill = document.createElement('div')
  fill.style.cssText = [
    'height:100%',
    'width:0%',
    'border-radius:3px',
    `background:${c.primary}`,
    'transition:width 120ms linear',
  ].join(';')
  track.append(fill)
  card.append(track)

  const counter = paragraph('', c.muted)
  counter.style.marginTop = '8px'
  card.append(counter)

  const hint = paragraph('导入期间请保持应用在前台，不要关闭本应用。', c.muted)
  hint.style.marginTop = '12px'
  card.append(hint)

  document.body.append(host)

  /**
   * 更新进度。
   *
   * 每次推进都写 DOM 会拖慢本来就不快的导入（尤其逐条写库时），
   * 因此合并到下一帧再落地：同一帧内多次 update 只渲染最后一次。
   */
  let pending: ImportProgress | null = null
  let scheduled = false
  const flush = () => {
    scheduled = false
    const next = pending
    pending = null
    if (!next) {
      return
    }
    phaseLine.textContent = next.phase
    if (next.done !== null && next.total !== null && next.total > 0) {
      const percent = Math.min(100, Math.round((next.done / next.total) * 100))
      fill.style.width = `${percent}%`
      counter.textContent = `${next.done} / ${next.total}（${percent}%）`
    } else if (next.done !== null) {
      fill.style.width = '100%'
      counter.textContent = `${next.done} 项`
    } else {
      // 总量未知：给一段固定填充，配合文案表明仍在进行
      fill.style.width = '35%'
      counter.textContent = ''
    }
  }

  return {
    update: (next) => {
      pending = next
      if (!scheduled) {
        scheduled = true
        requestAnimationFrame(flush)
      }
    },
    close: () => {
      host.remove()
    },
  }
}
