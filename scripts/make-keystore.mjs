/**
 * 生成 release 签名用的 keystore。
 *
 * 关键约束（写错会导致「以后无法升级安装」）：
 *   • alias 与口令一旦用于发布就不能改 —— Android 用「包名 + 签名」判定是不是同一个应用，
 *     换了签名就只能先卸载再装，用户数据全丢；
 *   • validity 给 10000 天（约 27 年），避免证书过期后无法更新；
 *   • 发布 keystore 与 keystore.properties **绝不进版本库**：私钥只存在本机 +
 *     你的离线备份，仓库只保存证书指纹（android/release-cert.sha256，公开信息）。
 *     私钥入库意味着任何拿到仓库的人都能签出「能覆盖安装」的假更新。
 *
 * 本脚本只在 keystore 不存在时生成，不会覆盖已有文件（覆盖 = 丢掉发布签名）。
 * 如果 release-cert.sha256 已经存在但 keystore 不见了，说明发布签名丢失 ——
 * 这时**绝不重新生成**，否则等于换签名，已安装用户全部无法升级。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, info, paths, run, step, warn } from './lib/env.mjs'

const KEYSTORE_FILE = 'deep-chat.keystore'
const KEY_ALIAS = 'deepchat'
const VALIDITY_DAYS = '10000'

/**
 * 口令策略：本地开发用固定值，发布前必须换成自己的。
 * 这里显式打印出来，是为了让「口令是公开的开发默认值」这件事不可能被忽略。
 */
const DEFAULT_STORE_PASSWORD = 'deepchat-dev'
const DEFAULT_KEY_PASSWORD = 'deepchat-dev'

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

  // 发布指纹已经记录在案、但私钥不见了：这是「发布签名丢失」事故。
  // 重新生成 = 换签名 = 所有已安装用户无法覆盖升级，必须停下来让人恢复备份。
  if (existsSync(join(paths.android, 'release-cert.sha256'))) {
    fail(
      '发布签名丢失，拒绝重新生成',
      [
        `期望的 keystore：${keystorePath}`,
        'android/release-cert.sha256 已记录发布证书指纹，说明这个项目已经发过包。',
        '',
        '请先从离线备份恢复 android/deep-chat.keystore 与 android/keystore.properties。',
        '（本仓库不保存私钥，git 历史里也没有；恢复来源是你的密码管理器/加密盘备份。）',
        '丢失后，指纹文件只能证明「该用哪把钥匙」，本身救不回签名。',
        '',
        '确实无法恢复时才考虑轮换签名，但那意味着老用户必须卸载重装、本地会话清空；',
        '流程见 docs/build.md §4。不要直接跑本脚本生成新密钥。',
      ].join('\n')
    )
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
    '# 由 scripts/make-keystore.mjs 生成 —— 本机文件，绝不入库；请离线备份',
    '# 换签名会导致老版本无法覆盖安装，动手前先读 docs/build.md §4',
    `storeFile=${KEYSTORE_FILE}`,
    `storePassword=${DEFAULT_STORE_PASSWORD}`,
    `keyAlias=${KEY_ALIAS}`,
    `keyPassword=${DEFAULT_KEY_PASSWORD}`,
  ].join('\n')
  writeFileSync(join(paths.android, 'keystore.properties'), `${properties}\n`)

  warn('口令是开发默认值（deepchat-dev），仅适合自己用')
  warn('要对外分发，请另生成一个 keystore 并把口令改成只有你知道的强口令')
  warn(`keystore 与口令务必离线备份 —— 丢失后无法再发布可覆盖安装的新版本`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
