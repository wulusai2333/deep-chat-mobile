/**
 * 移动端 UI 预览 —— scripts/ui-preview.mjs
 *
 * 【要解决的问题】
 * 这次改版是把移动端 UI 按官方 App 截图重做，改动集中在 CSS / JSX，构建日志全绿
 * 不代表长得对。所以必须有一个「改完立刻看到 5 个界面」的工具：
 *   欢迎页 / 抽屉 / 附件面板 / 按住说话 / 已输入文字（发送态）+ 桌面端回归图
 *
 * 【为什么要构建锁】
 * 多个 agent/窗口可能同时在跑：prepare-web 会重写 web/src，rspack 会重写 web/dist，
 * 两个进程交错跑会得到「一半新一半旧」的产物，排查时会误判成代码问题。
 * 这里用 .tmp/ui-preview.lock 做串行化（超过 15 分钟的锁视为残留，自动清掉）。
 *
 * 用法：
 *   node scripts/ui-preview.mjs            # prepare + build + 截图
 *   node scripts/ui-preview.mjs --no-build # 跳过构建，只用现有 dist/ 截图
 *
 * 产物：.tmp/ui-preview/latest/*.png（同时留一份带时间戳的目录）
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { info, paths, run, step } from './lib/env.mjs'
import { openBrowser, startStaticServer } from './lib/cdp.mjs'

const args = new Set(process.argv.slice(2))
const shouldBuild = !args.has('--no-build')

const OUT_ROOT = join(paths.root, '.tmp', 'ui-preview')
const LATEST = join(OUT_ROOT, 'latest')
const LOCK = join(paths.root, '.tmp', 'ui-preview.lock')

// ── 构建锁 ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const acquireLock = async (timeoutMs = 15 * 60 * 1000) => {
  mkdirSync(join(paths.root, '.tmp'), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let waited = false
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      // 心跳：每 20 秒刷新 mtime。没有心跳时无法区分「正在构建」和「卡死的残留锁」，
      // 只能靠很长的时间阈值，结果别人要白等十几分钟（实测发生过）。
      const heartbeat = setInterval(() => {
        try {
          const now = new Date()
          utimesSync(LOCK, now, now)
        } catch {
          // 锁已被清理
        }
      }, 20000)
      heartbeat.unref?.()
      return () => {
        clearInterval(heartbeat)
        try {
          unlinkSync(LOCK)
        } catch {
          // 已被清理
        }
      }
    } catch {
      // 锁被占：先判断持有者还活着吗
      let stale = false
      try {
        const pid = Number.parseInt(readFileSync(LOCK, 'utf8').trim(), 10)
        const age = Date.now() - statSync(LOCK).mtimeMs
        if (Number.isFinite(pid) && pid > 0 && !isAlive(pid)) {
          stale = true
        } else if (age > 6 * 60 * 1000) {
          stale = true
        }
      } catch {
        // 读不到（刚被删/刚创建）→ 下一轮再试
      }
      if (stale) {
        try {
          unlinkSync(LOCK)
        } catch {
          // 别人先删了
        }
        continue
      }
      if (!waited) {
        info('另一个构建正在进行（.tmp/ui-preview.lock），排队等待…')
        waited = true
      }
      if (Date.now() > deadline) {
        throw new Error('等待构建锁超时；确认没有卡住的 node 进程后删除 .tmp/ui-preview.lock')
      }
      await sleep(3000)
    }
  }
}

// ── 页面内的错误收集 + 登录态桩 ────────────────────────────────────────────
const INIT_SCRIPT = `(() => {
  window.__UI_ERRORS__ = []
  window.addEventListener('error', (e) => window.__UI_ERRORS__.push('error: ' + (e.message || e.error)))
  window.addEventListener('unhandledrejection', (e) => window.__UI_ERRORS__.push('rejection: ' + (e.reason && e.reason.message)))
  const origError = console.error
  console.error = (...args) => { window.__UI_ERRORS__.push('console: ' + args.map(String).join(' ')); origError(...args) }
  try {
    localStorage.setItem('chat-demo:api-key', 'sk-ui-preview')
    localStorage.setItem('chat-demo:locale', 'zh-CN')
    // 深色截图那一步会先写 dark 再 reload；这里不能每次导航都覆盖回 light
    if (!localStorage.getItem('chat-demo:theme-preference')) {
      localStorage.setItem('chat-demo:theme-preference', 'light')
    }
  } catch {}
  // 余额接口桩：截图里要看到真实的余额排版，而不是失败态；只拦 /user/balance
  if (!window.__BALANCE_STUBBED__) {
    window.__BALANCE_STUBBED__ = true
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.endsWith('/user/balance')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              is_available: true,
              balance_infos: [
                { currency: 'CNY', total_balance: '123.45', granted_balance: '23.45', topped_up_balance: '100.00' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }
      return originalFetch(input, init)
    }
  }
})()`

const shot = async (browser, dir, name) => {
  const file = join(dir, `${name}.png`)
  await browser.screenshot(file)
  info(`截图 ${file}`)
  return file
}

/** 找到某个 aria-label 按钮的中心坐标；找不到返回 null */
const findButton = (browser, labels) =>
  browser.evaluate(`(() => {
    const labels = ${JSON.stringify(labels)}
    const nodes = [...document.querySelectorAll('button, [role="button"]')]
    for (const label of labels) {
      const el = nodes.find((node) => node.getAttribute('aria-label') === label)
      if (el) {
        const rect = el.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }
      }
    }
    return null
  })()`)

const tapLabel = async (browser, labels) => {
  const rect = await findButton(browser, labels)
  if (!rect) {
    throw new Error(`找不到按钮：${labels.join(' / ')}`)
  }
  await browser.tap(rect.x, rect.y)
  return rect
}

/** 可选点击：找不到就跳过（改造过程中某些按钮可能还没实现） */
const tryTapLabel = async (browser, labels) => {
  const rect = await findButton(browser, labels)
  if (!rect) {
    info(`! 找不到按钮 ${labels.join(' / ')}，跳过`)
    return false
  }
  await browser.tap(rect.x, rect.y)
  return true
}

const main = async () => {
  const release = await acquireLock()
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(OUT_ROOT, runId)
  mkdirSync(outDir, { recursive: true })
  let server
  let browser
  try {
    if (shouldBuild) {
      step('准备上游副本 + 移动端覆盖层')
      await run('node', ['scripts/prepare-web.mjs'], { cwd: paths.root })
      step('构建前端')
      await run('node', ['scripts/build-web.mjs'], { cwd: paths.root })
    } else {
      info('--no-build：复用现有 dist/')
    }

    step('截图')
    server = await startStaticServer(paths.dist)
    const workDir = join(paths.root, '.tmp', `ui-browser-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    browser = await openBrowser({ workDir, initScript: INIT_SCRIPT, windowSize: '400,900' })
    await browser.navigate(`${server.url}/index.html`)
    await browser.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 20000, label: '首屏渲染' })

    // ── 桌面端回归（先截，避免受移动端交互状态影响）──────────────────────
    await browser.setViewport({ width: 1280, height: 800, scale: 1, mobile: false })
    await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
    await shot(browser, outDir, '06-desktop-welcome')

    // ── 塞一份假历史数据（会话 + 一条助手回答 + 一张历史图片）────────────
    // 目的：抽屉列表、会话页顶栏、附件面板「最近图片」都需要真实数据才看得出来。
    // 直接按上游 IndexedDB 结构写（web/src/services/chat/db.ts：库 chat-demo v11）。
    await browser.evaluate(`(async () => {
      try {
        const open = indexedDB.open('chat-demo', 11)
        open.onupgradeneeded = () => {
          const db = open.result
          for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
          }
          const summaries = db.objectStoreNames.contains('sessionSummaries')
            ? open.transaction.objectStore('sessionSummaries')
            : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
          if (!summaries.indexNames.contains('fileIds')) summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
        const db = await new Promise((resolve, reject) => {
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(open.error)
        })
        const now = Date.now()
        const imageFileId = 'ui-preview-image'
        const session = {
          id: 'ui-preview-session',
          title: '量子纠缠与贝尔不等式',
          createdAt: now - 1800000,
          updatedAt: now - 60000,
          messages: [
            { id: 'ui-m1', role: 'user', content: '用三句话解释量子纠缠，并配一张示意图。', files: [{ id: imageFileId, serverId: null, name: 'bell.png', size: 1024, isImage: true, mimeType: 'image/png' }], createdAt: now - 1500000 },
            { id: 'ui-m2', role: 'assistant', createdAt: now - 1400000, model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: '量子纠缠是两个粒子共享同一个量子态、无法单独描述的现象。\\n测量其中一个会立即确定另一个的对应结果，无论相隔多远。\\n贝尔不等式实验证明这种关联强于任何经典隐变量解释。' }] },
          ],
        }
        const summary = { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, fileIds: [imageFileId] }
        const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
        tx.objectStore('sessions').put(session)
        tx.objectStore('sessionSummaries').put(summary)
        const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        const bytes = Uint8Array.from(atob(pixel), (ch) => ch.charCodeAt(0))
        tx.objectStore('files').put({ id: imageFileId, blob: new Blob([bytes], { type: 'image/png' }) })
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
      } catch (error) {
        window.__UI_ERRORS__.push('seed: ' + (error && error.message))
      }
    })()`)
    // 重新加载，让 initChat 读到刚写入的历史
    await browser.navigate(`${server.url}/index.html`)
    await browser.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 20000, label: '带数据首屏' })

    // ── 移动端 ──────────────────────────────────────────────────────────
    await browser.setViewport({ width: 393, height: 852, scale: 2, mobile: true })
    await browser.evaluate(`new Promise((r) => setTimeout(r, 900))`)
    await shot(browser, outDir, '01-mobile-welcome')

    await tapLabel(browser, ['打开边栏', 'Open sidebar', '展开侧边栏'])
    await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
    await shot(browser, outDir, '02-mobile-drawer')

    // 点右侧露出的主界面关抽屉
    await browser.tap(373, 420)
    await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)

    const plus = await findButton(browser, ['添加附件', 'Add attachment', '上传文件'])
    if (plus) {
      await browser.tap(plus.x, plus.y)
      await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
      await shot(browser, outDir, '03-mobile-attach')

      // 官方截图 3 里语音模式和附件面板是同时展开的（先开面板再点麦克风），
      // 所以这里不关面板，直接点麦克风 → 04 才能和官方截图对齐。
      const micInPanel = await findButton(browser, ['语音输入', 'Voice input'])
      if (micInPanel) {
        await browser.tap(micInPanel.x, micInPanel.y)
        await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
        await shot(browser, outDir, '04-mobile-voice')
        // 键盘键退出语音模式（面板保持），再关面板
        await tryTapLabel(browser, ['键盘输入', 'Keyboard'])
        await browser.evaluate(`new Promise((r) => setTimeout(r, 400))`)
      } else {
        info('! 附件面板里没有麦克风按钮，跳过语音截图')
      }
      await tryTapLabel(browser, ['关闭', 'Close', '取消'])
      await browser.evaluate(`new Promise((r) => setTimeout(r, 500))`)
    } else {
      info('! 没有附件按钮，跳过附件面板截图')
    }

    // 输入文字看发送态
    await browser.evaluate(`(() => {
      const textarea = document.querySelector('textarea')
      if (!textarea) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, '用三句话解释量子纠缠')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await browser.evaluate(`new Promise((r) => setTimeout(r, 600))`)
    await shot(browser, outDir, '05-mobile-typed')

    // ── 会话页（顶栏标题 + 朗读按钮 + 消息列表 + 输入框）──────────────────
    await tryTapLabel(browser, ['打开边栏', 'Open sidebar'])
    await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
    const sessionRow = await browser.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('div, button, span')]
      const el = nodes.find(
        (node) => node.children.length === 0 && (node.textContent || '').trim() === '量子纠缠与贝尔不等式'
      )
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    if (sessionRow) {
      await browser.tap(sessionRow.x, sessionRow.y)
      await browser.evaluate(`new Promise((r) => setTimeout(r, 900))`)
      await shot(browser, outDir, '07-mobile-session')
    } else {
      info('! 抽屉里没找到假会话，跳会话页截图')
    }

    // ── 深色主题（token 覆盖是否正常）──────────────────────────────────────
    await browser.evaluate(`localStorage.setItem('chat-demo:theme-preference', 'dark')`)
    await browser.navigate(`${server.url}/index.html`)
    await browser.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 20000, label: '深色首屏' })
    await browser.evaluate(`new Promise((r) => setTimeout(r, 800))`)
    await shot(browser, outDir, '08-mobile-welcome-dark')
    const darkPlus = await findButton(browser, ['添加附件', 'Add attachment', '上传文件'])
    if (darkPlus) {
      await browser.tap(darkPlus.x, darkPlus.y)
      await browser.evaluate(`new Promise((r) => setTimeout(r, 700))`)
      await shot(browser, outDir, '09-mobile-attach-dark')
    }

    // ── 页面错误 ────────────────────────────────────────────────────────
    const errors = await browser.evaluate(`window.__UI_ERRORS__ || []`)
    if (errors.length > 0) {
      process.stderr.write(`\n页面内错误 ${errors.length} 条：\n${errors.map((e) => `  - ${e}`).join('\n')}\n`)
    } else {
      info('页面无 error / unhandledrejection')
    }

    // 把本次产物同步到 latest/
    rmSync(LATEST, { recursive: true, force: true })
    mkdirSync(LATEST, { recursive: true })
    for (const name of readdirSync(outDir)) {
      await import('node:fs').then(({ cpSync }) => cpSync(join(outDir, name), join(LATEST, name)))
    }
    info(`产物：${LATEST}`)

    step('完成')
  } finally {
    await browser?.close()
    await server?.close()
    release()
  }
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
