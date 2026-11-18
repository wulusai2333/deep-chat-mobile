/**
 * 生成 release 签名用的 keystore。
 *
 * 关键约束（写错会导致「以后无法升级安装」）：
 *   • alias 与口令一旦用于发布就不能改 —— Android 用「包名 + 签名」判定是不是同一个应用，
 *     换了签名就只能先卸载再装，用户数据全丢；
 *   • validity 给 10000 天（约 27 年），避免证书过期后无法更新；
 *   • keystore 文件与 keystore.properties 都在 .gitignore 里 —— 绝不能进版本库。
 *
 * 本脚本只在 keystore 不存在时生成，不会覆盖已有文件（覆盖 = 丢掉发布签名）。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step, warn } from './lib/env.mjs'

const KEYSTORE_FILE = 'chat-demo.keystore'
const KEY_ALIAS = 'chatdemo'
const VALIDITY_DAYS = '10000'

/**
 * 口令策略：本地开发用固定值，发布前必须换成自己的。
 * 这里显式打印出来，是为了让「口令是公开的开发默认值」这件事不可能被忽略。
 */
const DEFAULT_STORE_PASSWORD = 'chatdemo-dev'
const DEFAULT_KEY_PASSWORD = 'chatdemo-dev'

const main = async () => {
  const javaHome = process.env.JAVA_HOME
  if (!javaHome) {
    fail('JAVA_HOME 未设置', 'keytool 随 JDK 提供，需要 JDK 17 或 21。见 docs/build.md')
  }
  const keytool = join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')

  const keystorePath = join(paths.android, KEYSTORE_FILE)
  if (existsSync(keystorePath)) {
    // 绝不覆盖：覆盖等于让已发布的版本永远无法再升级
    info(`keystore 已存在，跳过生成：${keystorePath}`)
    info('如需重新生成，请先手动删除它（注意：已发布的包将无法覆盖安装）')
    return
  }

  step('生成 keystore')
  await run(keytool, [
    '-genkeypair',
    '-v',
    '-keystore', keystorePath,
    '-alias', KEY_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', VALIDITY_DAYS,
    '-storepass', DEFAULT_STORE_PASSWORD,
    '-keypass', DEFAULT_KEY_PASSWORD,
    '-dname', 'CN=Deep Chat, OU=Mobile, O=DeepChat, L=, ST=, C=CN',
  ])
  info(`已生成：${keystorePath}`)

  step('写入 android/keystore.properties')
  const properties = [
    '# 由 scripts/make-keystore.mjs 生成 —— 不要提交到版本库（已在 .gitignore 中）',
    `storeFile=${KEYSTORE_FILE}`,
    `storePassword=${DEFAULT_STORE_PASSWORD}`,
    `keyAlias=${KEY_ALIAS}`,
    `keyPassword=${DEFAULT_KEY_PASSWORD}`,
  ].join('\n')
  writeFileSync(join(paths.android, 'keystore.properties'), `${properties}\n`)

  warn('口令是开发默认值（chatdemo-dev），仅适合自己用')
  warn('要对外分发，请另生成一个 keystore 并把口令改成只有你知道的强口令')
  warn(`keystore 与口令务必离线备份 —— 丢失后无法再发布可覆盖安装的新版本`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
