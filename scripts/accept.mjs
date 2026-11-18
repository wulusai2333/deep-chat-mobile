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
 *   2. 桥返回空 Key 时，引导层出现且 `__CHAT_DEMO_ONBOARDING__` 为 true
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
      if (plugin === 'ChatDemoSecureStorage' && method === 'read') {
        return Promise.resolve({ value: apiKey })
      }
      if (plugin === 'ChatDemoSecureStorage' && (method === 'write' || method === 'remove')) {
        return Promise.resolve({})
      }
      // 麦克风：默认未授权但可申请
      if (plugin === 'ChatDemoMic' && method === 'check') {
        return Promise.resolve({ state: 'prompt', canRequest: true, blocked: false, oneTimeSupported: true })
      }
      // 文件：无待处理文件
      if (plugin === 'ChatDemoFiles' && method === 'hasPendingFile') {
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
    onboardingFlag: window.__CHAT_DEMO_ONBOARDING__,
    hasImportBridge: Boolean(window.__CHAT_DEMO_IMPORT__),
    hasKeyStore: Boolean(window.__CHAT_DEMO_KEYSTORE__),
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
    browser?.close()
    await server.close()
  }
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
  check(
    typeof fresh.onboardingTitle === 'string' && fresh.onboardingTitle.includes('开始使用'),
    'A4 引导层是「开始使用」首屏',
    fresh.onboardingTitle
  )
  check(fresh.onboardingFlag === true, 'A5 __CHAT_DEMO_ONBOARDING__ 置为 true（让位给引导层）')
  check(fresh.runtimeKeySet === false, 'A6 没有 Key 时不注入 __RUNTIME_KEY__')
  check(fresh.hasImportBridge === true, 'A7 导入桥已安装')
  check(fresh.hasKeyStore === true, 'A8 Key 存储桥已安装')
  check(
    fresh.bridgeCalls.includes('ChatDemoSecureStorage.read'),
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
      `window.localStorage.setItem('chat-demo:onboarded', '1')`,
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
