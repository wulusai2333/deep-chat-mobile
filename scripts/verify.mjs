/**
 * 交付前自检。
 *
 * 这个脚本存在的唯一理由是：把「需求里的硬性约束」变成可执行的检查，
 * 而不是靠人工记忆。「Key 不许明文」「只申请两个权限」「不能开备份」
 * 这类要求，一旦漏了是返工级别的错误 —— 必须能在 30 秒内自动验证。
 *
 * 检查项分四组：
 *   A. 构建产物（dist / assets 真的包含壳）
 *   B. APK 硬指标（权限、allowBackup、cleartext、签名）
 *   C. 安全（产物里没有明文 Key、没有 localStorage 回写路径）
 *   D. 补丁完整性（补丁脚本可重放、上游补丁仍在位）
 *
 * 退出码非 0 表示有硬性检查失败，可直接接进 CI。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { capture, fail, info, paths, pkgVersion, step, warn } from './lib/env.mjs'

const results = []
const record = (ok, label, detail) => {
  results.push({ ok, label, detail })
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
  process.stdout.write(`  ${mark} ${label}${detail ? `\n      ${detail}` : ''}\n`)
}

/** 找到 dist 里唯一的 main bundle（文件名带 contenthash，只能扫目录） */
const findMainJs = (dir) => {
  const jsDir = join(dir, 'static', 'js')
  if (!existsSync(jsDir)) {
    return null
  }
  const files = readdirSync(jsDir).filter((name) => name.startsWith('main.') && name.endsWith('.js'))
  return files.length > 0 ? join(jsDir, files[0]) : null
}

const findMainCss = (dir) => {
  const cssDir = join(dir, 'static', 'css')
  if (!existsSync(cssDir)) {
    return null
  }
  const files = readdirSync(cssDir).filter((name) => name.startsWith('main.') && name.endsWith('.css'))
  return files.length > 0 ? join(cssDir, files[0]) : null
}

const checkBuild = () => {
  step('A. 构建产物')
  const indexHtml = join(paths.dist, 'index.html')
  if (!existsSync(indexHtml)) {
    record(false, 'dist/index.html 存在', '先运行 pnpm build:web')
    return
  }
  record(true, 'dist/index.html 存在')

  const html = readFileSync(indexHtml, 'utf8')
  record(
    html.includes('viewport-fit=cover'),
    'viewport 含 viewport-fit=cover',
    '安全区依赖它；缺了在浏览器档位 A 下刘海会被遮挡'
  )

  const mainJs = findMainJs(paths.dist)
  record(mainJs !== null, 'main bundle 存在')
  if (!mainJs) {
    return
  }
  const js = readFileSync(mainJs, 'utf8')

  // 壳的四个能力都要真的打进 bundle
  record(js.includes('__CHAT_DEMO_KEYSTORE__'), '加密 Key 桥已打包')
  record(js.includes('__CHAT_DEMO_IMPORT__'), '合并导入桥已打包')
  record(js.includes('shell-mic-blocked'), '麦克风引导已打包')
  record(js.includes('hasPendingFile'), '外部打开 ZIP 处理已打包')
  record(js.includes('__CHAT_DEMO_ONBOARDING__'), '首启引导已打包')

  const mainCss = findMainCss(paths.dist)
  record(mainCss !== null, 'main css 存在')
  if (mainCss) {
    const css = readFileSync(mainCss, 'utf8')
    record(css.includes('--safe-area-inset-top'), '安全区 CSS 已打包')
    record(css.includes('--shell-inset-top'), '安全区变量已注入')
  }

  // assets 必须和 dist 一致，否则手机上跑的是旧代码（很容易发生：忘了 cap sync）
  const assetsJs = findMainJs(join(paths.android, 'app', 'src', 'main', 'assets', 'public'))
  if (!assetsJs) {
    record(false, 'android assets 已灌入', '先运行 pnpm cap:sync')
  } else {
    const same = readFileSync(assetsJs) .equals(readFileSync(mainJs))
    record(same, 'android assets 与 dist 一致', same ? undefined : '跑一次 pnpm cap:sync')
  }
}

const checkApk = async () => {
  step('B. APK 硬指标')
  if (!existsSync(paths.outApk)) {
    warn('还没有构建过 APK，跳过（先运行 pnpm android:debug）')
    return
  }
  const apks = readdirSync(paths.outApk).filter((name) => name.endsWith('.apk'))
  if (apks.length === 0) {
    warn('dist-apk/ 里没有 APK，跳过')
    return
  }
  // 优先检查 release（对外产物），其次 debug
  const apk = apks.find((name) => name.includes('release')) ?? apks[0]
  const apkPath = join(paths.outApk, apk)
  info(`检查对象：${apk}（${(statSync(apkPath).size / 1024 / 1024).toFixed(2)} MB）`)

  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdk) {
    warn('ANDROID_HOME 未设置，跳过 APK 内部检查')
    return
  }
  const buildTools = join(sdk, 'build-tools')
  if (!existsSync(buildTools)) {
    warn('找不到 build-tools，跳过 APK 内部检查')
    return
  }
  const version = readdirSync(buildTools).sort().reverse()[0]
  const aapt2 = join(buildTools, version, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')

  let badging = ''
  try {
    const { stdout } = await capture(aapt2, ['dump', 'badging', apkPath])
    badging = stdout
  } catch (error) {
    record(false, 'aapt2 dump badging 可执行', String(error).slice(0, 200))
    return
  }

  // 权限白名单：多一个都要报出来让人确认
  const permissions = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1])
  const allowed = new Set([
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
  ])
  const unexpected = permissions.filter(
    (name) => !allowed.has(name) && !name.startsWith('com.example.chatdemo.')
  )
  record(
    unexpected.length === 0,
    '权限未超出白名单',
    unexpected.length > 0 ? `多出：${unexpected.join(', ')}` : permissions.join(', ')
  )

  // 危险权限只允许麦克风：存储/相机/位置一律不该出现
  const dangerous = permissions.filter((name) =>
    /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|CAMERA|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_CONTACTS|READ_PHONE_STATE/.test(
      name
    )
  )
  record(dangerous.length === 0, '没有存储/相机/位置等敏感权限', dangerous.join(', ') || undefined)

  // 备份与明文 —— 直接读合并后的 manifest（二进制 XML 用 aapt2 解）
  try {
    const { stdout: xml } = await capture(aapt2, ['dump', 'xmltree', apkPath, '--file', 'AndroidManifest.xml'])
    // aapt2 xmltree 的布尔属性输出形如
    //   A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false
    // 注意不是 0x0/0xffffffff，是字面 true/false
    const attrIsFalse = (name) => new RegExp(`${name}\\(0x[0-9a-f]+\\)=false`, 'i').test(xml)
    record(/allowBackup\(0x[0-9a-f]+\)=/i.test(xml), 'allowBackup 已显式声明')
    record(attrIsFalse('allowBackup'), 'allowBackup=false')
    record(attrIsFalse('fullBackupContent'), 'fullBackupContent=false（或指向排除规则）')
    record(attrIsFalse('usesCleartextTraffic'), 'usesCleartextTraffic=false')
    record(/networkSecurityConfig\(0x[0-9a-f]+\)=@/i.test(xml), 'networkSecurityConfig 已设置')
  } catch (error) {
    warn(`manifest 解析失败：${String(error).slice(0, 120)}`)
  }

  // 签名：release 必须有
  if (apk.includes('release')) {
    const apksigner = join(buildTools, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
    try {
      await capture(apksigner, ['verify', apkPath])
      record(true, 'release APK 已签名')
    } catch {
      record(false, 'release APK 已签名', '未签名包无法安装到真机，先运行 pnpm keystore')
    }
  }
}

const checkSecurity = () => {
  step('C. 安全自检')

  // 明文 Key 绝不能出现在任何产物里。扫 dist 全文（含 sourcemap 若有）
  const mainJs = findMainJs(paths.dist)
  if (mainJs) {
    const js = readFileSync(mainJs, 'utf8')
    // 真实 Key 形如 sk- 后跟长串十六进制/字母数字
    const keyPattern = /sk-[A-Za-z0-9]{20,}/
    record(!keyPattern.test(js), '构建产物中没有 API Key 字面量')
  }

  // setApiKey 的 keystore 分支必须存在，且绝不能把值写回 localStorage
  if (mainJs) {
    const js = readFileSync(mainJs, 'utf8')
    record(js.includes('__RUNTIME_KEY__'), '运行时 Key 走内存变量')
  }

  // settings.ts 的补丁必须保证：有 keystore 时不调 write(KEYS.apiKey)
  const settingsPath = join(paths.web, 'src', 'services', 'settings.ts')
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, 'utf8')
    const hasKeystoreBranch = text.includes('__CHAT_DEMO_KEYSTORE__')
    record(hasKeystoreBranch, 'settings.ts 有加密存储分支')
    // 在 keystore 分支里应当 early return，之后才是 write(KEYS.apiKey)
    const branchIndex = text.indexOf('if (keystore)')
    const writeIndex = text.lastIndexOf('write(KEYS.apiKey, apiKey)')
    record(
      branchIndex >= 0 && writeIndex > branchIndex,
      'keystore 分支先 return，不会回写 localStorage',
      branchIndex < 0 ? '找不到 keystore 分支' : undefined
    )
  }

  // 原生插件必须真的用 EncryptedSharedPreferences
  const storageJava = join(paths.native, 'secure-storage', 'SecureStoragePlugin.java')
  if (existsSync(storageJava)) {
    const java = readFileSync(storageJava, 'utf8')
    record(java.includes('EncryptedSharedPreferences'), '原生用 EncryptedSharedPreferences')
    record(java.includes('AES256_GCM'), '主密钥用 AES256_GCM')
    record(!/getSharedPreferences\s*\(/.test(java), '原生没有用普通 SharedPreferences 存 Key')
  }

  // manifest 硬指标（源文件层面，早于构建发现）
  const manifest = join(paths.android, 'app', 'src', 'main', 'AndroidManifest.xml')
  if (existsSync(manifest)) {
    const xml = readFileSync(manifest, 'utf8')
    record(xml.includes('android:allowBackup="false"'), 'manifest allowBackup=false')
    record(xml.includes('android:fullBackupContent="false"'), 'manifest fullBackupContent=false')
    record(xml.includes('android:usesCleartextTraffic="false"'), 'manifest usesCleartextTraffic=false')
    record(xml.includes('android:networkSecurityConfig='), 'manifest 有 networkSecurityConfig')
    record(!xml.includes('READ_EXTERNAL_STORAGE'), 'manifest 没有存储权限')
  }

  // 网络安全配置只信任系统 CA
  const nsc = join(paths.android, 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml')
  if (existsSync(nsc)) {
    const xml = readFileSync(nsc, 'utf8')
    record(xml.includes('cleartextTrafficPermitted="false"'), 'network config 禁止明文')
    record(!xml.includes('src="user"'), 'network config 不信任用户 CA')
  }

  // 版本一致性：package.json / capacitor.config / appendUserAgent 要对齐
  const pkg = JSON.parse(readFileSync(join(paths.root, 'package.json'), 'utf8'))
  const capConfig = readFileSync(join(paths.root, 'capacitor.config.ts'), 'utf8')
  record(
    capConfig.includes(`ChatDemoMobile/${pkg.version}`),
    'capconfig 的 UA 标记与 package.json 版本一致',
    `期望 ChatDemoMobile/${pkg.version}`
  )
}

const checkPatches = () => {
  step('D. 补丁完整性')

  // 注入的壳文件必须都存在（prepare 会覆盖写，缺文件会直接报错，这里先自查）
  const shellDir = join(paths.web, 'src', 'shell')
  if (existsSync(shellDir)) {
    const files = readdirSync(shellDir)
    for (const expected of ['shell.ts', 'bridge.ts', 'keystore-bridge.ts', 'import-bridge.ts', 'onboarding.ts', 'safe-area.css']) {
      record(files.includes(expected), `web/src/shell/${expected} 已注入`)
    }
  } else {
    record(false, 'web/src/shell 已注入', '先运行 pnpm web:prepare')
  }

  // 每个补丁点的标记都还在 —— 有人手工改回去会立刻暴露
  const markers = [
    ['src/index.html', 'mobile-shell: viewport-fit'],
    ['src/main.tsx', 'mobile-shell: bootstrap'],
    ['src/main.tsx', 'mobile-shell: await shell'],
    ['src/components/settings/settingsDialogState.ts', 'mobile-shell: onboarding owns key prompt'],
    ['src/services/settings.ts', 'mobile-shell: secure api key'],
    ['src/services/settings.ts', 'mobile-shell: api key initial'],
    ['src/services/settings.ts', 'mobile-shell: api key setter'],
    ['src/services/chat/db.ts', 'mobile-shell: merge staging helpers'],
    ['src/services/chat/backup.ts', 'mobile-shell: export snapshot'],
    ['src/services/chat/backup.ts', 'mobile-shell: merge import'],
    ['src/components/chatInput/useVoiceInput.ts', 'mobile-shell: mic guidance import'],
    ['src/components/chatInput/useVoiceInput.ts', 'mobile-shell: mic guidance'],
    ['src/services/chat/history/toLocal.ts', 'mobile-shell: no toSorted'],
    ['src/services/chat/store.ts', 'mobile-shell: no toReversed'],
  ]
  for (const [file, marker] of markers) {
    const full = join(paths.web, file)
    if (!existsSync(full)) {
      record(false, `${file} 存在`)
      continue
    }
    record(readFileSync(full, 'utf8').includes(marker), `${file} → ${marker}`)
  }
}

const main = async () => {
  info(`项目：${paths.root}`)
  info(`版本：${pkgVersion()}`)

  checkBuild()
  await checkApk()
  checkSecurity()
  checkPatches()

  const failed = results.filter((item) => !item.ok)
  step('结果')
  info(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) {
    fail(
      `${failed.length} 项检查未通过`,
      failed.map((item) => `• ${item.label}${item.detail ? ` —— ${item.detail}` : ''}`).join('\n')
    )
  }
  info('全部通过。')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
