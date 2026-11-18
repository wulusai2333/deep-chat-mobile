/**
 * 首启引导 —— web-patches/onboarding.ts
 *
 * 【为什么需要它】
 * 上游用 `ensureApiKey()`（没 Key 就弹出设置窗）做首次引导，但它默认用户知道
 * 「这个 Key 会以明文躺在浏览器存储里」。装成 APK 之后有两个新事实必须讲清楚：
 *   1. Key 存在系统的加密存储里（Keystore + EncryptedSharedPreferences），不是明文；
 *   2. 会话数据只在本机 IndexedDB，不上传任何第三方服务器。
 * 不讲清楚的话，用户不知道卸载/换机意味着什么。这是需求 §P1 要求的 3 步引导。
 *
 * 【为什么它必须抢在 App 首屏之前】
 * App.tsx 挂载时会调 `ensureApiKey()`，没 Key 就自动打开设置弹窗。如果不管，
 * 用户会先看到「设置 - 数据管理」这个不该出现在第一次打开时的界面。
 * 所以壳在 render 之前就把 Key 读进内存，并在「本机没有 Key」时置
 * `window.__CHAT_DEMO_ONBOARDING__`，让上游的 `ensureApiKey()` 让位（见
 * prepare-web.mjs 的补丁 2c）。用户填完 Key 或跳过之后该标志复位，
 * Key 提示重新回到上游手里 —— 跳过时主动打开上游设置弹窗兜底。
 *
 * 【为什么用纯 DOM 而不是 React】
 * 见 ui.ts 的文件头：壳层界面不碰上游组件树，上游升级时零冲突。
 *
 * 【状态存哪里】
 * 只有「引导是否完成」这一个布尔标记进 localStorage（`chat-demo:onboarded`）。
 * API Key 进加密存储 —— 两者严格分开，本文不碰 Key 的持久化，
 * 一律通过上游的 `setApiKey()` 走 `window.__CHAT_DEMO_KEYSTORE__`。
 */

import { openSettings } from '../components/settings/settingsDialogState.js'
import { verifyApiKey } from '../services/api/client.js'
import { setApiKey } from '../services/settings.js'
import { isNativeShell } from './bridge.js'
import { readLocalStorage, writeLocalStorage } from './storage-utils.js'
import {
  button,
  createDialog,
  nextPaint,
  palette,
  paragraph,
  row,
  title,
} from './ui.js'

const ONBOARDED_KEY = 'chat-demo:onboarded'

/** 三步说明文案。放在一起便于以后本地化 */
const INTRO_POINTS: readonly [string, string][] = [
  ['数据只保存在本机', '对话记录存在手机的本地数据库里，不会上传到任何第三方服务器。'],
  ['API Key 加密保存', 'Key 由系统 Keystore 加密后存储，即使手机丢失也不会泄露。'],
  ['卸载会清空数据', '请在卸载或换机前，先用「设置 → 数据管理 → 导出」把历史会话备份成 ZIP。'],
]

/**
 * 渲染引导层。返回 true 表示用户已经配好 Key。
 * 不用 alert/confirm —— 鸿蒙 WebView 对系统对话框的样式不可控。
 */
const renderOnboarding = (): Promise<boolean> =>
  new Promise((resolve) => {
    const c = palette()
    const { host, card } = createDialog('shell-onboarding')
    let settled = false

    /** 结束引导：只写一个布尔标记，不写任何敏感内容 */
    const finish = (completed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      writeLocalStorage(ONBOARDED_KEY, completed ? '1' : null)
      host.remove()
      resolve(completed)
    }

    const renderIntro = (): void => {
      card.replaceChildren(title('开始使用'))
      for (const [heading, body] of INTRO_POINTS) {
        const block = document.createElement('div')
        block.style.cssText = 'margin-bottom:14px'
        const h = document.createElement('div')
        h.style.cssText = 'font-weight:500'
        h.textContent = heading
        block.append(h, paragraph(body))
        card.append(block)
      }
      const actions = row()
      actions.append(button('下一步', 'primary', renderKey, 2))
      card.append(actions)
      // 允许跳过：用户可能想先看看界面。跳过不写标记，下次启动还会引导。
      const skip = document.createElement('div')
      skip.style.cssText = `text-align:center;margin-top:12px;color:${c.muted};font-size:13px;padding:8px;cursor:pointer`
      skip.textContent = '先跳过'
      skip.addEventListener('click', () => finish(false))
      card.append(skip)
    }

    const renderKey = (): void => {
      card.replaceChildren(title('填写 API Key'))
      card.append(
        paragraph('在 DeepSeek 开放平台创建的 API Key，只保存在这台设备上。', c.muted)
      )

      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = 'sk-...'
      input.style.cssText = [
        'width:100%',
        'box-sizing:border-box',
        'margin-top:12px',
        'padding:12px 14px',
        `border:1px solid ${c.border}`,
        'border-radius:12px',
        `background:${c.field}`,
        `color:${c.text}`,
        'font-size:15px',
        'font-family:inherit',
        'outline:none',
        // 16px 以下 iOS/鸿蒙会把输入框放大
        'min-height:44px',
      ].join(';')

      const status = document.createElement('div')
      status.style.cssText = 'min-height:20px;font-size:13px;line-height:20px;margin-top:8px'

      const actions = row()
      const back = button('上一步', 'outline', renderIntro)
      const save = button('保存', 'primary', () => void submit(), 2)
      actions.append(back, save)
      card.append(input, status, actions)

      // 稍等一帧再聚焦，否则极旧内核上 focus 会被随后的布局覆盖
      setTimeout(() => input.focus(), 50)

      const submit = async (): Promise<void> => {
        const value = input.value.trim()
        if (!value) {
          status.style.color = c.danger
          status.textContent = '请填写 API Key'
          return
        }
        status.style.color = c.muted
        status.textContent = '正在校验…'
        back.disabled = true
        save.disabled = true
        try {
          // GET /models 不产生费用，是最轻的校验（与上游 useApiKeyForm 一致）
          await verifyApiKey(value)
          // 交给上游的 setApiKey：原生壳下它只写加密存储，绝不碰 localStorage
          setApiKey(value)
          status.style.color = c.success
          status.textContent = '校验通过'
          finish(true)
        } catch {
          status.style.color = c.danger
          status.textContent = '校验失败：Key 无效或网络不可用'
          back.disabled = false
          save.disabled = false
        }
      }

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          void submit()
        }
      })
    }

    renderIntro()
    document.body.append(host)
  })

/**
 * 该不该显示引导。三个条件同时满足才显示：
 *   1. 跑在原生壳里 —— 浏览器 / PWA 不打扰用户，上游自己的 `ensureApiKey` 够了；
 *   2. 本机还没有可用 Key —— 有 Key 说明配过了，不必再教育一遍（顺手补上标记）；
 *   3. 没有「已完成引导」标记。
 *
 * 【交还给上游的两个出口】
 * 引导是「额外」的一层，绝不能把用户困住。因此无论结果如何都要复位
 * `__CHAT_DEMO_ONBOARDING__`：
 *   • 用户填完 Key → 上游 ensureApiKey() 下次自然为 true；
 *   • 用户点「先跳过」→ 立刻打开上游的设置弹窗，让用户在自己熟悉的地方填。
 * 后者是本文件唯一的「额外依赖」：调上游的 openSettings，不复制它的 UI。
 */
export const maybeShowOnboarding = async (hasKey: boolean): Promise<void> => {
  if (!isNativeShell() || readLocalStorage(ONBOARDED_KEY) === '1') {
    // 不需要引导，把「接管 Key 提示」的职责还给上游
    window.__CHAT_DEMO_ONBOARDING__ = false
    return
  }
  if (hasKey) {
    // 已经有 Key：直接记成已完成，避免下次启动再弹
    writeLocalStorage(ONBOARDED_KEY, '1')
    window.__CHAT_DEMO_ONBOARDING__ = false
    return
  }
  // React 首屏画完再弹，避免遮罩下面一片白
  await nextPaint()
  const completed = await renderOnboarding()
  // 复位：从此 Key 提示回到上游的 ensureApiKey() 手里
  window.__CHAT_DEMO_ONBOARDING__ = false
  if (!completed) {
    // 跳过引导 → 用上游既有的设置弹窗兜底，不让用户无处输入 Key
    openSettings('data')
  }
}
