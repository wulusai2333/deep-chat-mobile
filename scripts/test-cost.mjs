/**
 * 峰谷计价的单元测试 —— scripts/test-cost.mjs
 *
 * 【怎么跑】
 * 用上游 rspack 把 scripts/cost-test.entry.ts 打成 IIFE，注入无头 Chrome 的空页面，
 * 跑完从 window.__TEST_RESULT__ 取汇总。被测算的 pricing.ts 是纯函数，
 * 所以这里不依赖 IndexedDB / Blob，启动比 test-import 快得多。
 *
 * 【为什么不在 Node 里直接断言】
 * WebView 里实际执行的是同一份 TS 打包产物；浏览器路径同时验证了「能被打包」，
 * 这是 Node 直接 import 测不到的。但无浏览器环境（CI / 精简机器）不该让测试直接失败：
 * 此时退化为在 Node 里执行**同一份 bundle**，并明确打印退化原因。
 *
 * 用法：
 *   pnpm test:cost          # 跑测试
 *   pnpm test:cost --keep   # 保留 .tmp/ 便于排查
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step, warn } from './lib/env.mjs'
import { findBrowser, openBrowser, startStaticServer } from './lib/cdp.mjs'

const KEEP = process.argv.includes('--keep')

/** 用上游的 rspack 把测试入口打成 IIFE（配置见 cost-test.rspack.config.mjs） */
const buildBundle = async () => {
  // 每轮唯一目录：上一轮 Chrome 的 profile 可能仍被系统短暂占用，删不掉会抛 EBUSY。
  const stamp = `${Date.now()}-${process.pid}`
  const workDir = join(paths.root, '.tmp', `cost-test-${stamp}`)
  mkdirSync(workDir, { recursive: true })

  const rspackCli = join(paths.web, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')
  if (!existsSync(rspackCli)) {
    fail('找不到上游 rspack', `期望 ${rspackCli}\n先在 web/ 下安装依赖（pnpm web:install）。`)
  }
  const configPath = join(paths.scripts, 'cost-test.rspack.config.mjs')
  await run(process.execPath, [rspackCli, 'build', '-c', configPath], {
    cwd: paths.root,
    // 配置里读这个变量决定输出目录
    env: { DEEPCHAT_TEST_DIR: workDir },
  })

  const bundlePath = join(workDir, 'bundle.js')
  if (!existsSync(bundlePath)) {
    fail('bundle 生成失败', `期望 ${bundlePath}`)
  }
  return { bundlePath, workDir }
}

/** 生成一个只做一件事的 HTML：加载 bundle，把 console 输出写进 __LOGS__ */
const writeHtml = (workDir) => {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>cost test</title></head>
<body>
<pre id="out"></pre>
<script>
  window.__LOGS__ = []
  const out = document.getElementById('out')
  const orig = console.log
  console.log = function (...args) {
    const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    window.__LOGS__.push(line)
    out.textContent += line + '\\n'
    orig.apply(console, args)
  }
  window.addEventListener('error', (e) => { window.__LOGS__.push('UNCAUGHT ' + e.message) })
  window.addEventListener('unhandledrejection', (e) => { window.__LOGS__.push('UNHANDLED ' + e.reason) })
</script>
<script src="bundle.js"></script>
</body></html>`
  writeFileSync(join(workDir, 'index.html'), html)
}

/** 驱动无头浏览器，等 window.__TEST_RESULT__ 出现后取结果 */
const runHeadless = async (baseUrl, workDir) => {
  const browser = await openBrowser({ workDir })
  try {
    await browser.navigate(`${baseUrl}/index.html`)

    const deadline = Date.now() + 60000
    let payload = null
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const state = await browser.evaluate(
        `(() => {
           if (window.__TEST_RESULT__) { return { done: true, value: window.__TEST_RESULT__ } }
           return { done: false }
         })()`
      )
      if (state?.done) {
        payload = state.value
        break
      }
    }

    const logs = (await browser.evaluate('window.__LOGS__ || []')) ?? []
    if (!payload) {
      return { payload: null, logs, reason: '等待 60 秒仍未出现 __TEST_RESULT__' }
    }
    return { payload, logs, reason: null }
  } finally {
    await browser.close()
  }
}

/**
 * 无浏览器时的退化路径：直接在 Node 里执行同一份 IIFE bundle。
 *
 * bundle 是 target:'web' 的产物，可能引用 self / window；这里把它们都指向 globalThis
 * （测试入口本身没有任何 DOM 调用）。不需要临时 runner 文件，也不新增依赖。
 */
const runInNode = (bundlePath) => {
  const source = readFileSync(bundlePath, 'utf8')
  const logs = []
  const original = console.log
  console.log = (...args) => {
    // 不转发到终端：下面统一按 PASS/FAIL 着色输出，避免每行打两遍。
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  try {
    const factory = new Function('self', 'window', source)
    factory(globalThis, globalThis)
  } finally {
    console.log = original
  }
  const payload = globalThis.__TEST_RESULT__ ?? null
  return {
    payload,
    logs,
    reason: payload ? null : 'Node 内执行 bundle 后仍未产生 __TEST_RESULT__',
  }
}

const printLogs = (logs) => {
  for (const line of logs) {
    const trimmed = String(line).replace(/^\[test\]\s*/, '')
    if (trimmed.startsWith('PASS')) {
      process.stdout.write(`  \u001b[32m✓\u001b[0m ${trimmed.slice(5)}\n`)
    } else if (trimmed.startsWith('FAIL')) {
      process.stdout.write(`  \u001b[31m✗\u001b[0m ${trimmed.slice(5)}\n`)
    } else if (
      trimmed.startsWith('ERROR') ||
      trimmed.startsWith('UNCAUGHT') ||
      trimmed.startsWith('UNHANDLED')
    ) {
      process.stdout.write(`  \u001b[31m! ${trimmed}\u001b[0m\n`)
    } else if (trimmed.startsWith('SUMMARY') || trimmed.startsWith('FAILED:')) {
      // 最后统一处理
    } else if (trimmed.length > 0) {
      process.stdout.write(`    ${trimmed}\n`)
    }
  }
}

const main = async () => {
  step('峰谷计价单元测试')

  info('打包测试入口…')
  const { bundlePath, workDir } = await buildBundle()
  writeHtml(workDir)

  let outcome
  if (!findBrowser()) {
    // 退化不是「静默通过」：明确写出原因，并说明跑的是同一份 bundle。
    warn('本机未找到 Chrome / Edge，退化为「Node 执行同一份 bundle」；断言集合完全相同。')
    outcome = runInNode(bundlePath)
  } else {
    // 走 http:// 而不是 file://：与真实 WebView 的 localStorage / 安全上下文一致。
    const server = await startStaticServer(workDir)
    info(`本地服务 ${server.url}/`)
    try {
      info('在无头浏览器中运行…')
      outcome = await runHeadless(server.url, workDir)
    } finally {
      await server.close()
    }
  }

  const { payload, logs } = outcome
  if (logs.length === 0) {
    fail('测试没有产生任何输出', outcome.reason ?? '浏览器可能没能加载 bundle')
  }
  printLogs(logs)

  const summary = logs.find((line) => String(line).includes('SUMMARY'))
  const failedList = logs.find((line) => String(line).includes('FAILED:'))

  step('结果')
  if (!payload) {
    fail(outcome.reason ?? '测试未完成', logs.slice(-5).join('\n'))
  }
  info(String(summary ?? `${payload.total - payload.failed}/${payload.total} passed`).replace(/^\[test\]\s*/, ''))

  if (!KEEP) {
    // 清理不影响测试结论：Chrome 退出后 profile 里的 LevelDB 仍可能被系统短暂持有。
    const sweep = (dir) => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // 留给下一次运行或用户手工清理
      }
    }
    sweep(workDir)
    for (const entry of readdirSync(join(paths.root, '.tmp'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('cost-test')) {
        sweep(join(paths.root, '.tmp', entry.name))
      }
    }
  } else {
    info(`现场保留在 ${workDir}`)
  }

  if (payload.failed > 0) {
    fail(`${payload.failed} 项断言失败`, String(failedList ?? '').replace(/^\[test\]\s*/, ''))
  }
  info('全部通过。')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
