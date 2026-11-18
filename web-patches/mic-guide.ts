/**
 * 麦克风失败引导 —— web-patches/mic-guide.ts
 *
 * 【为什么需要它】
 * 上游 useVoiceInput 已经能区分 NotAllowedError / NotFoundError 并给 toast，
 * 但有一类失败它没法处理：用户之前选了「不再询问」。此时：
 *   • 系统不会再弹权限框；
 *   • 网页拿到的仍然是 NotAllowedError；
 *   • 用户点了录音只有一条「没有麦克风权限」的 toast，不知道下一步该干什么。
 *
 * 唯一出路是去系统设置里手动开。网页无法发起这个跳转，只能靠原生。
 * 所以这里在录音失败后补一次原生状态查询：如果确认是「永久拒绝」，
 * 就弹一个带「去设置」按钮的小浮层。
 *
 * 【为什么只在这种情况弹窗】
 * 正常的首次授权由 Capacitor 的 BridgeWebChromeClient 直接处理（系统弹框），
 * 我们不插手。只有「已经被拒绝且系统不会再问」才需要额外交互 ——
 * 否则每次录音失败都弹窗会很烦人。
 *
 * 【为什么不在成功路径上预检】
 * 预检需要在点击手势内完成一次 IPC 往返，会推迟 getUserMedia，
 * 反而容易错过音频输出的用户手势窗口。让正常路径零成本、失败路径才补救。
 */

import { PLUGIN_MIC, callNative, isNativeShell } from './bridge.js'
import { button, createDialog, palette, paragraph, row, title } from './ui.js'

/** 与 native/mic-permission 的 check() 返回结构对应 */
type MicState = {
  state: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  canRequest: boolean
  blocked: boolean
}

/**
 * 原生不可用或调用失败时返回 null，调用方当作「不知道」处理。
 * 这里不用 bridge.ts 的 tryNative：那个会把非 NOT_NATIVE 的错误继续抛出，
 * 而本函数的调用点已经在错误处理路径上 —— 引导本身再抛错只会掩盖原始问题。
 */
const readMicState = async (): Promise<MicState | null> => {
  if (!isNativeShell()) {
    return null
  }
  try {
    return await callNative<MicState>(PLUGIN_MIC, 'check')
  } catch {
    return null
  }
}

/**
 * 在录音失败后调用。返回 true 表示已经接管了这个错误（弹了引导浮层），
 * 调用方不必再显示自己的提示。
 *
 * 只有「明确被永久拒绝」才接管；其余情况返回 false，交回上游的 toast。
 */
export const guideBlockedMic = async (): Promise<boolean> => {
  const state = await readMicState()
  if (!state || !state.blocked) {
    return false
  }

  const c = palette()
  const { host, card } = createDialog('shell-mic-blocked')
  card.append(
    title('需要麦克风权限'),
    paragraph(
      '系统已不再询问麦克风的授权，语音输入无法使用。请到「设置 → 应用 → Deep Chat → 权限」中允许麦克风。',
      c.muted
    )
  )
  const actions = row()
  actions.append(
    button('去设置', 'primary', () => {
      host.remove()
      // 失败也不提示：用户已经离开页面去设置了，弹错没有意义
      void callNative(PLUGIN_MIC, 'openSettings').catch(() => {})
    }),
    button('知道了', 'outline', () => host.remove())
  )
  card.append(actions)
  document.body.append(host)
  return true
}
