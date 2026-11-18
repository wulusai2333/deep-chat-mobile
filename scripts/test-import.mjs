/**
 * 合并导入的端到端测试 —— scripts/test-import.mjs
 *
 * 【为什么值得单独写一套测试】
 * 合并导入是整个项目风险最高的一段代码：它踩在「清空 → 重建」的原子事务上，
 * 又依赖 IDB 的 add/put 语义差异、以及 updateStagingFileTypes「映射里没有就清空」
 * 这个反直觉行为。任何一处写错都会**静默丢用户数据** —— 这类错误读代码看不出来。
 *
 * 【怎么跑】
 * 把 scripts/import-test.entry.ts 用上游的 rspack 打成一个 IIFE bundle，
 * 注入无头 Chrome 打开的空页面。这样测试跑在**真实的 IndexedDB / Blob / File /
 * TextEncoder / atob** 上，而不是 Node 里的模拟实现 —— 模拟实现正是掩盖 bug 的地方。
 *
 * 用法：
 *   pnpm test:import            # 跑测试
 *   pnpm test:import --keep     # 保留 .tmp/ 便于排查
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step, warn } from './lib/env.mjs'
import { openBrowser, startStaticServer } from './lib/cdp.mjs'

const KEEP = process.argv.includes('--keep')

/** 用上游的 rspack 把测试入口打成 IIFE（配置见 import-test.rspack.config.mjs） */
const buildBundle = async () => {
  // 每一轮都换一个新的临时目录：Chrome 的 profile 里有些文件在进程退出后
  // 仍被系统短暂占用，删不掉会抛 EBUSY。与其跟它较劲，不如不复用目录。
  const stamp = `${Date.now()}-${process.pid}`
  const workDir = join(paths.root, '.tmp', `import-test-${stamp}`)
  mkdirSync(workDir, { recursive: true })

  const rspackCli = join(paths.web, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')
  const configPath = join(paths.scripts, 'import-test.rspack.config.mjs')
  await run(process.execPath, [rspackCli, 'build', '-c', configPath], {
    cwd: paths.root,
    // 配置里读这个变量决定输出目录
    env: { CHATDEMO_TEST_DIR: workDir },
  })

  const bundlePath = join(workDir, 'bundle.js')
  if (!existsSync(bundlePath)) {
    fail('bundle 生成失败', `期望 ${bundlePath}`)
  }
  return { bundlePath, workDir }
}

/** 生成一个只做一件事的 HTML：加载 bundle，把 console 输出写到 DOM */
const writeHtml = (workDir) => {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>import test</title></head>
<body>
<pre id="out"></pre>
<script>
  // 上游源码里的编译期常量。正常构建由 rspack 的 DefinePlugin 注入，
  // 这里用全局变量顶替（测试不关心 API 地址，只要能加载即可）。
  var __API_ORIGIN__ = 'https://api.deepseek.com'

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

/**
 * 跑测试：驱动无头浏览器，等 window.__TEST_RESULT__ 出现后取结果。
 *
 * 【为什么用 CDP 而不是 --dump-dom】
 * `chrome --headless --dump-dom --virtual-time-budget=N` 会在页面 load 之后
 * （或虚拟时间预算耗尽时）立刻快照 DOM。但本测试的结果来自 IndexedDB 的异步回调 ——
 * 虚拟时间不会等它们，于是每次都拿到空的 <pre>，表现为「测试没有产生任何输出」。
 * 这种假失败会把排查方向完全带偏（让人去怀疑 bundle 没加载、loader 写错、
 * IndexedDB 被禁用……实际上只是快照太早）。
 *
 * 浏览器的启动与销毁、进程清理都交给 lib/cdp.mjs —— 那里按 profile 路径
 * 杀掉整组进程，否则 Chrome 残留会一直持有临时目录的文件锁。
 */
const runHeadless = async (baseUrl, workDir) => {
  const browser = await openBrowser({ workDir })
  try {
    await browser.navigate(`${baseUrl}/index.html`)

    // 轮询等结果（测试要跑十几秒：多个 ZIP 的 deflate/inflate）
    const deadline = Date.now() + 120000
    let payload = null
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400))
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

    // 把日志也取出来（用于失败时定位）
    const logs = (await browser.evaluate('window.__LOGS__ || []')) ?? []
    if (!payload) {
      return { payload: null, logs, reason: '等待 120 秒仍未出现 __TEST_RESULT__' }
    }
    return { payload, logs, reason: null }
  } finally {
    await browser.close()
  }
}

const main = async () => {
  step('合并导入端到端测试')

  info('打包测试入口…')
  const { workDir } = await buildBundle()
  writeHtml(workDir)

  // 必须走 http:// 而不是 file://：Chrome 在 file:// 下禁用 IndexedDB，
  // 而本测试全程依赖它。（file:// 会得到 SecurityError，看起来像测试逻辑出错。）
  const server = await startStaticServer(workDir)
  info(`本地服务 ${server.url}/`)

  let outcome
  try {
    info('在无头浏览器中运行…')
    outcome = await runHeadless(server.url, workDir)
  } finally {
    await server.close()
  }

  const result = outcome.payload
  const logs = outcome.logs ?? []

  if (logs.length === 0) {
    fail('测试没有产生任何输出', outcome.reason ?? '浏览器可能没能加载 bundle')
  }

  // 打印每条断言结果
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
    } else {
      process.stdout.write(`    ${trimmed}\n`)
    }
  }

  const summary = logs.find((line) => String(line).includes('SUMMARY'))
  const failedList = logs.find((line) => String(line).includes('FAILED:'))

  step('结果')
  if (!result) {
    fail(outcome.reason ?? '测试未完成', logs.slice(-5).join('\n'))
  }
  info(String(summary ?? `${result.total - result.failed}/${result.total} passed`).replace(/^\[test\]\s*/, ''))

  if (!KEEP) {
    // 清理只是顺手的事，绝不能让它决定测试成败：
    // Chrome 退出后 profile 里的 LevelDB 文件仍被系统短暂持有，
    // rmSync 会抛 EBUSY —— 那是清理问题，不是测试问题。
    const sweep = (dir) => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // 留给下一次运行或用户手工清理
      }
    }
    sweep(workDir)
    for (const entry of readdirSync(join(paths.root, '.tmp'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('import-test')) {
        sweep(join(paths.root, '.tmp', entry.name))
      }
    }
  } else {
    info(`现场保留在 ${workDir}`)
  }

  if (result.failed > 0) {
    fail(`${result.failed} 项断言失败`, String(failedList ?? '').replace(/^\[test\]\s*/, ''))
  }
  info('全部通过。')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
