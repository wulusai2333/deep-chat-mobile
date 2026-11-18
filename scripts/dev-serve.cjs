/**
 * 一个临时静态服务器，只用于本地验收 pwa-dist/。
 * 用完即弃 —— 不属于交付物。
 */
const { createServer } = require('node:http')
const { readFileSync, existsSync, statSync } = require('node:fs')
const { join, extname, normalize } = require('node:path')

const root = process.argv[2] || 'pwa-dist'
const port = Number(process.argv[3] || 8098)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

createServer((req, res) => {
  let pathname = decodeURIComponent(req.url.split('?')[0])
  if (pathname === '/') pathname = '/index.html'
  // 防止 ../ 逃出 root
  const file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    // SW 需要这些头在真实托管上也可能缺失，这里给正确的值
    'cache-control': 'no-cache',
  })
  res.end(readFileSync(file))
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`serving ${root} on http://127.0.0.1:${port}\n`)
})
