/**
 * 把上游 chat-demo 的指定提交 vendor 到 web/，并施加本项目的补丁。
 *
 * 为什么用 git clone 而不是复制文件：
 * 上游会持续更新，补丁必须能「重放」到新版本上。保留完整的 git 历史后，
 * 升级只需改 PINNED_COMMIT，然后重跑本脚本，冲突点会明确报出来。
 *
 * 三种补丁形态，都在这里集中声明：
 * 1. injected  —— 本项目新增的文件（web-patches/* → web/src/shell/*），永远覆盖写。
 * 2. append    —— 在上游文件中插入一段带标记的代码，标记已存在则跳过（幂等）。
 * 3. replace   —— 精确字符串替换，找不到原文就报错（上游改了实现，必须人来看）。
 */

import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  PINNED_COMMIT,
  UPSTREAM_REPO,
  ensureDir,
  fail,
  info,
  mustExist,
  paths,
  run,
  step,
} from './lib/env.mjs'

const args = new Set(process.argv.slice(2))
const shouldInstall = args.has('--install')

/** 上游 git 状态自检：有没有被手工改过、是不是钉住的提交 */
const upstreamCommit = async () => {
  const { capture } = await import('./lib/env.mjs')
  const { stdout } = await capture('git', ['rev-parse', 'HEAD'], { cwd: paths.web })
  return stdout.trim()
}

const ensureVendored = async () => {
  if (existsSync(join(paths.web, '.git'))) {
    return
  }
  if (existsSync(paths.web)) {
    // 非 git 的残留目录会让补丁状态不可知，直接提示而不是静默覆盖
    fail(`web/ 存在但不是 git 仓库，无法确定上游版本`, `删除 ${paths.web} 后重跑：pnpm web:install`)
  }
  step(`clone 上游 chat-demo @ ${PINNED_COMMIT.slice(0, 8)}`)
  await run('git', ['clone', '--filter=blob:none', UPSTREAM_REPO, paths.web])
  await run('git', ['checkout', '--detach', PINNED_COMMIT], { cwd: paths.web })
}

const ensureDependencies = async () => {
  const marker = join(paths.web, 'node_modules', '.pnpm')
  if (existsSync(marker) && !shouldInstall) {
    info('web/node_modules 已就绪（要强制重装用 pnpm web:install）')
    return
  }
  step('安装上游依赖（pnpm install --frozen-lockfile）')
  await run('pnpm', ['install', '--frozen-lockfile'], { cwd: paths.web })
}

/**
 * 本项目注入的文件：源码在 web-patches/，构建前同步进 web/src/shell/。
 * 放在 web/src 里是为了让 rspack 按项目自己的 tsconfig / 路径别名解析，
 * 同时 web/ 目录本身可以随时重新 clone，不承载任何我们的代码。
 */
const injectShell = () => {
  const target = join(paths.web, 'src', 'shell')
  rmSync(target, { recursive: true, force: true })
  ensureDir(target)
  const sources = [
    'safe-area.css',
    'bridge.ts',
    'storage-utils.ts',
    'ui.ts',
    'keystore-bridge.ts',
    'import-bridge.ts',
    'import-ui.ts',
    'mic-guide.ts',
    'onboarding.ts',
    'shell.ts',
  ]
  for (const name of sources) {
    const source = join(paths.webPatches, name)
    mustExist(source, 'web-patches/ 缺少文件，检查是否完整检出')
    cpSync(source, join(target, name))
  }
  info(`注入 ${sources.length} 个壳文件 → web/src/shell/`)
}

/**
 * 读文件并把行尾统一成 LF，写回时还原原来的风格。
 *
 * 为什么必须这么做：上游仓库在 Windows 上检出后是 CRLF，而本脚本里的锚点
 * 都是多行模板字符串（用 \n 写的）。直接 `text.includes(anchor)` 会因为 \r
 * 而匹配失败 —— 报错信息看起来像「上游改了实现」，实际只是换行符不同。
 * 统一成 LF 后匹配，写回时还原，保证上游文件的既有风格不被我们改动。
 */
const readSource = (full) => {
  const text = readFileSync(full, 'utf8')
  const crlf = text.includes('\r\n')
  return {
    text: text.replace(/\r\n/g, '\n'),
    restore: (next) => (crlf ? next.replace(/\n/g, '\r\n') : next),
  }
}

/** 在文件中插入带标记的代码段；标记已存在则跳过 */
const insertOnce = (file, marker, anchor, snippet, position = 'after') => {
  const full = join(paths.web, file)
  mustExist(full, '上游文件缺失，可能改了目录结构')
  const { text, restore } = readSource(full)
  if (text.includes(marker)) {
    info(`${file}: 补丁已存在，跳过`)
    return
  }
  if (!text.includes(anchor)) {
    fail(
      `${file}: 找不到锚点，无法打补丁`,
      [
        '上游实现已变更，需要人工确认新位置后更新 scripts/prepare-web.mjs。',
        `期望锚点：${JSON.stringify(anchor.slice(0, 80))}`,
      ].join('\n')
    )
  }
  const next =
    position === 'after'
      ? text.replace(anchor, `${anchor}${snippet}`)
      : text.replace(anchor, `${snippet}${anchor}`)
  if (next === text) {
    fail(`${file}: 插入补丁后内容未变化，锚点不唯一或被转义`)
  }
  writeFileSync(full, restore(next))
  info(`${file}: 已插入补丁`)
}

/** 精确替换；原文找不到则报错 */
const replaceOnce = (file, marker, from, to) => {
  const full = join(paths.web, file)
  mustExist(full, '上游文件缺失，可能改了目录结构')
  const { text, restore } = readSource(full)
  if (text.includes(marker)) {
    info(`${file}: 补丁已存在，跳过`)
    return
  }
  if (!text.includes(from)) {
    fail(
      `${file}: 找不到待替换原文，无法打补丁`,
      ['上游实现已变更，需要人工确认后更新 scripts/prepare-web.mjs。', `期望原文：${from.slice(0, 120)}`].join(
        '\n'
      )
    )
  }
  writeFileSync(full, restore(text.replace(from, to)))
  info(`${file}: 已替换`)
}

/**
 * 补丁清单。每处都带 MARK 标记，方便：
 * - 判断是否已打过（幂等）；
 * - 上游升级时 git diff 一眼看出我们改了什么；
 * - 用 `rg 'mobile-shell:'` 定位全部改动点。
 */
const applyPatches = () => {
  // ── 补丁 0a：把「demo」字样换成正式产品名 ─────────────────────────────────
  // 上游是 DeepSeek 官方放出的 API 演示程序，界面里写着「API 使用 demo」。
  // 本壳是一个正常使用的客户端，不是演示，所以侧边栏与页面标题都改成 Deep Chat。
  // 只改「名称」这一处文案：其它界面文字一律不动（规格要求 UI 与桌面版一致）。
  replaceOnce(
    'src/i18n/zh.ts',
    'mobile-shell: product name zh',
    "appName: 'API 使用 demo',",
    "// mobile-shell: product name zh —— 本壳是正式客户端，不是演示程序\n  appName: 'Deep Chat',"
  )
  replaceOnce(
    'src/i18n/en.ts',
    'mobile-shell: product name en',
    "appName: 'API usage demo',",
    "// mobile-shell: product name en —— 见 zh.ts 同名补丁\n  appName: 'Deep Chat',"
  )

  // ── 补丁 0b：页面标题（任务切换器 / 浏览器标签里显示的名字）─────────────
  // 注意替换文本里必须带 MARK 标记：replaceOnce 靠它判断「是否已打过」。
  // 标记写漏了，第二次运行就会因为找不到原文而报错退出。
  replaceOnce(
    'src/index.html',
    'mobile-shell: page title',
    '<title>API 使用 demo</title>',
    [
      '<!-- mobile-shell: page title —— 正式产品名，不是演示程序 -->',
      '    <title>Deep Chat</title>',
    ].join('\n    ')
  )

  // ── 补丁 1：viewport meta 加 viewport-fit=cover ───────────────────────────
  // 没有 viewport-fit=cover 时 env(safe-area-inset-*) 恒为 0，安全区补丁失效。
  replaceOnce(
    'src/index.html',
    'mobile-shell: viewport-fit',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    [
      '<!-- mobile-shell: viewport-fit=cover 让 env(safe-area-inset-*) 生效，',
      '     配合 web-patches/safe-area.css 避让刘海与手势条。上游无此行。 -->',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />',
    ].join('\n    ')
  )

  // ── 补丁 2a：入口挂载壳 ────────────────────────────────────────────────
  // 壳负责安全区样式、加密 Key 桥、ZIP 导入桥、首启引导。
  // 必须最先执行：安全区样式要在首屏渲染前生效，避免顶栏跳动。
  replaceOnce(
    'src/main.tsx',
    'mobile-shell: bootstrap',
    "import { createRoot } from 'react-dom/client'",
    [
      "import { createRoot } from 'react-dom/client'",
      '// mobile-shell: bootstrap —— 原生壳入口（安全区 / 加密 Key / ZIP 导入 / 首启引导）。',
      '// 放在所有渲染之前，保证安全区样式先于首屏生效；不是原生壳时整段是空操作。',
      "import { shellReady } from './shell/shell.js'",
    ].join('\n')
  )

  // ── 补丁 2b：等壳就绪再 render ──────────────────────────────────────────
  // 为什么必须 await：上游 App.tsx 挂载时同步调 ensureApiKey()，没 Key 就弹设置窗。
  // 而加密存储只能异步读（一次原生桥往返）。先渲染再读 Key 的结果是
  // 每次启动都闪一下设置窗 —— 实测行为，不是理论风险。
  // 浏览器 / PWA 下 shellReady 已 resolve，只多一个微任务，行为与上游一致。
  replaceOnce(
    'src/main.tsx',
    'mobile-shell: await shell',
    "createRoot(document.getElementById('root') as HTMLElement).render(<App />)",
    [
      '// mobile-shell: await shell —— 原生壳要先把加密存储里的 Key 读进内存，',
      '// 否则 App 挂载时的 ensureApiKey() 会因为「暂时没 Key」而误弹设置窗。',
      '// 浏览器下 shellReady 已 resolve，等价于上游的直接 render。',
      "void shellReady.then(() => {",
      "  createRoot(document.getElementById('root') as HTMLElement).render(<App />)",
      '})',
    ].join('\n')
  )

  // ── 补丁 2c：首启引导期间让上游别抢着弹设置窗 ────────────────────────────
  // 壳层在检测到「设备上还没有 Key」时置 __DEEP_CHAT_ONBOARDING__，
  // 由引导页负责收集 Key。若不拦，用户会同时看到引导页和设置弹窗两个入口。
  replaceOnce(
    'src/components/settings/settingsDialogState.ts',
    'mobile-shell: onboarding owns key prompt',
    `export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}`,
    `export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  // mobile-shell: onboarding owns key prompt —— 原生壳首启时由引导页收集 Key，
  // 这里不要再弹设置窗，否则两个获取 Key 的入口同时出现。
  // 引导页被跳过或失败时会把该标志复位，回落到上游行为。
  if (typeof window !== 'undefined' && window.__DEEP_CHAT_ONBOARDING__) {
    return false
  }
  openSettings('data')
  return false
}`
  )

  // ── 补丁 3：API Key 改由原生加密存储托管 ────────────────────────────────
  // 上游把 Key 明文写 localStorage 与读 localStorage。原生壳下必须改成：
  // 读 → 优先 window.__RUNTIME_KEY__（原生启动时注入的内存变量）；
  // 写 → 交给 Keystore 插件加密保存，且绝不写回 localStorage。
  // 选 settings.ts 而不是 client.ts 的原因：client.ts 的 apiKey 全是入参
  // （verifyApiKey/uploadFile/streamMessage 都由调用方传），真正的读写点只有这里；
  // 所有调用方都通过 useSettings.getState().apiKey 取值，改一处即全覆盖。
  insertOnce(
    'src/services/settings.ts',
    'mobile-shell: secure api key',
    "import { normalizeLocation, type UserLocation } from './location.js'",
    `

// ── mobile-shell: secure api key ────────────────────────────────────────────
// 原生壳（APK）里的 Key 不允许落明文。读取顺序：
//   1. window.__RUNTIME_KEY__ —— 原生在页面脚本执行前注入，只存在于内存；
//   2. localStorage —— 仅桌面浏览器 / PWA 回退路径会走到这里。
// 写入：有 Keystore 桥时交给原生加密保存；没有时（浏览器）才走 localStorage。
// 运行时从原生取得的 Key 绝不写回 localStorage，否则等于明文落地。
type ShellKeyStore = {
  get(): Promise<string | null>
  set(value: string | null): Promise<void>
  clear(): Promise<void>
}
declare global {
  interface Window {
    __RUNTIME_KEY__?: string | null
    __DEEP_CHAT_KEYSTORE__?: ShellKeyStore
    /** 首启引导是否正在接管 Key 提示；上游 ensureApiKey 会读它 */
    __DEEP_CHAT_ONBOARDING__?: boolean
  }
}

const injectedApiKey = (): string | null => {
  const value = typeof window === 'undefined' ? null : window.__RUNTIME_KEY__
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 原生在页面加载后才注入时（冷启动竞态兜底），同步到 store */
if (typeof window !== 'undefined') {
  window.addEventListener('deep-chat:runtime-key', () => {
    const value = injectedApiKey()
    if (value !== useSettings.getState().apiKey) {
      useSettings.setState({ apiKey: value })
    }
  })
}
// ── mobile-shell: secure api key end ───────────────────────────────────────`
  )

  replaceOnce(
    'src/services/settings.ts',
    'mobile-shell: api key initial',
    '  apiKey: read(KEYS.apiKey),',
    '  // mobile-shell: api key initial —— 原生注入的内存 Key 优先于 localStorage\n  apiKey: injectedApiKey() ?? read(KEYS.apiKey),'
  )

  replaceOnce(
    'src/services/settings.ts',
    'mobile-shell: api key setter',
    `export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}`,
    `export const setApiKey = (apiKey: string | null) => {
  // mobile-shell: api key setter —— 有加密存储桥时只写原生，绝不写 localStorage
  const keystore = typeof window === 'undefined' ? undefined : window.__DEEP_CHAT_KEYSTORE__
  if (keystore) {
    window.__RUNTIME_KEY__ = apiKey
    void keystore.set(apiKey).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[mobile-shell] failed to persist api key', error)
    })
    useSettings.setState({ apiKey })
    return
  }
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}`
  )

  // ── 补丁 4：去掉 ES2023 数组方法，兼容旧 WebView 内核 ────────────────────
  // 鸿蒙 4.3 的 WebView 内核对 toSorted/toReversed 支持不稳定；rspack 的 swc
  // 只做语法降级、不 polyfill 内置方法，所以必须换成 toSlice+sort / slice().reverse()。
  // 语义完全等价（数组都是新建的副本）。
  replaceOnce(
    'src/services/chat/history/toLocal.ts',
    'mobile-shell: no toSorted',
    'const sorted = file.messages.toSorted((a, b) => a.id - b.id)',
    `// mobile-shell: no toSorted —— toSorted 是 ES2023，鸿蒙 4.3 的 WebView 内核支持
  // 不稳定，且 rspack 只降语法不 polyfill 内置方法。语义等价（都是新数组）。
  const sorted = file.messages.slice().sort((a, b) => a.id - b.id)`
  )

  replaceOnce(
    'src/services/chat/store.ts',
    'mobile-shell: no toReversed',
    'for (const [user] of getContextRounds(request.history).toReversed()) {',
    `// mobile-shell: no toReversed —— toReversed 是 ES2023，鸿蒙 4.3 的 WebView 内核
  // 支持不稳定，且 rspack 只降语法不 polyfill 内置方法。语义等价（都是新数组）。
  for (const [user] of getContextRounds(request.history).slice().reverse()) {`
  )

  // ── 补丁 5：db.ts 增加合并导入所需的三个暂存辅助函数 ──────────────────────
  // 上游 commitStaging 是「清空正式表 → 从暂存搬入」，暂存里必须是完整目标状态。
  // 想复用它的原子性做「合并」，就得先把现有数据复制进暂存，让暂存成为并集。
  // 详见 patches/db.merge.ts 的文件头。
  insertOnce(
    'src/services/chat/db.ts',
    'mobile-shell: merge staging helpers',
    'export const addStagingSession = async (session: Session): Promise<void> => {',
    `// ── mobile-shell: merge staging helpers ────────────────────────────────────
// 合并导入需要把「现有数据 + 导入数据」的并集交给 commitStaging，
// 但上游只提供了 add 语义的 addStagingSession 和清空用的 clearStaging。
// 这里新增三个函数，全部只服务合并导入，不改变任何既有函数的行为。
// 完整说明见 patches/db.merge.ts。
export const stageCurrentHistory = async (): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['sessions', 'files', 'sessionsStaging', 'filesStaging'], 'readwrite')
  try {
    const stagingSessions = tx.objectStore('sessionsStaging')
    const stagingFiles = tx.objectStore('filesStaging')
    await stagingSessions.clear()
    await stagingFiles.clear()
    for (
      let cursor = await tx.objectStore('sessions').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      await stagingSessions.put(cursor.value)
    }
    for (
      let cursor = await tx.objectStore('files').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      await stagingFiles.put(cursor.value)
    }
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
  await tx.done
}

export const putStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).put('sessionsStaging', session)
}

export const collectStagingFileTypes = async (): Promise<Map<string, string>> => {
  const types = new Map<string, string>()
  for (const session of await (await getDB()).getAll('sessionsStaging')) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (file.mimeType) {
          types.set(file.id, file.mimeType)
        }
      }
    }
  }
  return types
}
// ── mobile-shell: merge staging helpers end ────────────────────────────────
`,
    'before'
  )

  // ── 补丁 7：录音失败时补一次原生引导 ──────────────────────────────────────
  // 上游对 NotAllowedError 只给一条「没有麦克风权限」的 toast。但有一类情况它分不出来：
  // 用户此前选了「不再询问」。此时系统不再弹框，网页永远只拿到 NotAllowedError，
  // 用户被卡在一条看不懂的提示里，不知道要去系统设置手动开。
  // 原生能读到 shouldShowRequestPermissionRationale，才分得清。
  // 这里只接管「确定被永久拒绝」这一种情况，其余失败仍走上游 toast。
  replaceOnce(
    'src/components/chatInput/useVoiceInput.ts',
    'mobile-shell: mic guidance',
    `    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }`,
    `    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        // mobile-shell: mic guidance —— 如果是「已永久拒绝」，网页侧拿不到这个信息，
        // 交给原生判断并弹「去设置」引导；其余失败照旧走上游的 toast。
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
        if (!blocked || !(await guideBlockedMic())) {
          showToast(describeRecordingError(error))
        }
      }
    }`
  )

  replaceOnce(
    'src/components/chatInput/useVoiceInput.ts',
    'mobile-shell: mic guidance import',
    "import { showToast } from '../base/toastState.js'",
    `import { showToast } from '../base/toastState.js'
// mobile-shell: mic guidance import —— 原生壳里「永久拒绝麦克风」时引导去系统设置
import { guideBlockedMic } from '../../shell/mic-guide.js'`
  )

  // ── 补丁 8：backup.ts 抽出快照导出 + 导入委派给合并桥 ────────────────────
  // 关键点：合并流程内部要调导出做备份，若调对外的 exportHistory() 会
  // 「在队列任务里 await 队列任务」而死锁。所以把实现体抽成不入队的快照版。
  // 详见 patches/backup.ts。
  replaceOnce(
    'src/services/chat/backup.ts',
    'mobile-shell: export snapshot',
    `/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(\`History session disappeared during export: \${summary.id}\`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })`,
    `// ── mobile-shell: export snapshot ──────────────────────────────────────────
// 实现体抽成不入队的函数：合并导入在队列任务内部需要一个「当前数据快照」，
// 若调对外的 exportHistory()（自身也 enqueue）会自己等自己而死锁。
// 对外行为完全不变。详见 patches/backup.ts。
export const exportHistorySnapshot = async (): Promise<{ name: string; blob: Blob }> => {
  // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
  const { sessions, sessionCache } = useChatStore.getState()
  async function* readSessions(): AsyncGenerator<Session> {
    for (const summary of sessions) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      if (!session) {
        throw new Error(\`History session disappeared during export: \${summary.id}\`)
      }
      // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
      yield { ...session, ...summary }
    }
  }
  const { exportArchive } = await import('./history/exportArchive.js')
  const now = new Date()
  const blob = await exportArchive(readSessions())
  return { name: backupFileName(now), blob }
}

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(exportHistorySnapshot)
// ── mobile-shell: export snapshot end ─────────────────────────────────────`
  )

  replaceOnce(
    'src/services/chat/backup.ts',
    'mobile-shell: merge import',
    `export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file))
  })`,
    `export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    // mobile-shell: merge import —— 原生壳里换成「合并」而不是「覆盖」，
    // 避免导入别处的备份时抹掉手机上已有的对话。桥不存在时回退到上游覆盖逻辑。
    const bridge = window.__DEEP_CHAT_IMPORT__
    if (bridge) {
      const result = await bridge.merge(file)
      return result.added + result.updated
    }
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file))
  })`
  )
}

const main = async () => {
  step('检查上游副本')
  await ensureVendored()
  const commit = await upstreamCommit()
  info(`web/ @ ${commit.slice(0, 8)}`)
  if (!commit.startsWith(PINNED_COMMIT.slice(0, 8))) {
    info(`注意：钉住的是 ${PINNED_COMMIT.slice(0, 8)}，当前是 ${commit.slice(0, 8)}（升级时需重新验证补丁）`)
  }

  ensureDir(paths.root)
  if (shouldInstall || !existsSync(join(paths.web, 'node_modules'))) {
    await ensureDependencies()
  } else {
    info('web/node_modules 已就绪（要强制重装用 pnpm web:install）')
  }

  step('注入壳文件')
  injectShell()

  step('应用上游补丁')
  applyPatches()

  step('准备完成')
  info('下一步：pnpm build:web')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
