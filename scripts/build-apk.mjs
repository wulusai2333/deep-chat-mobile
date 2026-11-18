/**
 * 构建 APK（debug / release）。
 *
 * 为什么用脚本而不是让用户敲 gradlew：
 *   1. Windows / macOS / Linux 的 gradlew 调用方式不同（gradlew.bat vs ./gradlew）；
 *   2. JAVA_HOME 与 ANDROID_HOME 经常没设，报错信息对非 Android 开发者毫无帮助；
 *   3. 产物要从 build/outputs 拷到 dist-apk/，并改成带版本号的名字。
 * 这三件事包在这里，`pnpm android:release` 就是完整的「从源码到可安装文件」。
 */

import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { capture, ensureDir, fail, info, paths, pkgVersion, run, step, warn } from './lib/env.mjs'

const args = new Set(process.argv.slice(2))
const isRelease = args.has('--release')

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
 * versionCode 用 semver 的三段拼出来：0.1.1 → 101，单调递增且够用很久。
 */
const versionArgs = () => {
  const version = pkgVersion()
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const code = major * 10000 + minor * 100 + patch
  return [
    `-PchatdemoVersionName=${version}`,
    `-PchatdemoVersionCode=${code}`,
  ]
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
  for (const name of apks) {
    const from = join(outputDir, name)
    // 目标名带版本与架构，方便同时保留多个版本、也方便发出去时一眼看到版本
    const version = pkgVersion()
    const target = join(paths.outApk, `chat-demo-${version}-${arch}-${buildType.toLowerCase()}.apk`)
    copyFileSync(from, target)
    const size = statSync(target).size
    info(`${target}`)
    info(`  ${(size / 1024 / 1024).toFixed(2)} MB`)
  }

  if (isRelease) {
    // 确认签名状态：未签名包不能装到真机，这个检查能省掉一次「装不上」的排查
    const apk = join(paths.outApk, `chat-demo-${pkgVersion()}-${arch}-release.apk`)
    try {
      const { stdout } = await capture(
        join(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT, 'build-tools', '36.0.0', 'apksigner.bat'),
        ['verify', '--print-certs', apk]
      )
      info(`签名校验通过：${stdout.trim().split('\n')[0]}`)
    } catch {
      warn('这个 release APK 没有有效签名，无法安装到真机')
      warn('先生成 keystore：pnpm keystore（见 docs/build.md）')
    }
  } else {
    warn('debug 包仅供本机验证；分发给他人请用 pnpm android:release')
  }

  step('完成')
  info(`产物目录：${paths.outApk}`)
  info('安装到已连接的设备：adb install -r <apk 路径>')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
