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

const KEEP = process.argv.includes('--keep')

/** cmd.exe 会把含空格的路径截断，必须加引号 */
const quotePath = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** 轮询一个返回 JSON 的端点，直到成功或超时 */
const pollJson = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return await response.json()
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message}`)
}

/** 找一个可用的 Chromium 内核浏览器 */
const findBrowser = () => {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((path) => existsSync(path))
}

/** 用上游的 rspack 把测试入口打成 IIFE（配置见 import-test.rspack.config.mjs） */
const buildBundle = async () => {
  // 每一轮都换一个新的临时目录：Chrome 的 profile 里有些文件在进程退出后
  // 仍被系统短暂占用（CrashpadMetrics-active.pma 之类），删不掉会直接抛 EBUSY。
  // 与其跟它较劲，不如不复用目录。
  const stamp = `${Date.now()}-${process.pid}`
  const workDir = join(paths.root, '.tmp', `import-test-${stamp}`)
  mkdirSync(workDir, { recursive: true })
  process.env.CHATDEMO_TEST_DIR = workDir

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
 * 跑测试：通过 CDP 驱动无头浏览器，等 window.__TEST_RESULT__ 出现后取结果。
 *
 * 【为什么不用 --dump-dom + --virtual-time-budget】
 * 那个组合会在页面 load 之后（或虚拟时间预算耗尽时）立刻快照 DOM。
 * 但本测试的结果来自 IndexedDB 的异步回调 —— 虚拟时间不会等它们，
 * 于是每次都拿到空的 <pre>，表现为「测试没有产生任何输出」，
 * 而实际测试可能正在正常跑（只是还没跑完）。属实是最难排查的那类假失败。
 *
 * CDP 的 Runtime.evaluate + awaitPromise 能真正等到测试自己 resolve。
 * Node 22 自带 WebSocket，所以不需要 ws 之类的依赖。
 */
const runHeadless = async (browser, port, workDir) => {
  const { createServer } = await import('node:http')
  const { spawn } = await import('node:child_process')

  // 1. 找一个空闲端口给 CDP
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const cdpPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  // 2. 启动浏览器
  const child = spawn(
    quotePath(browser),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      // 用一个临时 profile，避免与用户正在用的 Chrome 抢锁
      `--user-data-dir=${join(workDir, 'profile')}`,
      'about:blank',
    ],
    { stdio: 'ignore', shell: process.platform === 'win32' }
  )

  try {
    // 3. 等 CDP 就绪
    const targets = await pollJson(`http://127.0.0.1:${cdpPort}/json/list`, 15000)
    const page = targets.find((item) => item.type === 'page')
    if (!page) {
      throw new Error('找不到可用的浏览器页目标')
    }

    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    })

    let nextId = 1
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)))
        } else {
          resolve(message.result)
        }
      }
    }
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? '页面内异常')
      }
      return result.result.value
    }

    // 4. 打开测试页
    await send('Page.enable')
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` })

    // 5. 轮询等结果（测试可能要跑十几秒：多个 ZIP 的 deflate/inflate）
    const deadline = Date.now() + 120000
    let payload = null
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const state = await evaluate(
        `(() => {
           if (window.__TEST_RESULT__) { return { done: true, value: window.__TEST_RESULT__ } }
           const logs = window.__LOGS__ || []
           return { done: false, value: logs.slice(-1)[0] ?? null }
         })()`
      )
      if (state?.done) {
        payload = state.value
        break
      }
    }

    // 6. 把日志也取出来（用于失败时定位）
    const logs = (await evaluate('window.__LOGS__ || []')) ?? []
    socket.close()

    if (!payload) {
      return { payload: null, logs, reason: '等待 120 秒仍未出现 __TEST_RESULT__' }
    }
    return { payload, logs, reason: null }
  } finally {
    child.kill()
  }
}

/** 极简静态服务器，只服务一轮测试的临时目录（file:// 下 Chrome 禁用 IndexedDB） */
const startServer = async (workDir) => {
  const { createServer } = await import('node:http')
  const { readFileSync, existsSync } = await import('node:fs')
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
    const file = join(workDir, name)
    // 防目录穿越
    if (!file.startsWith(workDir) || !existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const type = file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    res.end(readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

const main = async () => {
  step('合并导入端到端测试')

  const browser = findBrowser()
  if (!browser) {
    warn('没找到 Chrome / Edge，跳过（这个测试需要 Chromium 内核）')
    return
  }
  info(`浏览器：${browser}`)

  info('打包测试入口…')
  const { workDir } = await buildBundle()
  writeHtml(workDir)

  const { server, port } = await startServer(workDir)
  info(`本地服务 http://127.0.0.1:${port}/`)

  let outcome
  try {
    info('在无头浏览器中运行…')
    outcome = await runHeadless(browser, port, workDir)
  } finally {
    server.close()
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
