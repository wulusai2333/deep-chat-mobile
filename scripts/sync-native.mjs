/**
 * 把 native/ 下的原生源码同步进 android/ 工程。
 *
 * 为什么不在 android/ 里直接改：
 * `npx cap add android` 会重新生成 android/，`cap sync` 也可能覆盖部分文件。
 * 把「我们的原生代码」放在 native/ 作为唯一真源，android/ 只是被写入的产物目录 ——
 * 这样 android/ 可以随时删掉重建，原生改动永不丢失。
 *
 * 覆盖范围（刻意很小）：
 *   native/android-app/MainActivity.java   → app/src/main/java/com/example/chatdemo/MainActivity.java
 *   native/*XXXX*Plugin.java               → app/src/main/java/com/example/chatdemo/plugins/
 *
 * 已存在且内容相同的文件不写盘，避免无意义的 gradle 增量失效。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, info, paths, step } from './lib/env.mjs'

const PACKAGE_DIR = join(paths.android, 'app', 'src', 'main', 'java', 'com', 'example', 'chatdemo')
const PLUGIN_DIR = join(PACKAGE_DIR, 'plugins')

/** 只在内容真的变了才写，返回是否写入 */
const writeIfChanged = (target, content) => {
  if (existsSync(target) && readFileSync(target, 'utf8') === content) {
    return false
  }
  writeFileSync(target, content)
  return true
}

const main = () => {
  step('同步原生源码 native/ → android/')
  if (!existsSync(paths.android)) {
    throw new Error('android/ 不存在，先运行：pnpm cap:add（或 npx cap add android）')
  }
  ensureDir(PLUGIN_DIR)

  let written = 0
  let unchanged = 0

  // MainActivity 是壳的入口，单独放，因为它在包根目录而不是 plugins/
  const mainActivitySource = join(paths.native, 'android-app', 'MainActivity.java')
  if (!existsSync(mainActivitySource)) {
    throw new Error(`缺少 ${mainActivitySource}`)
  }
  const mainActivityTarget = join(PACKAGE_DIR, 'MainActivity.java')
  if (writeIfChanged(mainActivityTarget, readFileSync(mainActivitySource, 'utf8'))) {
    info('MainActivity.java: 已更新')
    written += 1
  } else {
    info('MainActivity.java: 无变化')
    unchanged += 1
  }

  // 插件：native/<插件目录>/<插件>.java
  const pluginDirs = readdirSync(paths.native, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'android-app')
    .map((entry) => entry.name)

  for (const dir of pluginDirs) {
    const dirPath = join(paths.native, dir)
    const javaFiles = readdirSync(dirPath).filter((name) => name.endsWith('.java'))
    if (javaFiles.length === 0) {
      continue
    }
    for (const file of javaFiles) {
      const source = join(dirPath, file)
      const target = join(PLUGIN_DIR, file)
      if (writeIfChanged(target, readFileSync(source, 'utf8'))) {
        info(`${file}: 已更新`)
        written += 1
      } else {
        unchanged += 1
      }
    }
  }

  info(`同步完成：写入 ${written} 个文件，未变 ${unchanged} 个`)
  info(`插件目录：${PLUGIN_DIR}`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`\n\u001b[31m✗ ${error.message}\u001b[0m\n`)
  process.exit(1)
}
