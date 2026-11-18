/**
 * 构建 APK（debug / release）。
 *
 * 为什么用脚本而不是让用户敲 gradlew：
 *   1. Windows / macOS / Linux 的 gradlew 调用方式不同（gradlew.bat vs ./gradlew）；
 *   2. JAVA_HOME 与 ANDROID_HOME 经常没设，报错信息对非 Android 开发者毫无帮助；
 *   3. 产物要从 build/outputs 拷到 dist-apk/，并改成带版本号的名字。
 * 这三件事包在这里，`pnpm android:release` 就是完整的「从源码到可安装文件」。
 *
 * 【签名是这个脚本的第一等公民】
 * Android 用「包名 + 签名」判定是不是同一个应用：签名一变，已装版本就无法覆盖
 * 安装（INSTALL_FAILED_UPDATE_INCOMPATIBLE），用户只能卸载重装、本地会话全丢。
 * 所以 release 构建：
 *   • keystore / keystore.properties 缺失 → 直接失败，绝不产出「能编译但装不上」的包；
 *     这两个文件**只在本机**（.gitignore），仓库里只有证书指纹；
 *   • 构建后把 APK 证书 SHA-256 与 android/release-cert.sha256 比对，不一致直接失败；
 *   • debug 构建也用同一把 release 密钥（见 app/build.gradle），保证 debug/release
 *     可以互相覆盖，不会因为「先装过 debug 包」而卡住正式包升级。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, ensureDir, fail, info, paths, pkgVersion, run, step, warn } from './lib/env.mjs'

const args = new Set(process.argv.slice(2))
const isRelease = args.has('--release')

/** 发布证书指纹的唯一真源：入库的 android/release-cert.sha256 */
const CERT_FILE = join(paths.android, 'release-cert.sha256')

/** 读发布证书 SHA-256；没有或格式不对返回 null */
const expectedCertSha256 = () => {
  if (!existsSync(CERT_FILE)) {
    return null
  }
  const line = readFileSync(CERT_FILE, 'utf8')
    .split('\n')
    .map((value) => value.trim())
    .find((value) => /^[0-9a-f]{64}$/i.test(value))
  return line ? line.toLowerCase() : null
}

/** 找到 build-tools 目录（apksigner 随它提供） */
const buildToolsDir = () => {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  const root = join(sdk, 'build-tools')
  if (!existsSync(root)) {
    return null
  }
  const versions = readdirSync(root).sort().reverse()
  return versions.length > 0 ? join(root, versions[0]) : null
}

/** apksigner 可执行文件路径；找不到返回 null */
const apksigner = () => {
  const dir = buildToolsDir()
  if (!dir) {
    return null
  }
  const name = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'
  const candidate = join(dir, name)
  return existsSync(candidate) ? candidate : null
}

/**
 * 校验构建环境，缺什么就明确说出来。
 * 不自动装 SDK —— 那样失败时的错误更难理解，而且会悄悄改用户的环境。
 */
const checkEnv = () => {
  const problems = []

  const javaHome = process.env.JAVA_HOME
  if (!javaHome) {
    problems.push('JAVA_HOME 未设置（需要 JDK 17 或 21，例如 D:\\soft\\java\\jdk-21）')
  } else if (!existsSync(join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    problems.push(`JAVA_HOME 指向的目录里没有 java：${javaHome}`)
  }

  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdk) {
    problems.push('ANDROID_HOME / ANDROID_SDK_ROOT 未设置（需要 Android SDK，例如 D:\\soft\\android-sdk）')
  } else if (!existsSync(join(sdk, 'platforms'))) {
    problems.push(`SDK 目录里没有 platforms/：${sdk}`)
  }

  // release 签名前置检查：宁可在这里失败，也不要产出装不上的包
  if (isRelease) {
    const propertiesFile = join(paths.android, 'keystore.properties')
    if (!existsSync(propertiesFile)) {
      problems.push(
        'release 签名配置缺失：android/keystore.properties（发布私钥只在本机，不入库；请从离线备份恢复，见 docs/build.md §4）'
      )
    } else {
      const properties = readFileSync(propertiesFile, 'utf8')
      const storeFile = /^storeFile=(.+)$/m.exec(properties)?.[1]?.trim()
      if (!storeFile) {
        problems.push('android/keystore.properties 里没有 storeFile=')
      } else if (!existsSync(join(paths.android, storeFile))) {
        problems.push(`android/keystore.properties 指向的 keystore 不存在：${join(paths.android, storeFile)}`)
      }
    }
    if (!expectedCertSha256()) {
      problems.push('android/release-cert.sha256 缺失或格式错误（发布证书指纹是构建的硬约束）')
    }
  }

  if (problems.length > 0) {
    fail('构建环境不完整', [...problems, '', '见 docs/build.md 的「环境准备」一节'].join('\n'))
  }
  info(`JAVA_HOME=${javaHome}`)
  info(`ANDROID_HOME=${sdk}`)
}

/** gradlew 在 Windows 上必须用 .bat */
const gradlew = () =>
  join(paths.android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')

/**
 * 版本号从 package.json 派生，保证 APK 与 web 产物版本一致。
 * versionCode 用 semver 的三段拼出来：0.2.1 → 201，单调递增且够用很久。
 */
const versionArgs = () => {
  const version = pkgVersion()
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const code = major * 10000 + minor * 100 + patch
  return [
    `-PdeepchatVersionName=${version}`,
    `-PdeepchatVersionCode=${code}`,
  ]
}

/**
 * 校验 APK 签名与发布基线是否一致。
 * 返回实际证书 SHA-256（小写）；校验失败直接 fail。
 */
const verifySignature = async (apk, { requireBaseline }) => {
  const signer = apksigner()
  if (!signer) {
    if (requireBaseline) {
      fail('找不到 apksigner', '需要 Android SDK build-tools；见 docs/build.md 的「环境准备」')
    }
    warn('找不到 apksigner，跳过签名校验')
    return null
  }
  let stdout
  try {
    ;({ stdout } = await capture(signer, ['verify', '--print-certs', apk]))
  } catch (error) {
    if (requireBaseline) {
      fail('release APK 签名校验失败（未签名或签名不完整，无法安装到真机）', String(error))
    }
    warn('debug APK 签名校验未通过')
    return null
  }
  const actual = (/SHA-256 digest:\s*([0-9a-f]{64})/i.exec(stdout)?.[1] ?? '').toLowerCase()
  if (!actual) {
    if (requireBaseline) {
      fail('apksigner 没有输出证书 SHA-256 指纹', stdout)
    }
    return null
  }
  const expected = expectedCertSha256()
  if (requireBaseline && expected && actual !== expected) {
    fail(
      '签名证书与发布基线不一致 —— 这个包发出去，老用户会无法覆盖安装',
      [
        `期望：${expected}`,
        `实际：${actual}`,
        '',
        '说明 keystore 被换过，或构建用了别的 keystore。请从未机/离线备份恢复',
        '不要通过改 android/release-cert.sha256 来「修复」—— 那等于把已安装用户全部锁死。',
        '确需换签名时按 docs/build.md §4 的流程处理（老用户必须卸载重装）。',
      ].join('\n')
    )
  }
  info(`证书 SHA-256：${actual}`)
  info(`证书 DN：${(/Signer #1 certificate DN:\s*(.+)/.exec(stdout)?.[1] ?? '').trim()}`)
  return actual
}

const main = async () => {
  const buildType = isRelease ? 'Release' : 'Debug'
  step(`构建 ${buildType} APK`)

  checkEnv()

  // 原生源码的唯一真源在 native/，构建前必须先同步，否则会拿旧 Java 编译
  await run(process.execPath, [join(paths.scripts, 'sync-native.mjs')], { cwd: paths.root })

  const tasks = isRelease ? ':app:assembleRelease' : ':app:assembleDebug'
  await run(gradlew(), [tasks, '--no-daemon', ...versionArgs()], { cwd: paths.android })

  // gradle 会把产物放在 app/build/outputs/apk/<type>/
  const outputDir = join(paths.android, 'app', 'build', 'outputs', 'apk', buildType.toLowerCase())
  if (!existsSync(outputDir)) {
    fail(`${buildType} 产物目录不存在：${outputDir}`, 'Gradle 可能没真正执行 assemble 任务，检查上面日志')
  }
  const apks = readdirSync(outputDir).filter((name) => name.endsWith('.apk'))
  if (apks.length === 0) {
    fail('没有产出 APK', `目录里只有：${readdirSync(outputDir).join(', ')}`)
  }

  step('归档产物到 dist-apk/')
  ensureDir(paths.outApk)
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const version = pkgVersion()
  for (const name of apks) {
    const from = join(outputDir, name)
    // 目标名带版本与架构，方便同时保留多个版本、也方便发出去时一眼看到版本
    const target = join(paths.outApk, `deep-chat-${version}-${arch}-${buildType.toLowerCase()}.apk`)
    copyFileSync(from, target)
    const size = statSync(target).size
    info(`${target}`)
    info(`  ${(size / 1024 / 1024).toFixed(2)} MB`)
  }

  step('签名校验')
  const built = join(paths.outApk, `deep-chat-${version}-${arch}-${buildType.toLowerCase()}.apk`)
  const cert = await verifySignature(built, { requireBaseline: isRelease })
  if (!isRelease) {
    warn('debug 包仅供本机验证；分发给他人请用 pnpm android:release')
    warn('（debug 与 release 使用同一把发布密钥，因此可以互相覆盖安装）')
  }

  step('完成')
  info(`产物目录：${paths.outApk}`)

  // 每次构建都把这些「装到手机上才看得见」的标识打出来。
  // 起因：0.1.1 连续出过好几个包，版本号、文件名、体积都一样，
  // 分不清手机上装的是哪一次 —— 用户以为没更新，其实装了旧包。
  info('这一版的身份（装好后在「设置 → 关于」和 APK 详情里核对）：')
  info(`  版本名   ${version}`)
  info(`  versionCode 见 aapt2 dump badging`)
  if (cert) {
    info(`  签名 SHA-256  ${cert.toUpperCase()}`)
  }
  info(`  APK SHA-256  ${createHash('sha256').update(readFileSync(built)).digest('hex').toUpperCase()}`)

  if (isRelease) {
    info('签名从 0.2.0 起固定为 android/release-cert.sha256 记录的证书。')
    info('若手机上装的是 0.1.x（早期密钥已丢失），仍需卸载一次；0.2.x 之间可直接覆盖安装。')
  }

  info('安装到已连接的设备：adb install -r <apk 路径>')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
