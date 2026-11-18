/**
 * 本地用户头像 —— web-patches/mobile/common/localAvatar.ts
 *
 * 【默认头像 = App 图标】
 * 官方 App 的本地账户行默认显示应用图标；这里直接复用 `assets/app-icon.jpeg` 的
 * 192×192 JPEG（生成见 scripts/make-icons.mjs → app-icon-data.ts），和启动器图标
 * 是同一张源图，换图标后跑一次 `pnpm icons` 即可同步。
 *
 * 【用户替换存哪里】
 * localStorage（一条 data:image/... 的 data URL），不写 IndexedDB：
 *   • 合并导入的 commitStaging 会清空 files 表，头像存那里会被一次导入弄丢；
 *   • 头像属于「本机外观偏好」，不属于会话数据，不应进导出的 ZIP。
 * 单张限 512 KB 以内（人选的图片会先被压到 256×256 JPEG，通常 20–60 KB）。
 *
 * 【状态同步】
 * useSyncExternalStore + 自定义事件：同一个页面内多个读取方（目前只有抽屉）都能
 * 立即刷新；跨标签页再挂一个 storage 事件。localStorage 不可用（隐私模式）时
 * 退回内存值，至少本次会话内能正常切换。
 */

import { useSyncExternalStore } from 'react'
import { APP_ICON_DATA_URL } from './app-icon-data.js'

/** localStorage 键：带项目前缀，避免和上游的 key 撞 */
export const LOCAL_AVATAR_KEY = 'deep-chat:local-avatar'
/** 页内广播事件名 */
const CHANGE_EVENT = 'deep-chat:local-avatar-change'
/** data URL 上限；256×256 JPEG 实际远小于这个值 */
const MAX_AVATAR_CHARS = 512 * 1024

const isAvatarDataUrl = (value: string | null): value is string =>
  value !== null && value.startsWith('data:image/') && value.length <= MAX_AVATAR_CHARS

const readStoredAvatar = (): string | null => {
  try {
    const value = localStorage.getItem(LOCAL_AVATAR_KEY)
    return isAvatarDataUrl(value) ? value : null
  } catch {
    return null
  }
}

/** 内存兜底：localStorage 不可用时仍能切换（不持久化） */
let memoryAvatar: string | null = null
let cached: string | null = readStoredAvatar()

const listeners = new Set<() => void>()

const sync = (): void => {
  cached = readStoredAvatar()
  if (cached !== null) {
    // localStorage 里有值就以它为准；为 null 时保留内存兜底值（隐私模式不能写盘）
    memoryAvatar = null
  }
  for (const listener of listeners) {
    listener()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(CHANGE_EVENT, sync)
  window.addEventListener('storage', (event) => {
    if (event.key === LOCAL_AVATAR_KEY) {
      sync()
    }
  })
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前应显示的头像：用户自选优先，否则 App 图标 */
export const useLocalAvatar = (): string => {
  const custom = useSyncExternalStore(
    subscribe,
    () => cached ?? memoryAvatar,
    () => null
  )
  return custom ?? APP_ICON_DATA_URL
}

/** 是否已经换成用户自己的图（用于决定菜单里要不要显示「恢复默认头像」） */
export const hasCustomAvatar = (): boolean => cached !== null || memoryAvatar !== null

/** 保存用户自选头像（data URL）。返回是否成功写入 localStorage。 */
export const setLocalAvatar = (dataUrl: string): boolean => {
  if (!isAvatarDataUrl(dataUrl)) {
    throw new Error('invalid avatar data URL')
  }
  let persisted = true
  try {
    localStorage.setItem(LOCAL_AVATAR_KEY, dataUrl)
  } catch {
    // 配额满 / 禁写：退回内存，至少本次会话可见
    persisted = false
    memoryAvatar = dataUrl
  }
  cached = persisted ? dataUrl : null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
  return persisted
}

/** 恢复默认（App 图标） */
export const resetLocalAvatar = (): void => {
  try {
    localStorage.removeItem(LOCAL_AVATAR_KEY)
  } catch {
    // 忽略：下面照样清内存值
  }
  memoryAvatar = null
  cached = null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
}
