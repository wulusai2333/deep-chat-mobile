/**
 * 无头浏览器驱动 —— scripts/lib/cdp.mjs
 *
 * 用 Chrome DevTools Protocol 直接控制一个无头 Chromium：启动、开新文档前注入脚本、
 * 导航、在页面里求值、等条件成立。只实现这个项目真正用到的几个方法。
 *
 * 【为什么不用 --dump-dom】
 * `chrome --headless --dump-dom --virtual-time-budget=N` 看起来最省事，但它会在页面
 * load 事件之后（或虚拟时间预算耗尽时）立刻快照 DOM。本项目的测试都依赖
 * IndexedDB 异步回调和 Promise 链 —— 虚拟时间不推进这些宏任务之外的真实异步，
 * 于是 DOM 里永远是空的，表现为「测试没有产生任何输出」。
 * 这种假失败会把排查方向完全带偏（会让人去怀疑 bundle 没加载、loader 写错、
 * IndexedDB 被禁用……实际上只是快照太早）。
 *
 * 【为什么不用 puppeteer / playwright】
 * 项目要求不给上游引入任何新依赖；Node 22 自带 WebSocket，CDP 手写 60 行就够。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 找本机可用的 Chromium 内核浏览器 */
export const findBrowser = () => {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ]
  return candidates.find((path) => existsSync(path))
}

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
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message}`)
}

/**
 * 启动无头浏览器并连上 CDP。
 * @param {object} options
 * @param {string} options.workDir  临时目录（放 profile，必须每轮唯一，否则 Chrome 抢锁）
 * @param {string} [options.initScript] 在每个新文档的脚本执行前注入
 */
export const openBrowser = async ({ workDir, initScript }) => {
  const browser = findBrowser()
  if (!browser) {
    throw Object.assign(new Error('没找到 Chrome / Edge'), { code: 'NO_BROWSER' })
  }

  // 1. 探一个空闲端口给 CDP 用
  const { createServer } = await import('node:http')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const cdpPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  // 2. 启动浏览器
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${join(workDir, 'profile')}`,
      'about:blank',
    ],
    // detached 让浏览器自成一个进程组，非 Windows 平台可整组杀（见 cleanup）
    { stdio: 'ignore', detached: process.platform !== 'win32' }
  )

  /**
   * 关掉浏览器。
   *
   * 【为什么杀了 PID 还是留一堆进程】
   * Chrome 启动时会「自我交接」：我们 spawn 到的那个进程可能很快退出，
   * 真正干活的浏览器进程换了 PID（实测父进程变成已回收的僵尸），
   * 于是 `taskkill /T /F <我们拿到的 pid>` 什么也杀不到，
   * 而 renderer / gpu / crashpad 继续持有 profile 目录的 LevelDB 锁。
   *
   * 【所以按「唯一路径」而不是 PID 来杀】
   * 每一轮测试都用独一无二的 `--user-data-dir=<workDir>/profile`，
   * 在命令行里搜这个路径就能精确锁定本次运行派生的全部进程，
   * 不会误伤用户自己正在用的 Chrome。
   */
  const cleanup = () => {
    const profileDir = join(workDir, 'profile')
    try {
      if (process.platform === 'win32') {
        // 先按 PID 树（正常情况下够用）
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        // 再按唯一路径兜底（应对自我交接后的新 PID）。
        // 命令必须写成**单行**：spawnSync 传多行字符串给 powershell -Command 时，
        // 换行会被当成命令分隔符，管道后半段失配，结果一条也杀不掉。
        const escaped = profileDir.replace(/'/g, "''")
        // 【为什么不用 Get-CimInstance】
        // 按命令行筛进程本来要靠 `Get-CimInstance Win32_Process`，但它走 WMI。
        // 实测这台机器上 WMI 会整体卡死（同一条命令挂 120 秒不返回），
        // 于是每轮测试都卡在收尾阶段 —— 表现为「跑完场景 A 就不动了」。
        //
        // 换成两条都不依赖 WMI 的路子：
        //   1) `Get-Process chrome` 拿名字匹配的进程（Win32 原生，快）；
        //   2) 用 PID 树 + 端口归属兜底。
        // 精确到「本次运行」靠的是 profile 目录唯一 + 端口唯一，
        // 而这两者在下面的 taskkill 分支里已经处理；这里只做宽范围兜底：
        // 杀掉「启动时间晚于本轮开始」的 chrome。用户自己开的 Chrome 都在此之前。
        const script =
          `Get-Process -Name chrome,msedge -ErrorAction SilentlyContinue ` +
          `| Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-10) } ` +
          `| Stop-Process -Force -ErrorAction SilentlyContinue`
        spawnSync('powershell', ['-NoProfile', '-Command', script], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 15000,
        })
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      // 已经退出，或 PID 已被回收
    }
  }

  try {
    // 3. 等 CDP 就绪，拿到页面目标
    const targets = await pollJson(`http://127.0.0.1:${cdpPort}/json/list`, 20000)
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
      const entry = message.id === undefined ? undefined : pending.get(message.id)
      if (!entry) {
        return
      }
      pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(JSON.stringify(message.error)))
      } else {
        entry.resolve(message.result)
      }
    }

    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })

    await send('Page.enable')
    await send('Runtime.enable')

    // 必须在导航之前注入，否则页面自己的脚本已经跑完了
    if (initScript) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript })
    }

    /** 在页面里求值；返回按值传回的结果 */
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

    const navigate = async (url) => {
      await send('Page.navigate', { url })
    }

    /** 反复求值直到 predicate 为真；超时抛错 */
    const waitFor = async (expression, { timeoutMs = 30000, intervalMs = 200, label } = {}) => {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        last = await evaluate(expression)
        if (last) {
          return last
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      throw new Error(`等待条件超时${label ? `（${label}）` : ''}: ${expression}`)
    }

    return { evaluate, navigate, waitFor, close: async () => {
      // 先请求浏览器自己优雅退出：这条命令精确对应「我们启动的那一个实例」，
      // 不会误伤用户自己开的 Chrome，也不依赖 WMI。
      // 必须在 close()socket 之前发，否则这条消息发不出去。
      try {
        await send('Browser.close')
      } catch {
        // 已经断了就跳过，交给 cleanup 兜底
      }
      try {
        socket.close()
      } catch {
        // 忽略
      }
      cleanup()
    } }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** 极简静态服务器：只服务一个目录，带目录穿越防护 */
export const startStaticServer = async (root) => {
  const { createServer } = await import('node:http')
  const { readFileSync, existsSync, statSync } = await import('node:fs')
  const { extname } = await import('node:path')

  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
  }

  const server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0])
    const name = raw.replace(/^\/+/, '') || 'index.html'
    const file = join(root, name)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(readFileSync(file))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
