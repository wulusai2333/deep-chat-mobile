/**
 * 构建静态站点：web/ 源码 → dist/
 *
 * 【为什么不直接 `pnpm --dir web build`】
 * 上游 package.json 的 build 脚本是 `rm -rf dist && NODE_ENV=production rspack build`，
 * 在 Windows cmd 里 `NODE_ENV=production` 不是合法语法，会报
 * `'NODE_ENV' is not recognized as an internal or external command`。
 * 这里用 node 直接调 rspack 的入口，并用 process.env 传 NODE_ENV，
 * 三个平台都能跑 —— 不让「在 Windows 上编不出来」变成项目的前提条件。
 */

import { cpSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, fail, info, paths, pkgVersion, step, warn } from './lib/env.mjs'

/** 递归统计文件数与总字节，用来在日志里给出「确实产物化了」的证据 */
const treeStats = (dir) => {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else {
        files += 1
        bytes += stat.size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const main = async () => {
  const source = join(paths.web, 'dist')
  rmSync(source, { recursive: true, force: true })
  rmSync(paths.dist, { recursive: true, force: true })

  step('构建上游前端（rspack，production）')
  if (!existsSync(join(paths.web, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js'))) {
    fail('web/node_modules 不完整', '先运行：pnpm web:install')
  }
  // 用子进程跑 rspack：它自己会做 module resolution，和 `npx rspack` 完全等价。
  // NODE_ENV 走环境变量，避开 Windows 不支持 `KEY=value cmd` 的坑。
  const { run } = await import('./lib/env.mjs')
  await run(
    process.execPath,
    [join(paths.web, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js'), 'build', '-c', 'rspack.config.ts'],
    { cwd: paths.web, env: { ...process.env, NODE_ENV: 'production' } }
  )

  if (!existsSync(join(source, 'index.html'))) {
    fail('构建没有产出 dist/index.html', '检查 web/rspack.config.ts 的 output 配置')
  }

  step('复制产物到项目 dist/')
  ensureDir(paths.dist)
  cpSync(source, paths.dist, { recursive: true })

  const { files, bytes } = treeStats(paths.dist)
  info(`dist/ 共 ${files} 个文件，${(bytes / 1024).toFixed(0)} KB`)

  // 版本号写进产物，方便在设备上确认「装的是不是这一版」
  info(`应用版本 ${pkgVersion()}`)
  warn('提醒：dist/ 由 web/ 构建而来，不要手工编辑；改动请落在 web-patches/ 并重跑 pnpm web:prepare')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
