/**
 * 壳层最小 UI 工具 —— web-patches/ui.ts
 *
 * 【为什么不用 React / 上游组件】
 * 引导层和导入结果页都是「壳」的一次性界面，不是上游 UI 的一部分。
 * 用纯 DOM 实现有三个实际好处：
 *   1. 不用改上游任何一个 .tsx，上游升级时零冲突；
 *   2. 能在 React 挂载前/卸载后独立存在，不受 App 重渲染影响；
 *   3. 不依赖上游 CSS Modules 的哈希类名（`dialog-_85c1b` 之类），
 *      上游一改样式这些哈希就变，选择器会静默失效。
 *
 * 【为什么颜色写死而不读上游设计令牌】
 * 上游令牌（--dsw-alias-*）只在 App 的根容器上定义，壳层 DOM 挂在 body 下，
 * 继承不到。所以这里按 prefers-color-scheme 自己取一套最小色板 —— 深浅色跟随系统，
 * 与 App 的观感一致，但不依赖上游的令牌名（那个更不稳定）。
 */

/** 与上游 setupTheme 一致：跟随系统深浅色 */
const prefersDark = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

export type Palette = {
  overlay: string
  card: string
  text: string
  muted: string
  field: string
  border: string
  primary: string
  danger: string
  success: string
}

export const palette = (): Palette => {
  const dark = prefersDark()
  return {
    overlay: 'rgba(0,0,0,0.45)',
    card: dark ? '#272730' : '#ffffff',
    text: dark ? '#f5f5f7' : '#1a1a1a',
    muted: dark ? '#9b9ba3' : '#6b6b73',
    field: dark ? '#1f1f27' : '#f5f5f7',
    border: dark ? '#3a3a44' : '#e0e0e5',
    primary: '#4d6bfe',
    danger: '#e5484d',
    success: dark ? '#4ade80' : '#16a34a',
  }
}

/**
 * 全屏遮罩 + 居中卡片。
 * 遮罩自己避让安全区：壳层界面在最上层，`.frame` 上的 padding 管不到它。
 */
export const createDialog = (id: string): { host: HTMLDivElement; card: HTMLDivElement } => {
  const c = palette()
  const host = document.createElement('div')
  host.id = id
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'true')
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483000',
    `background:${c.overlay}`,
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'padding-top:calc(24px + env(safe-area-inset-top, 0px))',
    'padding-bottom:calc(24px + env(safe-area-inset-bottom, 0px))',
    'box-sizing:border-box',
    '-webkit-backdrop-filter:blur(2px)',
    'backdrop-filter:blur(2px)',
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = [
    'width:100%',
    'max-width:380px',
    'max-height:100%',
    'overflow:auto',
    `background:${c.card}`,
    `color:${c.text}`,
    'border-radius:24px',
    'padding:24px',
    'box-sizing:border-box',
    'font-size:14px',
    'line-height:22px',
    'box-shadow:0 12px 32px rgba(0,0,0,0.18)',
    'font-family:system-ui,-apple-system,"HarmonyOS Sans",sans-serif',
    // 防止鸿蒙 WebView 的点击高亮把按钮染成灰色
    '-webkit-tap-highlight-color:transparent',
  ].join(';')
  host.append(card)
  return { host, card }
}

export const title = (text: string): HTMLDivElement => {
  const node = document.createElement('div')
  node.style.cssText = 'font-size:18px;font-weight:600;line-height:26px;margin-bottom:16px'
  node.textContent = text
  return node
}

export const paragraph = (text: string, color = palette().muted): HTMLDivElement => {
  const node = document.createElement('div')
  node.style.cssText = `color:${color};font-size:13px;line-height:20px`
  node.textContent = text
  return node
}

export type ButtonTone = 'primary' | 'outline' | 'danger'

export const button = (
  text: string,
  tone: ButtonTone,
  onClick: () => void,
  flex = 1
): HTMLButtonElement => {
  const c = palette()
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = text
  node.style.cssText = [
    `flex:${flex}`,
    'padding:12px',
    'border-radius:12px',
    'font-size:15px',
    'font-weight:500',
    'font-family:inherit',
    'cursor:pointer',
    tone === 'primary' ? 'border:none' : `border:1px solid ${c.border}`,
    tone === 'primary'
      ? `background:${c.primary};color:#fff`
      : tone === 'danger'
        ? `background:transparent;color:${c.danger};border-color:${c.danger}`
        : `background:transparent;color:${c.text}`,
  ].join(';')
  node.addEventListener('click', onClick)
  return node
}

export const row = (gap = 8): HTMLDivElement => {
  const node = document.createElement('div')
  node.style.cssText = `display:flex;gap:${gap}px;margin-top:16px`
  return node
}

/** 等两帧再弹，避免遮罩下面是白屏 */
export const nextPaint = (): Promise<void> =>
  new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
