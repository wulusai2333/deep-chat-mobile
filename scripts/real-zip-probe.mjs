/**
 * 用真实导出的 ZIP 跑一遍合并导入 —— scripts/real-zip-probe.mjs
 *
 * 【为什么需要它】
 * scripts/test-import.mjs 用的是自己造的夹具（几百字节、1-2 条会话）。
 * 用户的真实归档是 32 MB / 677 个条目 / 593 条会话，量级差两个数量级，
 * 夹具测不到的东西（内存、大文件、真实字段、附件命名）全在里面。
 *
 * 这个脚本不改任何生产代码，只做一件事：把真实 ZIP 交给**实际进 APK 的那份
 * mergeImport**，在真实的 IndexedDB 里跑，然后把每一步的结果打印出来。
 *
 * 用法：
 *   node scripts/real-zip-probe.mjs "C:\path\to\deepseek_data.zip"
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step } from './lib/env.mjs'
import { openBrowser, startStaticServer } from './lib/cdp.mjs'

const zipPath = process.argv[2]
if (!zipPath) {
  fail('缺少参数', '用法：node scripts/real-zip-probe.mjs <zip 路径>')
}
const sizeMb = statSync(zipPath).size / 1024 / 1024
step(`真实 ZIP 探针：${zipPath}（${sizeMb.toFixed(1)} MB）`)

// ── 把 ZIP 以 base64 内联进页面 ───────────────────────────────────────────
// 不能靠 fetch(file://)，也不能让页面直接读本地路径。
// base64 会把体积放大 4/3（32 MB → 约 44 MB 字符串），这是刻意接受的：
// 探针只跑一次，换来的是「不需要起任何假设的文件服务器」。
const zipBase64 = readFileSync(zipPath).toString('base64')
info(`内联 base64 长度 ${(zipBase64.length / 1024 / 1024).toFixed(1)} MB`)

const workDir = join(paths.root, '.tmp', `real-zip-${Date.now()}-${process.pid}`)
mkdirSync(workDir, { recursive: true })

// ── 打测试 bundle ────────────────────────────────────────────────────────
const rspackCli = join(paths.web, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')
const configPath = join(paths.scripts, 'probe.rspack.config.mjs')
await run(process.execPath, [rspackCli, 'build', '-c', configPath], {
  cwd: paths.root,
  env: { DEEPCHAT_PROBE_DIR: workDir },
})

const bundle = readFileSync(join(workDir, 'bundle.js'), 'utf8')
const probe = readFileSync(join(paths.scripts, 'probe.entry.ts'), 'utf8')

// ── 组装页面 ─────────────────────────────────────────────────────────────
// 真实 ZIP 太大，不塞进 initScript（CDP 单条消息有大小限制），
// 改成页面内用 fetch 读一个由本地静态服务器提供的文件。
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>real zip probe</title></head>
<body><pre id="out">running…</pre>
<script>
  var __API_ORIGIN__ = 'https://api.deepseek.com'
  window.__LOGS__ = []
  const _log = console.log
  console.log = (...a) => { window.__LOGS__.push(a.map(String).join(' ')); _log(...a) }
  window.__PROBE_DONE__ = false
  window.__PROBE_RESULT__ = null
</script>
<script src="./bundle.js"></script>
<script>
  (async () => {
    try {
      const response = await fetch('./input.zip')
      if (!response.ok) throw new Error('fetch input.zip: HTTP ' + response.status)
      const blob = await response.blob()
      window.__PROBE_ZIP_BYTES__ = blob.size
      const file = new File([blob], 'deepseek_data.zip', { type: 'application/zip' })
      const result = await window.__PROBE__(file)
      window.__PROBE_RESULT__ = result
    } catch (error) {
      window.__PROBE_RESULT__ = { fatal: String(error && error.message || error), stack: String(error && error.stack || '') }
    } finally {
      window.__PROBE_DONE__ = true
    }
  })()
</script>
</body></html>`

writeFileSync(join(workDir, 'bundle.js'), bundle)
writeFileSync(join(workDir, 'index.html'), html)
// 软链接/复制真实 ZIP 到静态根，供 fetch 读取
writeFileSync(join(workDir, 'input.zip'), readFileSync(zipPath))
info(`探针入口 ${(probe.length / 1024).toFixed(1)} KB（仅供阅读对照）`)

const server = await startStaticServer(workDir)
let browser
try {
  browser = await openBrowser({ workDir: join(workDir, 'profile') })
  await browser.navigate(`${server.url}/index.html`)
  // 等页面出结果。这里不用 browser.waitFor 一次等到底：
  // 大归档导入是分钟级操作，卡住时必须能看出卡在哪个阶段，
  // 所以每 2 秒把心跳与最新日志打出来（页面主线程长时间忙时 evaluate 会超时，跳过即可）。
  const deadline = Date.now() + 600000
  let lastBeat
  let lastLogs
  let result = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      const state = await browser.evaluate(
        `JSON.stringify({done: window.__PROBE_DONE__ === true, beat: window.__PROBE_HEARTBEAT__ || null, logs: (window.__LOGS__||[]).slice(-4), result: window.__PROBE_DONE__ ? window.__PROBE_RESULT__ : null})`
      )
      const parsed = JSON.parse(state)
      if (parsed.beat !== lastBeat) {
        lastBeat = parsed.beat
        info(`…${parsed.beat ?? '（未开始）'}`)
      }
      const tail = parsed.logs.join('\n')
      if (tail !== lastLogs) {
        lastLogs = tail
        for (const line of parsed.logs) {
          console.log('  ' + line)
        }
      }
      if (parsed.done) {
        result = parsed.result
        break
      }
    } catch {
      // 页面主线程忙（同步解压/写库），下个周期再试
    }
  }
  if (!result) {
    throw new Error(`等待超时（600s），最后心跳：${lastBeat ?? '未知'}`)
  }
  const logs = await browser.evaluate(`JSON.stringify(window.__LOGS__)`)
  const bytes = await browser.evaluate(`window.__PROBE_ZIP_BYTES__ || 0`)

  info(`页面收到的 ZIP 字节数：${bytes}`)
  console.log('\n=== 页面日志 ===')
  for (const line of JSON.parse(logs)) {
    console.log('  ' + line)
  }
  console.log('\n=== 结果 ===')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
