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
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { capture, fail, info, paths, pkgVersion, step, warn } from './lib/env.mjs'
import { MOBILE_PATCHES, loadManifests, sha256Text } from './lib/mobile-overrides.mjs'

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

  // 产品名必须是 Deep Chat：这是正式客户端，不是上游的 API 演示程序。
  // 上游文案带 demo 字样，补丁一失效就会原样漏到用户界面上。
  record(
    html.includes('<title>Deep Chat</title>'),
    'index.html 标题是 Deep Chat',
    'prepare-web.mjs 的 page title 补丁可能失效了'
  )
  record(
    !/API\s*使用\s*demo|API usage demo/i.test(html),
    'index.html 不残留 demo 字样'
  )

  const mainJs = findMainJs(paths.dist)
  record(mainJs !== null, 'main bundle 存在')
  if (!mainJs) {
    return
  }
  const js = readFileSync(mainJs, 'utf8')

  // 壳的四个能力都要真的打进 bundle
  record(js.includes('__DEEP_CHAT_KEYSTORE__'), '加密 Key 桥已打包')
  record(js.includes('__DEEP_CHAT_IMPORT__'), '合并导入桥已打包')
  record(js.includes('shell-mic-blocked'), '麦克风引导已打包')
  record(js.includes('hasPendingFile'), '外部打开 ZIP 处理已打包')
  record(js.includes('__DEEP_CHAT_ONBOARDING__'), '首启引导已打包')

  // 侧边栏显示的应用名来自 i18n 的 appName，被打进 main bundle。
  // 查不到字符串说明 rebrand 补丁失效（会退回「API 使用 demo」）。
  record(js.includes('Deep Chat'), 'bundle 内含产品名 Deep Chat')
  record(
    !/API\s*使用\s*demo|API usage demo/.test(js),
    'bundle 内不残留 demo 文案'
  )

  const mainCss = findMainCss(paths.dist)
  record(mainCss !== null, 'main css 存在')
  if (mainCss) {
    const css = readFileSync(mainCss, 'utf8')
    record(css.includes('--safe-area-inset-top'), '安全区 CSS 已打包')
    record(css.includes('--shell-inset-top'), '安全区变量已注入')
    // 移动端覆盖层的设计 token：丢了说明 main.tsx 的 mobile.css 引入补丁失效
    record(css.includes('--m-brand'), '移动端设计 token 已打包（--m-brand）')
    record(css.includes('--m-drawer-width'), '移动端抽屉宽度 token 已打包')
  }

  // 移动端官方文案：证明 i18n 补丁与移动端欢迎页真的进了 bundle
  record(
    js.includes('欢迎回来，想从哪里开始？'),
    '移动端欢迎语已打包（mobile strings 补丁生效）'
  )
  record(
    /(拍照|相册)/.test(js),
    '附件面板文案已打包（拍照 / 相册）'
  )

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
    record(false, 'dist-apk/ 存在（先运行 pnpm android:release）', paths.outApk)
    return
  }
  const apks = readdirSync(paths.outApk).filter((name) => name.endsWith('.apk'))
  if (apks.length === 0) {
    record(false, 'dist-apk/ 里有 APK（先运行 pnpm android:release）', paths.outApk)
    return
  }
  // 优先检查「本次版本」的 release（对外产物），其次任意 release，最后 debug。
  // 为什么要按版本号挑：dist-apk/ 里常留着上一版的 release，readdir 顺序又按文件名，
  // 只写「第一个含 release 的」会挑中旧包，于是「版本名与 package.json 一致」直接失败
  //（0.2.7 发布时就踩到过：新包已经构建好了，verify 却在检查 0.2.6）。
  const version = pkgVersion()
  const apk =
    apks.find((name) => name.includes(`-${version}-`) && name.includes('release')) ??
    apks.find((name) => name.includes('release')) ??
    apks[0]
  const apkPath = join(paths.outApk, apk)
  info(`检查对象：${apk}（${(statSync(apkPath).size / 1024 / 1024).toFixed(2)} MB）`)

  // 产物文件名要和产品名一致：包里叫 Deep Chat，文件却叫 chat-demo-*.apk
  // 会让人分不清哪个是交付物（也确实同时存在过两个名字的包，误装过）。
  record(
    !apk.startsWith('chat-demo-'),
    '产物文件名不再用 chat-demo 前缀',
    apk
  )

  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  // 这里必须是**失败**而不是跳过。曾经是 warn + return，于是没设 ANDROID_HOME 时
  // 16 项 APK 检查（含「版本名与 package.json 一致」）全部静默不执行，
  // 脚本照样打印「全部通过」—— 过期 APK 因此能一路绿灯。跳过=假装验过。
  if (!sdk) {
    record(
      false,
      'ANDROID_HOME 已设置（否则 APK 检查会被整段跳过）',
      '未设置 ANDROID_HOME / ANDROID_SDK_ROOT'
    )
    return
  }
  const buildTools = join(sdk, 'build-tools')
  if (!existsSync(buildTools)) {
    record(false, '找到 build-tools（否则 APK 检查会被跳过）', buildTools)
    return
  }
  const buildToolsVersion = readdirSync(buildTools).sort().reverse()[0]
  const aapt2 = join(buildTools, buildToolsVersion, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')

  let badging = ''
  try {
    const { stdout } = await capture(aapt2, ['dump', 'badging', apkPath])
    badging = stdout
  } catch (error) {
    record(false, 'aapt2 dump badging 可执行', String(error).slice(0, 200))
    return
  }

  // 应用身份：包名与显示名。改名后最容易漏的是这里 ——
  // applicationId 改了但 label 还是旧的，装到手机上图标下面写着别的名字。
  record(
    /package: name='com\.deepchat\.app'/.test(badging),
    '包名是 com.deepchat.app',
    (badging.match(/package: name='([^']+)'/) ?? [])[1]
  )
  record(
    /application-label:'Deep Chat'/.test(badging),
    "应用显示名是 'Deep Chat'",
    (badging.match(/application-label:'([^']*)'/) ?? [])[1]
  )

  // APK 里的版本必须等于 package.json 的版本。
  // 起因：0.1.1 连续出过好几个包，版本号/文件名/体积都一样，用户以为没更新
  // （实际是装了旧包），而所有测试都看源码、谁也发现不了。这条把
  // 「dist-apk 里的包到底是不是这次源码构建出来的」变成可断言的。
  const expectedVersion = pkgVersion()
  const builtVersion = (badging.match(/versionName='([^']*)'/) ?? [])[1]
  record(
    builtVersion === expectedVersion,
    'APK 版本名与 package.json 一致（包是这次构建出来的）',
    { apk: builtVersion, pkg: expectedVersion }
  )

  // versionCode 必须随之变大，否则 Android 不允许覆盖安装。
  const builtCode = Number.parseInt((badging.match(/versionCode='(\d+)'/) ?? [])[1] ?? '0', 10)
  const [vMajor = 0, vMinor = 0, vPatch = 0] = expectedVersion
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const expectedCode = vMajor * 10000 + vMinor * 100 + vPatch
  record(
    builtCode === expectedCode,
    'versionCode 与版本名匹配（升版本才能覆盖安装）',
    { apk: builtCode, expected: expectedCode }
  )

  // 启动图标：必须真的打进包（自适应图标用 mipmap-anydpi-v26 的 XML 描述）
  let resources = ''
  try {
    const { stdout } = await capture(aapt2, ['dump', 'resources', apkPath])
    resources = stdout
  } catch {
    // 下面按缺失处理
  }
  for (const name of ['mipmap/ic_launcher', 'mipmap/ic_launcher_foreground', 'mipmap/ic_launcher_round']) {
    record(resources.includes(name), `图标资源 ${name} 已打包`)
  }
  record(
    resources.includes('color/ic_launcher_background'),
    '自适应图标背景色已打包'
  )

  // 权限白名单：多一个都要报出来让人确认
  const permissions = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1])
  const allowed = new Set([
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
  ])
  const unexpected = permissions.filter(
    (name) => !allowed.has(name) && !name.startsWith('com.deepchat.app.')
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

  // 签名：release 必须有，而且证书必须与仓库里记录的发布指纹一致。
  // 「已签名」不等于「能覆盖安装」：换了一把 keystore 照样是有效签名，
  // 但老用户会 INSTALL_FAILED_UPDATE_INCOMPATIBLE —— 所以要比对指纹。
  if (apk.includes('release')) {
    const apksigner = join(buildTools, buildToolsVersion, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
    const certFile = join(paths.android, 'release-cert.sha256')
    const expected = existsSync(certFile)
      ? readFileSync(certFile, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^[0-9a-f]{64}$/i.test(line))
          ?.toLowerCase()
      : undefined
    record(Boolean(expected), '发布证书指纹基线存在（android/release-cert.sha256）')
    try {
      const { stdout } = await capture(apksigner, ['verify', '--print-certs', apkPath])
      record(true, 'release APK 已签名')
      const actual = (/SHA-256 digest:\s*([0-9a-f]{64})/i.exec(stdout)?.[1] ?? '').toLowerCase()
      record(
        expected !== undefined && actual === expected,
        'release APK 证书与发布基线一致（可覆盖安装）',
        { apk: actual, expected }
      )
    } catch {
      record(false, 'release APK 已签名', '未签名包无法安装到真机，见 docs/build.md §4')
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
    const hasKeystoreBranch = text.includes('__DEEP_CHAT_KEYSTORE__')
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

  // 发布签名：私钥只在本机（构建需要），**绝不能进版本库**。
  // 仓库只保存证书指纹（公开信息），用来证明「签名没被换掉」。
  for (const file of ['deep-chat.keystore', 'keystore.properties', 'release-cert.sha256']) {
    record(existsSync(join(paths.android, file)), `android/${file} 存在（本机构建签名可用）`)
  }
  let trackedSecrets = []
  try {
    trackedSecrets = execFileSync('git', ['ls-files', 'android/deep-chat.keystore', 'android/keystore.properties'], {
      cwd: paths.root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    // 不在 git 工作区时无法判断，交给人工；不因此让整轮自检失败
  }
  record(
    trackedSecrets.length === 0,
    '发布私钥没有被 git 跟踪（公开仓库的前提）',
    trackedSecrets.join(', ') || undefined
  )
  // 兜底：历史里也不能有私钥。公开前若命中，用 git filter-repo 或重建仓库清理。
  let historyHits = []
  try {
    historyHits = execFileSync(
      'git',
      ['log', '--all', '--name-only', '--pretty=format:', '--', 'android/deep-chat.keystore', 'android/keystore.properties'],
      { cwd: paths.root, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    // 同上
  }
  record(
    new Set(historyHits).size === 0,
    'git 历史里没有发布私钥（可安全公开仓库）',
    [...new Set(historyHits)].join(', ') || undefined
  )

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
    capConfig.includes(`DeepChatMobile/${pkg.version}`),
    'capconfig 的 UA 标记与 package.json 版本一致',
    `期望 DeepChatMobile/${pkg.version}`
  )
}

const checkPatches = () => {
  step('D. 补丁完整性')

  // 注入的壳文件必须都存在（prepare 会覆盖写，缺文件会直接报错，这里先自查）
  const shellDir = join(paths.web, 'src', 'shell')
  if (existsSync(shellDir)) {
    const files = readdirSync(shellDir)
    for (const expected of [
      'shell.ts',
      'bridge.ts',
      'keystore-bridge.ts',
      'import-bridge.ts',
      'native-backup.ts',
      'export-bridge.ts',
      'export-ui.ts',
      'onboarding.ts',
      'safe-area.css',
    ]) {
      record(files.includes(expected), `web/src/shell/${expected} 已注入`)
    }
  } else {
    record(false, 'web/src/shell 已注入', '先运行 pnpm web:prepare')
  }

  // 移动端覆盖层：注入文件必须都在（prepare 会整体重建 web/src/mobile）
  const mobileDir = join(paths.web, 'src', 'mobile')
  const mobileFiles = [
    'common/mobile.css',
    'common/icons.tsx',
    'common/logo.tsx',
    'chatinput/MobileChatInput.tsx',
    'topbar/MobileTopBar.tsx',
    'drawer/MobileDrawer.tsx',
    'balance/useBalance.ts',
    'cost/pricing.ts',
    'cost/pricing-source.ts',
    'cost/usePricing.ts',
    'cost/TurnCostButton.tsx',
    'cost/TurnCostSheet.tsx',
    'cost/TurnCostSheet.module.css',
  ]
  if (existsSync(mobileDir)) {
    for (const file of mobileFiles) {
      record(existsSync(join(mobileDir, file)), `web/src/mobile/${file} 已注入`)
    }
  } else {
    record(false, 'web/src/mobile 已注入', '先运行 pnpm web:prepare')
  }

  // fork 完整性：web/src 里的文件必须等于 web-patches/mobile/overrides 里的 fork。
  // 有人手改了 web/、或 prepare 后又被覆盖，会在这里暴露。
  const manifests = loadManifests()
  if (manifests.length === 0) {
    record(true, '没有移动端 fork manifest（跳过）')
  }
  for (const { name, overrides } of manifests) {
    for (const entry of overrides) {
      const fork = join(MOBILE_PATCHES, entry.from)
      const target = join(paths.web, entry.to)
      if (!existsSync(fork) || !existsSync(target)) {
        record(false, `${name}: fork 与目标都存在`, `${entry.to}`)
        continue
      }
      record(
        sha256Text(readFileSync(target, 'utf8')) === sha256Text(readFileSync(fork, 'utf8')),
        `${name}: ${entry.to} 与 fork 一致`
      )
    }
  }

  // 每个补丁点的标记都还在 —— 有人手工改回去会立刻暴露
  const markers = [
    ['src/i18n/zh.ts', 'mobile-shell: product name zh'],
    ['src/i18n/en.ts', 'mobile-shell: product name en'],
    ['src/index.html', 'mobile-shell: page title'],
    ['src/index.html', 'mobile-shell: viewport-fit'],
    ['src/main.tsx', 'mobile-shell: bootstrap'],
    ['src/main.tsx', 'mobile-shell: await shell'],
    ['src/components/settings/settingsDialogState.ts', 'mobile-shell: onboarding owns key prompt'],
    ['src/components/settings/SettingsDialog.tsx', 'mobile-shell: device export import'],
    ['src/components/settings/SettingsDialog.tsx', 'mobile-shell: device export body'],
    ['src/components/settings/SettingsDialog.tsx', 'mobile-shell: import backup pref'],
    ['src/components/settings/SettingsDialog.tsx', 'mobile-shell: import confirm body'],
    ['src/components/settings/SettingsDialog.tsx', 'mobile-shell: import cell description'],
    ['src/services/chat/store.ts', 'mobile-shell: replace history commit'],
    ['src/services/chat/store.ts', 'mobile-shell: replace history commit call'],
    ['src/shell/import-ui.ts', 'shell-import-env'],
    ['src/shell/import-ui.ts', '写暂存'],
    ['src/shell/import-bridge.ts', 'inMemoryArchives'],
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
    ['src/services/chat/history/zipReader.ts', 'mobile-shell: fast zip reader'],
    ['src/i18n/zh.ts', 'mobile-ui: mobile strings zh'],
    ['src/i18n/en.ts', 'mobile-ui: mobile strings en'],
    ['src/main.tsx', 'mobile-ui: mobile css'],
    ['src/components/messages/AssistantMessage.tsx', 'mobile-ui: turn cost entry jsx'],
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
