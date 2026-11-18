/**
 * 构建产物验收 —— scripts/accept.mjs
 *
 * 【这个脚本解决什么问题】
 * 规格要求「首次安装即可用、界面与桌面浏览器一致、Key 不落明文、语音可用、
 * 历史可导入」。其中「Key 加密」「语音权限」「SAF 导入」「开机注入」都依赖
 * Android 原生与真实设备，没有模拟器就无法验证。
 *
 * 但有一大类问题**可以在构建产物上直接验**：白屏、Key 注入时序、引导层是否
 * 出现、浏览器兜底路径是否异常、打包进 APK 的静态资源是否自洽。
 * 这类问题恰恰是最容易在上线后才暴露的（尤其白屏——用户在真机上看到的第一个
 * 也是唯一一个现象，而我们本地 `pnpm build` 成功并不代表能渲染）。
 *
 * 所以这里用真实的无头 Chromium 打开 `android/app/src/main/assets/public/`
 * （**已打包进 APK 的那份文件**，不是 dist/），注入一个模拟的
 * `window.Capacitor.nativePromise` 原生桥，然后检查：
 *
 *   1. 页面真的渲染出内容（不是白屏）
 *   2. 桥返回空 Key 时，引导层出现且 `__DEEP_CHAT_ONBOARDING__` 为 true
 *   3. 桥返回有效 Key 时，引导层不出现、Key 进入 `window.__RUNTIME_KEY__`
 *   4. 已引导过（localStorage 有标记）时不再打扰
 *   5. 纯浏览器（无桥）下不报错、不显示引导 —— PWA 兜底路径
 *   6. 安全区变量被计算出数值（A/B 档任一都要有值，不能是 undefined）
 *
 * 【它不能替代什么】
 * 真机验收（权限弹窗、TTS 声音、SAF 选文件、输入法、侧滑手势、字体回退）
 * 仍然必须按 docs/build.md §9.1 的清单人工过一遍。
 *
 * 用法：
 *   pnpm accept           # 跑全部
 *   pnpm accept --keep    # 保留截图与临时目录
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, step, warn } from './lib/env.mjs'
import { findBrowser, openBrowser, startStaticServer } from './lib/cdp.mjs'

const KEEP = process.argv.includes('--keep')
const WORK = join(paths.root, '.tmp', `accept-${Date.now()}-${process.pid}`)
const ASSETS = join(paths.root, 'android', 'app', 'src', 'main', 'assets', 'public')

const results = []
const check = (ok, label, detail) => {
  results.push({ ok, label, detail })
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
  const suffix = detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  process.stdout.write(`  ${mark} ${label}${suffix}\n`)
}

/**
 * 注入的原生桥替身。
 *
 * 只实现 web-patches/ 真正调用的方法，其余一律 reject —— 让「壳层调了不存在的方法」
 * 这类问题以异常暴露，而不是被静默返回 undefined 掩盖。
 */
const makeBridge = ({ apiKey }) => `
(() => {
  window.__BRIDGE_CALLS__ = []
  const apiKey = ${JSON.stringify(apiKey)}
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    nativePromise: (plugin, method, options) => {
      window.__BRIDGE_CALLS__.push(plugin + '.' + method)
      // 安全存储：读返回预设 Key，写/删只记调用
      if (plugin === 'DeepChatSecureStorage' && method === 'read') {
        return Promise.resolve({ value: apiKey })
      }
      if (plugin === 'DeepChatSecureStorage' && (method === 'write' || method === 'remove')) {
        return Promise.resolve({})
      }
      // 麦克风：默认未授权但可申请
      if (plugin === 'DeepChatMic' && method === 'check') {
        return Promise.resolve({ state: 'prompt', canRequest: true, blocked: false, oneTimeSupported: true })
      }
      // 文件：无待处理文件
      if (plugin === 'DeepChatFiles' && method === 'hasPendingFile') {
        return Promise.resolve({ pending: false })
      }
      return Promise.reject(new Error('unstubbed native call: ' + plugin + '.' + method))
    },
  }
})()
`

/** 在页面里收集渲染状态 */
const PROBE = `(() => {
  const root = document.getElementById('root')
  const onboarding = document.getElementById('shell-onboarding')
  const frame = document.querySelector("div[class*='frame-']")
  const styles = getComputedStyle(document.documentElement)
  const read = (name) => styles.getPropertyValue(name).trim()
  return {
    readyState: document.readyState,
    // 白屏判定：root 下有没有真正的内容
    rootChildren: root ? root.children.length : -1,
    rootText: root ? (root.textContent || '').trim().slice(0, 200) : '',
    // 对话框
    hasOnboarding: Boolean(onboarding),
    onboardingTitle: onboarding ? (onboarding.textContent || '').slice(0, 60) : null,
    // 壳层/上游的标志
    hasFrame: Boolean(frame),
    framePaddingTop: frame ? getComputedStyle(frame).paddingTop : null,
    // 全局状态
    runtimeKeySet: Boolean(window.__RUNTIME_KEY__),
    onboardingFlag: window.__DEEP_CHAT_ONBOARDING__,
    hasImportBridge: Boolean(window.__DEEP_CHAT_IMPORT__),
    hasKeyStore: Boolean(window.__DEEP_CHAT_KEYSTORE__),
    bridgeCalls: window.__BRIDGE_CALLS__ || [],
    // 安全区变量
    insetTop: read('--shell-inset-top'),
    insetRight: read('--shell-inset-right'),
    insetLeft: read('--shell-inset-left'),
    errors: window.__PAGE_ERRORS__ || [],
  }
})()`

/**
 * 一个场景：开浏览器 → 注入 → 导航 → 探测。
 *
 * 【scripts 用数组、并用 `;\n` 拼接】
 * 直接把多段脚本字符串相加会踩 ASI 陷阱：一段以 `})` 结尾、下一段以 `(` 开头时，
 * JavaScript 不会自动补分号，而会把它们解析成「调用上一段的返回值」——
 * 于是报出 `window.addEventListener(...) is not a function` 这种
 * 与真实原因毫无关系的错误（我们就踩过一次，排查方向被带偏很久）。
 */
const scenario = async ({ label, scripts, before, probe = PROBE }) => {
  const dir = join(WORK, label.replace(/[^a-z0-9-]/gi, '_'))
  mkdirSync(dir, { recursive: true })
  const server = await startStaticServer(ASSETS)
  let browser
  try {
    browser = await openBrowser({
      workDir: dir,
      initScript: scripts.filter(Boolean).join('\n;\n'),
    })
    await browser.navigate(`${server.url}/index.html`)
    // 等 React 挂载完成（root 有子节点），最多 20 秒
    await browser.waitFor(
      `(() => { const r = document.getElementById('root'); return !!r && r.children.length > 0 })()`,
      { timeoutMs: 20000, label: `${label}: 等待渲染` }
    ).catch(() => {
      // 白屏时不在这里抛错，交给随后的断言统一报（能给出更完整的现场）
    })
    if (before) {
      await before(browser)
    }
    return await browser.evaluate(probe)
  } finally {
    await browser?.close()
    await server.close()
  }
}

/**
 * 让页面自己 reload，并等新文档完成首屏渲染。
 *
 * 为什么需要它：`before(browser)` 拿不到 server.url，所以只能用 `location.reload()`；
 * 而 reload 提交的瞬间旧文档的执行上下文会被销毁，期间 CDP 求值会抛
 * 「Execution context was destroyed」，固定 sleep 又分不清「还在旧文档」还是
 * 「新文档已加载」（旧文档此时同样是渲染完成状态）。
 * 做法：先在旧文档埋一个窗口标记，reload 后轮询标记消失 = 新文档已接管，
 * 最后再等 React 重新挂载。
 */
const reloadPage = async (browser) => {
  await browser.evaluate(`window.__ACCEPT_DOC_MARK__ = String(Date.now())`)
  await browser.evaluate(`(location.reload(), true)`).catch(() => {
    // 个别内核会在返回值序列化前就销毁上下文；导航本身已经发起，继续等新文档
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      if (await browser.evaluate(`typeof window.__ACCEPT_DOC_MARK__ === 'undefined'`)) {
        break
      }
    } catch {
      // reload 提交瞬间执行上下文被销毁，下一轮重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await browser.waitFor(
    `(() => { const root = document.getElementById('root'); return !!root && root.children.length > 0 })()`,
    { timeoutMs: 15000, label: 'reload 后等待渲染' }
  )
  // 设置/会话列表都从 IndexedDB 异步恢复，留一点时间再断言
  await browser.evaluate(`new Promise((resolve) => setTimeout(resolve, 500))`)
}

const main = async () => {
  step('构建产物验收（无头 Chromium）')

  if (!findBrowser()) {
    warn('没找到 Chrome / Edge，跳过验收')
    return
  }
  if (!existsSync(join(ASSETS, 'index.html'))) {
    fail('找不到已打包的静态资源', `期望 ${ASSETS}/index.html，请先跑 pnpm cap:sync`)
  }

  // 每个页面都记录未捕获异常，供白屏排查
  const ERROR_TRAP = `
    window.__PAGE_ERRORS__ = []
    window.addEventListener('error', (e) => {
      window.__PAGE_ERRORS__.push(String(e.message) + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno)
    })
    window.addEventListener('unhandledrejection', (e) => {
      window.__PAGE_ERRORS__.push('unhandled: ' + String(e.reason && e.reason.stack || e.reason))
    })
  `

  // ══ 场景 A：首次安装，壳内无 Key → 应出现引导层 ══
  info('A. 首次安装（无 Key）')
  const fresh = await scenario({
    label: 'fresh',
    scripts: [ERROR_TRAP, makeBridge({ apiKey: null }), 'window.localStorage.clear()'],
  })
  check(fresh.rootChildren > 0, 'A1 页面渲染出内容（非白屏）', {
    rootChildren: fresh.rootChildren,
    text: fresh.rootText.slice(0, 40),
  })
  check(fresh.errors.length === 0, 'A2 无未捕获异常', fresh.errors)
  check(fresh.hasOnboarding === true, 'A3 出现首次引导层')
  // 断言「是欢迎首屏」而不是某个具体字符串：文案改过一次，硬编码容易悄悄失效。
  // 同时要求出现产品名，防止退回成上游的 demo 措辞。
  check(
    typeof fresh.onboardingTitle === 'string' &&
      fresh.onboardingTitle.includes('Deep Chat') &&
      !/demo|演示/i.test(fresh.onboardingTitle),
    'A4 引导层是欢迎首屏且带产品名',
    fresh.onboardingTitle
  )
  check(fresh.onboardingFlag === true, 'A5 __DEEP_CHAT_ONBOARDING__ 置为 true（让位给引导层）')
  check(fresh.runtimeKeySet === false, 'A6 没有 Key 时不注入 __RUNTIME_KEY__')
  check(fresh.hasImportBridge === true, 'A7 导入桥已安装')
  check(fresh.hasKeyStore === true, 'A8 Key 存储桥已安装')
  check(
    fresh.bridgeCalls.includes('DeepChatSecureStorage.read'),
    'A9 启动时确实向原生读取了 Key',
    fresh.bridgeCalls
  )

  // ══ 场景 B：已配好 Key → 不应出现引导层 ══
  info('B. 已配好 Key')
  const keyed = await scenario({
    label: 'keyed',
    scripts: [ERROR_TRAP, makeBridge({ apiKey: 'sk-test-0123456789abcdef0123456789abcdef' }), `window.localStorage.clear()`],
  })
  check(keyed.rootChildren > 0, 'B1 页面渲染出内容')
  check(keyed.errors.length === 0, 'B2 无未捕获异常', keyed.errors)
  check(keyed.runtimeKeySet === true, 'B3 Key 被注入 window.__RUNTIME_KEY__')
  check(keyed.hasOnboarding === false, 'B4 有 Key 时不出引导层')
  check(keyed.onboardingFlag === false, 'B5 引导标志被复位为 false')

  // ══ 场景 C：已经引导过 → 即使没 Key 也不再弹 ══
  info('C. 已引导过（用户主动跳过过）')
  const skipped = await scenario({
    label: 'skipped',
    scripts: [
      ERROR_TRAP,
      makeBridge({ apiKey: null }),
      // 模拟上次启动点了「先跳过」
      `window.localStorage.setItem('deep-chat:onboarded', '1')`,
    ],
  })
  check(skipped.rootChildren > 0, 'C1 页面渲染出内容')
  check(skipped.hasOnboarding === false, 'C2 已引导过不再打扰')
  check(skipped.errors.length === 0, 'C3 无未捕获异常', skipped.errors)

  // ══ 场景 D：纯浏览器（无桥）→ PWA 兜底 ══
  info('D. 纯浏览器 / PWA 兜底')
  const browserOnly = await scenario({
    label: 'pwa',
    scripts: [ERROR_TRAP, `window.localStorage.clear()`], // 完全不给 window.Capacitor
  })
  check(browserOnly.rootChildren > 0, 'D1 无原生桥也能正常渲染')
  check(browserOnly.errors.length === 0, 'D2 无未捕获异常（桥缺失不得报错）', browserOnly.errors)
  check(browserOnly.hasOnboarding === false, 'D3 浏览器下不显示壳层引导')
  check(browserOnly.hasImportBridge === false, 'D4 浏览器下不安装导入桥（壳层专属）')
  check(browserOnly.bridgeCalls.length === 0, 'D5 浏览器下没有任何原生调用')

  // ══ 场景 E：安全区变量 ══
  info('E. 安全区样式')
  check(
    keyed.hasFrame === true,
    'E1 找到上游的 .frame 容器（safe-area CSS 的锚点仍在）'
  )
  const insets = [keyed.insetTop, keyed.insetRight, keyed.insetLeft]
  check(
    insets.every((value) => value !== '' && value !== undefined),
    'E2 --shell-inset-* 均被定义了具体值',
    insets
  )
  check(
    insets.every((value) => /^\d+(\.\d+)?px$/.test(value)),
    'E3 值是可用的 px（不是 undefined / env() 原文）',
    insets
  )

  // ══ 场景 F：移动端 UI 结构（官方 App 风格）══
  // 只验「结构在不在、能不能点开」：具体像素靠 pnpm ui:preview 的人工对比，
  // 这里拦住的是「移动端覆盖层没进产物 / fork 没生效 / 按钮点不开」这类硬伤。
  info('F. 移动端 UI 结构')
  const MOBILE_PROBE = `(() => {
    const text = (document.body.innerText || '')
    const byLabel = (label) =>
      [...document.querySelectorAll('button, [role="button"]')].find(
        (node) => node.getAttribute('aria-label') === label
      )
    const rect = (node) => {
      if (!node) return null
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const textarea = document.querySelector('textarea')
    const root = document.getElementById('root')
    return {
      text,
      rootChildren: root ? root.children.length : -1,
      errors: window.__PAGE_ERRORS__ || [],
      hasLogo: Boolean(document.querySelector('svg[role="img"][aria-label="DeepSeek"]')),
      hasMenuButton: Boolean(byLabel('打开边栏')),
      hasNewChatButton: Boolean(byLabel('开启新对话')),
      hasReadButton: Boolean(byLabel('朗读') || byLabel('停止朗读')),
      textareaPlaceholder: textarea ? textarea.getAttribute('placeholder') : null,
      hasThinkingPill: text.includes('深度思考'),
      hasSearchPill: text.includes('智能搜索'),
      hasCaveat: text.includes('内容由 AI 生成'),
      attachButton: rect(byLabel('添加附件')),
      micButton: rect(byLabel('语音输入')),
      probe: window.__MOBILE_PROBE__ || {},
      // 搜索框是 <input>，placeholder 不进 innerText，要单独取
      inputPlaceholders: [...document.querySelectorAll('input')].map((item) => item.getAttribute('placeholder')),
    }
  })()`

  /** 余额接口桩：返回固定余额；可切 401 验证错误与重试，其余请求照常走真实 fetch */
  const BALANCE_STUB = `
  (() => {
    const originalFetch = window.fetch.bind(window)
    window.__BALANCE_CALLS__ = 0
    window.__BALANCE_MODE__ = 'ok'
    const okBody = JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '123.45', granted_balance: '23.45', topped_up_balance: '100.00' },
      ],
    })
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.endsWith('/user/balance')) {
        window.__BALANCE_CALLS__ = (window.__BALANCE_CALLS__ || 0) + 1
        if (window.__BALANCE_MODE__ === '401') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        }
        return Promise.resolve(
          new Response(okBody, { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
      }
      return originalFetch(input, init)
    }
  })()
  `

  const mobile = await scenario({
    label: 'mobile',
    scripts: [ERROR_TRAP, makeBridge({ apiKey: 'sk-test-0123456789abcdef0123456789abcdef' }), BALANCE_STUB, `window.localStorage.clear()`],
    before: async (browser) => {
      await browser.setViewport({ width: 393, height: 852, scale: 2, mobile: true })
      await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
      // 打开附件面板 → 记录结构 → 关闭
      await browser.evaluate(`(async () => {
        window.__MOBILE_PROBE__ = {}
        const tap = (label) => {
          const node = [...document.querySelectorAll('button, [role="button"]')].find(
            (item) => item.getAttribute('aria-label') === label
          )
          if (node) node.click()
          return Boolean(node)
        }
        tap('添加附件')
        await new Promise((r) => setTimeout(r, 600))
        window.__MOBILE_PROBE__.attachPanelText = (document.body.innerText || '')
        // × 关闭面板
        const close = [...document.querySelectorAll('button, [role="button"]')].find(
          (item) => item.getAttribute('aria-label') === '关闭'
        )
        if (close) close.click()
        await new Promise((r) => setTimeout(r, 400))
        tap('语音输入')
        await new Promise((r) => setTimeout(r, 600))
        window.__MOBILE_PROBE__.voiceText = (document.body.innerText || '')
        const keyboard = [...document.querySelectorAll('button, [role="button"]')].find(
          (item) => item.getAttribute('aria-label') === '键盘输入'
        )
        if (keyboard) keyboard.click()
        await new Promise((r) => setTimeout(r, 400))
        tap('打开边栏')
        await new Promise((r) => setTimeout(r, 700))
        window.__MOBILE_PROBE__.drawerText = (document.body.innerText || '')
        window.__MOBILE_PROBE__.drawerHtmlLen = document.body.innerHTML.length
        window.__MOBILE_PROBE__.menuClicked = Boolean(
          [...document.querySelectorAll('button, [role="button"]')].find(
            (item) => item.getAttribute('aria-label') === '打开边栏'
          )
        )

        // 本地账户头像：默认 App 图标；把「用户自选 → 恢复默认」的读写链路各跑一遍
        const avatarImg = document.querySelector('img[data-avatar="local"]')
        window.__MOBILE_PROBE__.avatar = {
          found: Boolean(avatarImg),
          srcPrefix: avatarImg ? avatarImg.src.slice(0, 24) : null,
          srcLength: avatarImg ? avatarImg.src.length : 0,
          srcTail: avatarImg ? avatarImg.src.slice(-24) : null,
        }
        const customAvatar =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        window.localStorage.setItem('deep-chat:local-avatar', customAvatar)
        window.dispatchEvent(new Event('deep-chat:local-avatar-change'))
        await new Promise((r) => setTimeout(r, 200))
        window.__MOBILE_PROBE__.avatarCustomSrc = (document.querySelector('img[data-avatar="local"]') || {}).src || null
        window.localStorage.removeItem('deep-chat:local-avatar')
        window.dispatchEvent(new Event('deep-chat:local-avatar-change'))
        await new Promise((r) => setTimeout(r, 200))
        const resetImg = document.querySelector('img[data-avatar="local"]')
        window.__MOBILE_PROBE__.avatarReset = {
          srcLength: resetImg ? resetImg.src.length : 0,
          srcTail: resetImg ? resetImg.src.slice(-24) : null,
        }

        // 余额：自动拉取 → 401 错误 → 切回正常重试；点余额不应打开设置弹窗
        const readBalance = () => {
          const node = document.querySelector('[data-balance="local"]')
          return node
            ? {
                text: (node.textContent || '').trim(),
                status: node.getAttribute('data-balance-status'),
                calls: window.__BALANCE_CALLS__ || 0,
              }
            : null
        }
        await new Promise((r) => setTimeout(r, 400))
        window.__MOBILE_PROBE__.balanceReady = readBalance()
        window.__BALANCE_MODE__ = '401'
        const balanceNode = document.querySelector('[data-balance="local"]')
        if (balanceNode) balanceNode.click()
        await new Promise((r) => setTimeout(r, 400))
        window.__MOBILE_PROBE__.balanceError = readBalance()
        window.__MOBILE_PROBE__.balanceOpenedSettings = (document.body.innerText || '').includes('通用设置')
        window.__BALANCE_MODE__ = 'ok'
        if (balanceNode) balanceNode.click()
        await new Promise((r) => setTimeout(r, 400))
        window.__MOBILE_PROBE__.balanceRetry = readBalance()
      })()`)
    },
    probe: MOBILE_PROBE,
  })
  const attachText = mobile.probe.attachPanelText || ''
  const voiceText = mobile.probe.voiceText || ''
  const drawerText = mobile.probe.drawerText || ''
  check(mobile.rootChildren > 0, 'F1 移动端渲染出内容（非白屏）')
  check(mobile.errors.length === 0, 'F2 移动端无未捕获异常', mobile.errors)
  check(mobile.hasLogo === true, 'F3 欢迎页有鲸鱼 logo')
  check(mobile.hasMenuButton === true, 'F4 顶栏有汉堡（打开边栏）')
  check(mobile.hasNewChatButton === true, 'F5 顶栏有新建对话（⊕）')
  check(mobile.hasReadButton === true, 'F6 顶栏有朗读按钮')
  check(
    mobile.textareaPlaceholder === '发消息或按住说话',
    'F7 输入框占位符是官方文案',
    mobile.textareaPlaceholder
  )
  check(mobile.hasThinkingPill && mobile.hasSearchPill, 'F8 输入框有深度思考/智能搜索药丸')
  check(mobile.hasCaveat === false, 'F9 移动端不显示「内容由 AI 生成」')
  check(mobile.attachButton !== null, 'F10 输入框有附件按钮（+）')
  check(mobile.micButton !== null, 'F11 输入框有麦克风按钮')
  check(
    attachText.includes('拍照') && attachText.includes('相册') && attachText.includes('文件'),
    'F12 点 + 打开附件面板（拍照 / 相册 / 文件）'
  )
  check(voiceText.includes('按住说话'), 'F13 点麦克风切到「按住说话」')
  check(
    mobile.inputPlaceholders.some((value) => (value || '').startsWith('搜索对话内容')) &&
      drawerText.includes('本地用户'),
    'F14 抽屉有搜索框与底部账户行',
    mobile.inputPlaceholders.join(' | ')
  )

  // 头像：默认必须是内置 App 图标（JPEG data URL，长度远大于 1×1 测试图）；
  // 自选后要立即生效，恢复默认要回到同一张图。
  const avatar = mobile.probe.avatar || {}
  check(
    avatar.found === true &&
      typeof avatar.srcPrefix === 'string' &&
      avatar.srcPrefix.startsWith('data:image/jpeg;base64,') &&
      avatar.srcLength > 2000,
    'F16 账户行默认头像用内置 App 图标',
    avatar
  )
  check(
    typeof mobile.probe.avatarCustomSrc === 'string' &&
      mobile.probe.avatarCustomSrc.startsWith('data:image/png;base64,') &&
      mobile.probe.avatarCustomSrc.length < 500,
    'F17 用户自选头像可写入并立即生效'
  )
  const avatarReset = mobile.probe.avatarReset || {}
  check(
    avatarReset.srcLength === avatar.srcLength && avatarReset.srcTail === avatar.srcTail,
    'F18 清掉自选头像后恢复默认 App 图标',
    avatarReset
  )

  // 余额：默认拉取显示金额；失败（401）显示原因且不误开设置；切回正常后点余额能重试恢复
  const balanceReady = mobile.probe.balanceReady || {}
  check(
    balanceReady.status === 'ready' && /123\.45/.test(balanceReady.text || ''),
    'F19 抽屉账户行显示 API 余额',
    balanceReady
  )
  const balanceError = mobile.probe.balanceError || {}
  check(
    balanceError.status === 'error' &&
      (balanceError.text || '').includes('Key 无效') &&
      mobile.probe.balanceOpenedSettings === false,
    'F20 余额失败显示原因且不误开设置',
    balanceError
  )
  const balanceRetry = mobile.probe.balanceRetry || {}
  check(
    balanceRetry.status === 'ready' &&
      /123\.45/.test(balanceRetry.text || '') &&
      (balanceRetry.calls || 0) > (balanceReady.calls || 0),
    'F21 点余额可重试并恢复显示',
    balanceRetry
  )

  // ══ 场景 G：朗读按钮的播放/停止开关态（F15）══
  // 朗读按钮只有在「当前会话最后一条回答有正文」时才可点，而上面的移动端场景停在欢迎页
  // （没有会话、按钮 disabled），所以这里单开一个隔离场景：
  //   1. 直接往 IndexedDB 塞一条带助手正文的会话（库名/版本/存储与
  //      web/src/services/chat/db.ts 一致），不为造数据改产品代码、也不模拟流式接口；
  //   2. reload 一次让 initChat 读到该会话，再从抽屉点进会话页；
  //   3. 把 POST /v1/tools/tts 挂起（永不 resolve），朗读状态停在 loading，
  //      蓝喇叭状态可稳定断言（无头浏览器里本来也听不到声音，等真实音频首帧只会超时）。
  // 断言口径：朗读中 aria-pressed / data-reading 为 true、aria-label 变「停止朗读」、
  // 计算出的颜色是 --m-brand(#4d6bfe)；再点同一个按钮回到 false /「朗读」/ 非品牌蓝。
  info('G. 朗读按钮播放/停止态')

  /** 只把 TTS 请求挂起，其余请求（/models、/anthropic/...）照常走真实 fetch */
  const TTS_HANG = `
  (() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/v1/tools/tts')) {
        window.__TTS_STUBBED__ = (window.__TTS_STUBBED__ || 0) + 1
        // 永不 settle：朗读停在 loading（等价于真实环境里等待音频首帧的网络延迟）
        return new Promise(() => {})
      }
      return originalFetch(input, init)
    }
  })()
  `

  /**
   * 无头浏览器没有音频输出设备（启动参数还带 --mute-audio），点朗读会构造 AudioContext。
   * 这里换成最小替身，只保留朗读流程会碰到的字段/方法：断言的是「开关态 + 颜色」，
   * 不是真的出声；真机音频仍按 docs/build.md §9.1 的人工清单验收。
   */
  const AUDIO_STUB = `
  (() => {
    class StubAudioContext {
      constructor() {
        this.currentTime = 0
        this.destination = {}
        this.state = 'running'
      }
      createBuffer() {
        return { duration: 0, copyToChannel() {} }
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, onended: null }
      }
      close() {
        return Promise.resolve()
      }
    }
    window.AudioContext = StubAudioContext
  })()
  `

  /**
   * 往 IndexedDB 塞一条会话：用户提问 + 助手正文回答。
   * 字段形状对齐 services/chat/types.ts；不写 rootMessageId，
   * 让 App 的 normalizeSession 按线性列表补齐分支字段。
   */
  const READING_SEED = `
  (async () => {
    const now = Date.now()
    const session = {
      id: 'accept-reading-session',
      title: '朗读验收',
      createdAt: now - 60000,
      updatedAt: now,
      messages: [
        {
          id: 'accept-reading-question',
          role: 'user',
          content: '你好',
          files: [],
          createdAt: now - 60000,
        },
        {
          id: 'accept-reading-reply',
          role: 'assistant',
          createdAt: now - 59000,
          model: 'deepseek-flash',
          thinking: false,
          search: false,
          prefix: true,
          status: 'done',
          blocks: [{ type: 'text', text: '这是一条用于验收朗读按钮开关态的回答。' }],
        },
      ],
    }
    const summary = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      fileIds: [],
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo', 11)
      request.onupgradeneeded = () => {
        const database = request.result
        for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
          if (!database.objectStoreNames.contains(name)) {
            database.createObjectStore(name, { keyPath: 'id' })
          }
        }
        const summaries = database.objectStoreNames.contains('sessionSummaries')
          ? request.transaction.objectStore('sessionSummaries')
          : database.createObjectStore('sessionSummaries', { keyPath: 'id' })
        if (!summaries.indexNames.contains('fileIds')) {
          summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      transaction.objectStore('sessions').put(session)
      transaction.objectStore('sessionSummaries').put(summary)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
    window.__READING_SEEDED__ = true
    return true
  })().catch((error) => {
    window.__READING_SEED_ERROR__ = String((error && error.message) || error)
    return false
  })
  `

  const READALOUD_PROBE = `(() => ({
    errors: window.__PAGE_ERRORS__ || [],
    probe: window.__READALOUD_PROBE__ || {},
  }))()`

  const readAloud = await scenario({
    label: 'mobile-readaloud',
    scripts: [
      ERROR_TRAP,
      makeBridge({ apiKey: 'sk-test-0123456789abcdef0123456789abcdef' }),
      TTS_HANG,
      AUDIO_STUB,
      `window.localStorage.clear()`,
    ],
    before: async (browser) => {
      await browser.setViewport({ width: 393, height: 852, scale: 2, mobile: true })
      await browser.evaluate(`new Promise((resolve) => setTimeout(resolve, 700))`)

      // 1) 写入带助手正文的会话；写成功前 reload 会让 initChat 读不到它
      const seeded = await browser.evaluate(READING_SEED)

      // 2) reload，让 initChat 重新读会话列表（首次加载时列表是空的）
      await reloadPage(browser)
      // 会话列表是异步从 IndexedDB 恢复的：等抽屉里出现种子会话那一行再操作
      const rowReady = await browser
        .waitFor(
          `[...document.querySelectorAll('[role="button"]')].some((node) => (node.textContent || '').trim() === '朗读验收')`,
          { timeoutMs: 5000, label: '抽屉里有种子会话' }
        )
        .then(() => true)
        .catch(() => false)

      // 3) 打开抽屉 → 点种子会话 → 进入会话页（欢迎页的朗读按钮是 disabled 的）
      const opened = await browser.evaluate(`(async () => {
        const tap = (label) => {
          const node = [...document.querySelectorAll('button, [role="button"]')].find(
            (item) => item.getAttribute('aria-label') === label
          )
          if (node) node.click()
          return Boolean(node)
        }
        tap('打开边栏')
        await new Promise((resolve) => setTimeout(resolve, 700))
        const row = [...document.querySelectorAll('[role="button"]')].find(
          (node) => (node.textContent || '').trim() === '朗读验收'
        )
        if (row) row.click()
        return Boolean(row)
      })()`)
      // 会话页顶栏的朗读按钮才是可用的（欢迎页那个 disabled）
      const readButtonReady = await browser
        .waitFor(
          `[...document.querySelectorAll('button')].some((node) => node.getAttribute('aria-label') === '朗读' && !node.disabled)`,
          { timeoutMs: 5000, label: '会话页朗读按钮可用' }
        )
        .then(() => true)
        .catch(() => false)

      // 4) 点朗读按钮（用户真实点的是同一个喇叭按钮，不换图标）
      //    这里用 JS click 而不是坐标触摸：按钮在会话页要等主界面从抽屉左移的 300ms
      //    过渡结束才回到固定位置，坐标点击会打在过渡中的位置；而本项断言的是
      //    class/颜色/aria 状态，不依赖 :active / :hover 这类只有真实指针才有的样式。
      const clickReadButton = () =>
        browser.evaluate(`(() => {
          const node = [...document.querySelectorAll('button')].find(
            (item) => item.hasAttribute('data-reading')
          )
          if (!node || node.disabled) return false
          node.click()
          return true
        })()`)
      const readState = () =>
        browser.evaluate(`(() => {
          const node = [...document.querySelectorAll('button')].find(
            (item) => item.hasAttribute('data-reading')
          )
          if (!node) return null
          return {
            pressed: node.getAttribute('aria-pressed'),
            reading: node.getAttribute('data-reading'),
            label: node.getAttribute('aria-label'),
            // 比 class 名更贴近「用户看到的蓝」：不受 CSS Modules 哈希影响
            color: getComputedStyle(node).color,
          }
        })()`)

      await clickReadButton()
      // 最多 2s 轮询到朗读态（loading 被 stub 挂住，不会自己回到 idle）
      let active = null
      const activeDeadline = Date.now() + 2000
      while (Date.now() < activeDeadline) {
        const state = await readState()
        if (state && state.reading === 'true') {
          active = state
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      // 5) 再点一次 = 停止，回到 idle（深色喇叭）
      let idle = null
      if (active) {
        await clickReadButton()
        const idleDeadline = Date.now() + 2000
        while (Date.now() < idleDeadline) {
          const state = await readState()
          if (state && state.reading === 'false') {
            idle = state
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      const ttsStubbed = await browser.evaluate(`window.__TTS_STUBBED__ || 0`).catch(() => 0)
      await browser.evaluate(
        `window.__READALOUD_PROBE__ = ${JSON.stringify({
          seeded: seeded === true,
          rowReady,
          opened,
          readButtonReady,
          active,
          idle,
          ttsStubbed,
        })}`
      )
    },
    probe: READALOUD_PROBE,
  })
  const readAloudProbe = readAloud.probe || {}
  const activeState = readAloudProbe.active || null
  const idleState = readAloudProbe.idle || null
  const isBrandBlue = (color) => /^rgb\(\s*77,\s*107,\s*254\s*\)$/.test(String(color || ''))
  check(
    readAloudProbe.seeded === true &&
      readAloudProbe.opened === true &&
      readAloudProbe.readButtonReady === true &&
      activeState !== null &&
      activeState.reading === 'true' &&
      activeState.pressed === 'true' &&
      activeState.label === '停止朗读' &&
      isBrandBlue(activeState.color) &&
      readAloudProbe.ttsStubbed >= 1 &&
      idleState !== null &&
      idleState.reading === 'false' &&
      idleState.pressed === 'false' &&
      idleState.label === '朗读' &&
      !isBrandBlue(idleState.color),
    'F15 朗读中喇叭变蓝、再点停止回到空闲',
    {
      seeded: readAloudProbe.seeded,
      rowReady: readAloudProbe.rowReady,
      opened: readAloudProbe.opened,
      readButtonReady: readAloudProbe.readButtonReady,
      ttsStubbed: readAloudProbe.ttsStubbed,
      active: activeState,
      idle: idleState,
    }
  )

  // ══ 汇总 ══
  step('结果')
  const failed = results.filter((item) => !item.ok)
  info(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)

  if (!KEEP) {
    try {
      rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Chrome 的 profile 句柄可能还没释放；清理失败不影响结论
    }
  } else {
    info(`现场保留在 ${WORK}`)
  }

  if (failed.length > 0) {
    fail(`${failed.length} 项验收失败`, failed.map((item) => item.label).join(' | '))
  }
  info('全部通过。')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
