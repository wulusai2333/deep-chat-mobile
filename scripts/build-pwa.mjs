/**
 * PWA 兜底产物 —— scripts/build-pwa.mjs
 *
 * 【这个产物是为什么存在的】
 * 需求里写了「鸿蒙 NEXT 不再兼容 APK」。一旦用户升级到 NEXT，现有 APK 直接打不开。
 * 到时候唯一的过渡方案是「用浏览器打开，加桌面快捷方式」。
 * 但 upstream chat-demo 是纯静态站，没有 manifest、没有 service worker，
 * 直接部署到静态托管只能"每次联网重新加载"，谈不上是一个 App。
 * 所以这里补两份文件，让同一份 dist/ 也能作为可安装的 PWA 工作。
 *
 * 【为什么 service worker 只缓存外壳、不缓存 API 响应】
 * 会话历史存在 IndexedDB（上游本来就是本地优先），API 请求是实时的。
 * 缓存 API 响应会造成「看到的回复和实际不一致」，比离线不可用更糟。
 * 所以 SW 只做两件事：
 *   1. 缓存构建产物（HTML/JS/CSS/字体），让冷启动可离线；
 *   2. 网络请求一律放行，不介入。
 * 唯一例外是导航请求：离线时回落到缓存的 index.html（SPA 兜底）。
 *
 * 【为什么不用 Workbox】
 * 一行 npm 依赖都不给上游加。手写 30 行 service worker 已经够用，
 * 而且行为完全可读 —— 出问题时不需要 debug 一个生成出来的运行时。
 */

import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fail, info, paths, pkgVersion, step } from './lib/env.mjs'

/** 递归列出目录下所有文件（相对路径，用 / 分隔，SW 里要当 URL 用） */
const walk = (dir, base = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, base, out)
    } else {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

const main = () => {
  step('组装 PWA 产物')

  if (!existsSync(join(paths.dist, 'index.html'))) {
    fail('dist/index.html 不存在，先运行 pnpm build:web')
  }

  // pwa-dist/ 是最终可直接上传到任意静态托管的目录
  const out = paths.pwa
  cpSync(paths.dist, out, { recursive: true })
  info(`已复制 dist/ → pwa-dist/`)

  // 图标
  const iconsOut = join(out, 'icons')
  if (existsSync(join(paths.root, 'pwa-icons'))) {
    cpSync(join(paths.root, 'pwa-icons'), iconsOut, { recursive: true })
    info('已复制图标到 pwa-dist/icons/')
  } else {
    info('提示：没有 pwa-icons/，先运行 pnpm icons')
  }

  const version = pkgVersion()

  // ── manifest.webmanifest ────────────────────────────────────────────────
  // display: standalone —— 加到桌面后没有浏览器地址栏，观感接近原生
  // orientation: portrait —— 与 APK 一致（应用本身是竖屏优先的聊天界面）
  // background_color / theme_color 用 App 的深色底，避免启动白闪
  const manifest = {
    name: 'Chat Demo',
    short_name: 'Chat Demo',
    description: '把对话留在本机的聊天客户端',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#1b1f2b',
    theme_color: '#1b1f2b',
    lang: 'zh-CN',
    dir: 'ltr',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: 'icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
  writeFileSync(join(out, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`)
  info('已写入 manifest.webmanifest')

  // ── service worker ──────────────────────────────────────────────────────
  // 预缓存清单在构建时写死：这样 SW 不需要在安装时探测，
  // 也不会因为漏缓存某个 async chunk 而在离线时白屏。
  const assets = walk(out).filter(
    (name) =>
      !name.endsWith('sw.js') &&
      !name.endsWith('manifest.webmanifest') &&
      // 图标单独按需缓存即可，不必占预缓存配额
      !name.startsWith('icons/')
  )
  // 逐个带版本号，换版本时旧缓存整体作废
  const precache = assets.map((name) => `./${name}`)

  const sw = `/*
 * Chat Demo service worker —— 由 scripts/build-pwa.mjs 生成，请勿手工编辑。
 *
 * 设计约束（见 docs/build.md 的「PWA 兜底」一节）：
 *   1. 只缓存构建产物，不缓存任何 API 响应 —— 否则界面上的回复和服务器不一致。
 *   2. 导航请求走 network-first：有网时永远拿最新 HTML；
 *      断网时回落到缓存的 index.html，SPA 才能继续工作。
 *   3. 静态资源走 cache-first：文件名带 contenthash，内容变了文件名就变，
 *      所以"永不更新"是安全的。
 *
 * 版本号用构建时间，每次 pnpm pwa 都会变，触发 SW 更新。
 */
const CACHE = 'chat-demo-${version}-${Date.now().toString(36)}'

const PRECACHE = ${JSON.stringify(precache, null, 2)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 用 addAll 会「一个失败全失败」，这里逐个加，容忍个别 404
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
        )
      )
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // 只处理同源 GET。API 请求（api.deepseek.com）是跨域的，直接放行，
  // 绝不介入 —— 流式响应被 SW 包一层会破坏 SSE。
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) {
    return
  }

  // 导航请求：network-first，断网回落到缓存的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('./index.html').then((cached) => cached ?? Response.error())
      )
    )
    return
  }

  // 其余静态资源：cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached
      }
      return fetch(request).then((response) => {
        // 只缓存成功的、同源的、基本类型的响应
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    })
  )
})
`
  writeFileSync(join(out, 'sw.js'), sw)
  info(`已写入 sw.js（预缓存 ${precache.length} 个文件）`)

  // ── 在 index.html 里注册 SW 并挂 manifest ───────────────────────────────
  // 注意：这一步只改 pwa-dist 的副本，不动 dist/ ——
  // APK 里不需要 service worker（资源本来就在本地），多一个 SW 只会添乱。
  const indexPath = join(out, 'index.html')
  let html = readFileSync(indexPath, 'utf8')
  const head = [
    '<link rel="manifest" href="./manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="./icons/icon-192.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
  ].join('\n    ')
  html = html.replace('</head>', `    ${head}\n  </head>`)

  // 注册脚本放在 body 末尾、主 bundle 之前。
  // 用 load 事件而不是立即执行：让首屏渲染优先，SW 注册晚一点没影响。
  const register = `<script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('./sw.js').catch(function (error) {
            console.warn('[pwa] service worker 注册失败', error)
          })
        })
      }
    </script>`
  html = html.replace('</body>', `    ${register}\n  </body>`)
  writeFileSync(indexPath, html)
  info('已注入 manifest 与 SW 注册脚本')

  step('完成')
  info(`产物目录：${out}`)
  info('本地预览：npx serve pwa-dist   （或任意静态服务器）')
  info('注意：SW 需要 https 或 localhost；直接双击 index.html（file://）不会生效。')
}

main()
