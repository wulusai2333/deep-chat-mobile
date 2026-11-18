/**
 * cap sync：把 dist/ 灌进 android/app/src/main/assets/public，并刷新插件清单。
 *
 * 为什么值得单独包一层：
 *   - `cap sync` 之前必须先有 dist/，否则它会把空目录同步进去，装到手机上白屏；
 *   - 同步完要检查 assets 里真的有 index.html，把「构建顺序错了」这件事变成
 *     一句明确的报错，而不是运行时的白屏排查；
 *   - 原生源码的同步（native/ → android/）也要在这里顺带做，保证一次命令到位。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step } from './lib/env.mjs'

const main = async () => {
  step('检查 dist/')
  if (!existsSync(join(paths.dist, 'index.html'))) {
    fail('dist/index.html 不存在', '先运行：pnpm build:web')
  }
  const entries = readdirSync(paths.dist)
  info(`dist/ 顶层：${entries.join(', ')}`)

  step('同步原生源码')
  await run(process.execPath, [join(paths.scripts, 'sync-native.mjs')], { cwd: paths.root })

  step('cap sync android')
  // 用 CLI 的入口而不是 npx：npx 会尝试联网解析，离线环境下会卡住。
  // 注意文件名是 bin/capacitor（无扩展名），不是 capacitor.js。
  const cli = join(paths.root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')
  if (!existsSync(cli)) {
    fail('没有找到 @capacitor/cli', '先运行：pnpm install')
  }
  await run(process.execPath, [cli, 'sync', 'android'], { cwd: paths.root })

  step('校验灌入结果')
  const assets = join(paths.android, 'app', 'src', 'main', 'assets', 'public')
  if (!existsSync(join(assets, 'index.html'))) {
    fail('同步后 assets/public 里没有 index.html', 'WebView 会白屏，检查 webDir 与 dist/ 的对应关系')
  }
  // 检查 JS/CSS 真的进去了：只有 index.html 而没资源，等于加载失败
  const jsDir = join(assets, 'static', 'js')
  if (!existsSync(jsDir) || readdirSync(jsDir).length === 0) {
    fail('assets/public/static/js 为空', '构建产物不完整，重跑 pnpm build:web')
  }
  const jsFiles = readdirSync(jsDir)
  info(`assets/public/static/js：${jsFiles.join(', ')}`)
  info(`index.html ${statSync(join(assets, 'index.html')).size} 字节`)

  step('完成')
  info('下一步：pnpm android:debug 或 pnpm android:release')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
