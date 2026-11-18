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
import { applyMobileOverrides, injectMobileSources } from './lib/mobile-overrides.mjs'

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
 * 插入或更新一段带首尾标记的代码块。
 *
 * `insertOnce` 只在标记不存在时插入。补丁自身的实现需要升级时（例如本轮把
 * `collectStagingFileTypes` 从 getAll 改成游标遍历），已经打过补丁的 `web/`
 * 会被「跳过」，旧实现就永远留在那里 —— 这份 `web/` 是可再生的，但重新
 * clone 一次代价很高。所以这里用首尾标记定位旧块并整段替换：
 * 内容一致时不写盘（幂等），不一致时更新成新版本。
 */
const upsertBlock = (file, startMarker, endMarker, anchor, snippet, position = 'before') => {
  const full = join(paths.web, file)
  mustExist(full, '上游文件缺失，可能改了目录结构')
  const { text, restore } = readSource(full)
  const start = text.indexOf(startMarker)
  if (start >= 0) {
    const end = text.indexOf(endMarker, start)
    if (end < 0) {
      fail(`${file}: 补丁块缺少结束标记，无法更新`, `期望结束标记：${endMarker}`)
    }
    const current = text.slice(start, end + endMarker.length)
    const next = snippet.trimEnd()
    if (current === next) {
      info(`${file}: 补丁块已是最新，跳过`)
      return
    }
    writeFileSync(
      full,
      restore(text.slice(0, start) + next + text.slice(end + endMarker.length))
    )
    info(`${file}: 已更新补丁块`)
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
  writeFileSync(full, restore(next))
  info(`${file}: 已插入补丁块`)
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

  // ── 补丁 5：db.ts 增加合并导入所需的暂存辅助函数 ──────────────────────────
  // 上游 commitStaging 是「清空正式表 → 从暂存搬入」，暂存里必须是完整目标状态。
  // 想复用它的原子性做「合并」，就得先把现有数据复制进暂存，让暂存成为并集。
  // 详见 patches/db.merge.ts 的文件头。
  //
  // 用 upsertBlock 而不是 insertOnce：本轮把 collectStagingFileTypes 从
  // getAll 改成游标遍历、新增 putStagingSessions 批量写，补丁内容必须能在
  // 已经打过旧补丁的 web/ 上更新，否则旧实现会一直留在那里。
  const MERGE_HELPERS_START =
    '// ── mobile-shell: merge staging helpers ────────────────────────────────────'
  const MERGE_HELPERS_END =
    '// ── mobile-shell: merge staging helpers end ────────────────────────────────'
  const MERGE_HELPERS = `${MERGE_HELPERS_START}
// 合并导入需要把「现有数据 + 导入数据」的并集交给 commitStaging，
// 但上游只提供了 add 语义的 addStagingSession 和清空用的 clearStaging。
// 这里新增辅助函数，全部只服务合并导入，不改变任何既有函数的行为。
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

/**
 * 批量写入暂存会话：一个批次一个事务。
 *
 * 【为什么必须批量】593 条会话逐条 put 就是 593 个 IndexedDB 事务，
 * 每次提交都要等落盘；合并导入的主循环因此被拖到分钟级。按 20–32 条一批后
 * 只剩约 20–30 个事务。事务语义不变：写入失败仍是整批失败，由调用方中止导入
 * （commitStaging 才是原子替换点，暂存写失败不会动正式数据）。
 */
export const putStagingSessions = async (sessions: readonly Session[]): Promise<void> => {
  if (sessions.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([...sessions.map((session) => tx.store.put(session)), tx.done])
}

export const putStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).put('sessionsStaging', session)
}

/**
 * 只给「本次新写入、且带图片」的暂存会话回填 MIME。
 *
 * 【为什么不像 updateStagingFileTypes 那样全量扫描】
 * 上游的 updateStagingFileTypes 会遍历全部暂存会话，而合并导入的暂存里
 * 是「现有 593 条 + 导入 593 条」的大集合：再读一遍 35 MB JSON 只为改几十个
 * 图片附件，纯属浪费（真机上是秒级）。合并语义下：
 *   • 现有会话是整条复制进暂存的，MIME 原样保留，不需要回填；
 *   • 导入会话的附件 MIME 由 toLocalSession 初始化为 ''，只有图片原件在 ZIP 里，
 *     所以只需要把嗅探到的类型写到「引用了这些图片的导入会话」上。
 * 结果与全量扫描完全等价，读取量从 593 条降到「带图片的会话数」。
 */
export const updateStagingImageTypes = async (
  types: ReadonlyMap<string, string>,
  sessionIds: readonly string[]
): Promise<void> => {
  if (sessionIds.length === 0 || types.size === 0) {
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (const id of sessionIds) {
        const session = await tx.store.get(id)
        if (!session) {
          continue
        }
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id)
            if (type !== undefined && file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await tx.store.put(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 游标遍历暂存会话收集附件 MIME。
 *
 * 【为什么不能 getAll】旧实现 getAll('sessionsStaging') 会把 593 条会话
 * （35 MB JSON）一次性反序列化进 JS 堆。实测真实归档导入峰值堆 225 MB，
 * 在 128–256 MB 堆的低端机上直接 OOM 闪退。游标同一时间只持有一条记录，
 * 峰值内存与「最大的单条会话」成正比，与总条数无关。
 * （合并导入主流程不再全量扫描，而是用 updateStagingImageTypes 定向回填；
 * 本函数作为独立读取入口保留，并覆盖回归测试。）
 */
export const collectStagingFileTypes = async (): Promise<Map<string, string>> => {
  const types = new Map<string, string>()
  const tx = (await getDB()).transaction('sessionsStaging', 'readonly')
  for (
    let cursor = await tx.store.openCursor();
    cursor;
    cursor = await cursor.continue()
  ) {
    const session = cursor.value
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
  await tx.done
  return types
}
${MERGE_HELPERS_END}
`
  upsertBlock(
    'src/services/chat/db.ts',
    MERGE_HELPERS_START,
    MERGE_HELPERS_END,
    'export const addStagingSession = async (session: Session): Promise<void> => {',
    MERGE_HELPERS,
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

  // ── 补丁 18：移动端设置分组用「主色文字 + 底部指示条」表示选中 ────────────────
  // 【真实反馈】点了「数据管理」，它变成一块淡灰底，看起来像「变暗/被禁用」；
  // 而横排的「通用设置」反而像这一页的标题，整个面板读起来像通用设置的子菜单。
  // 原因是桌面端用「灰色底块」表示当前项（左侧竖排导航里读得出来），
  // 但同一套样式搬到手机横排 tab 上，深色底几乎不可见，语义完全丢失。
  // 移动端 tab 的通行做法是「文字变主色 + 底部一条指示条」，
  // 指示条直接把「我在哪一页」画出来，不依赖底色深浅。
  replaceOnce(
    'src/components/settings/Settings.module.css',
    'mobile-shell: mobile tab indicator',
    `  .navItem {
    flex: 1 0 auto;
    justify-content: center;
    width: auto;
    min-width: 108px;
    margin: 0;
    white-space: nowrap;

    &:first-child {
      margin-left: 4px;
    }

    &:last-child {
      margin-right: 4px;
    }
  }`,
    `  .navItem {
    flex: 1 0 auto;
    justify-content: center;
    width: auto;
    min-width: 108px;
    margin: 0;
    white-space: nowrap;

    /* mobile-shell: mobile tab indicator —— 横排 tab 用主色文字 + 底部指示条表示选中，
       不要沿用桌面端的灰色底块（在手机上看起来像禁用，见补丁注释） */
    position: relative;
    border-radius: 0;
    background-color: transparent;
    color: var(--dsw-alias-label-secondary);

    &:hover {
      background-color: transparent;
      color: var(--dsw-alias-label-primary);
    }

    &.navItemActive {
      background-color: transparent;
      color: var(--dsw-alias-brand-primary);
      font-weight: 600;
    }

    &.navItemActive::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 50%;
      width: 24px;
      height: 3px;
      border-radius: 2px;
      background-color: var(--dsw-alias-brand-primary);
      transform: translateX(-50%);
    }

    &:first-child {
      margin-left: 4px;
    }

    &:last-child {
      margin-right: 4px;
    }
  }`
  )

  // ── 补丁 19：导出「条目总数」查询，供导入进度使用 ────────────────────────────
  // 【为什么需要】导入大归档要几分钟，期间必须给出百分比进度，
  // 否则用户以为卡死。readArchive 是流式的，不告诉调用方还剩多少；
  // 而中央目录里本来就有全部条目，数一遍只需读文件末尾一段，
  // 不会像「再解压一遍来计数」那样让导入耗时翻倍。
  replaceOnce(
    'src/services/chat/history/zipReader.ts',
    'mobile-shell: count zip entries',
    `export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await readDirectory(file)`,
    `/**
 * mobile-shell: count zip entries —— 只读中央目录，返回可读条目数（不含目录项）。
 *
 * 供导入进度计算百分比用。只解析目录、不解压任何条目，
 * 因此在 30 MB 级别的归档上也只是读末尾几十 KB。
 */
export const countZipEntries = async (file: File): Promise<number> => {
  const directory = await readDirectory(file)
  return directory.entries.filter((entry) => !entry.path.endsWith('/')).length
}

export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await readDirectory(file)`
  )

  // ── 补丁 19b：中央目录只解析一次 ─────────────────────────────────────────────
  // 导入流程会对同一个 File 解析三遍目录：
  //   checkArchiveFormat()（校验 manifest）→ countZipEntries()（进度总数）→ readArchive()（正式遍历）。
  // 每次都要对 677 个条目做「读 46 字节头 + 读文件名 + 读 extra」的异步 File 读取，
  // 真机上是几千次小块读取（实测桌面端一遍约 0.4 s，手机上更贵）。
  // 用 WeakMap 按 File 缓存目录解析结果，三处共用一次。
  // File 是不可变 Blob，按对象缓存不会读到过期内容；WeakMap 条目随 File 一起回收。
  insertOnce(
    'src/services/chat/history/zipReader.ts',
    'mobile-shell: cached zip directory',
    'const readDirectory = async (file: File): Promise<{ entries: Entry[]; offset: number }> => {',
    `// mobile-shell: cached zip directory —— 一次导入里 checkArchiveFormat / countZipEntries /
// readArchive 会各解析一遍中央目录；缓存后只解析一次（目录本身很小，677 条目）。
const directoryCache = new WeakMap<File, Promise<{ entries: Entry[]; offset: number }>>()
const readDirectoryCached = (file: File): Promise<{ entries: Entry[]; offset: number }> => {
  let pending = directoryCache.get(file)
  if (!pending) {
    pending = readDirectory(file)
    directoryCache.set(file, pending)
    void pending.catch(() => {
      directoryCache.delete(file)
    })
  }
  return pending
}

`,
    'before'
  )

  replaceOnce(
    'src/services/chat/history/zipReader.ts',
    'mobile-shell: cached directory in count',
    `export const countZipEntries = async (file: File): Promise<number> => {
  const directory = await readDirectory(file)`,
    `export const countZipEntries = async (file: File): Promise<number> => {
  // mobile-shell: cached directory in count —— 与 checkArchiveFormat / readArchive 共用目录解析结果
  const directory = await readDirectoryCached(file)`
  )

  replaceOnce(
    'src/services/chat/history/zipReader.ts',
    'mobile-shell: cached directory in readArchive',
    `export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await readDirectory(file)`,
    `export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  // mobile-shell: cached directory in readArchive —— 与 checkArchiveFormat / countZipEntries 共用
  const directory = await readDirectoryCached(file)`
  )

  // ── 补丁 20：移动端官方 App 风格文案 ─────────────────────────────────────
  // 这次移动端改版按官方 Android App 的截图重做（见 docs/mobile-ui-spec.md），
  // 需要一批上游没有的文案：欢迎语、按住说话、拍照/相册/文件、搜索对话内容等。
  // 插在语言表末尾，桌面端不引用这些键，行为完全不受影响。
  const ZH_STRINGS = `  // ── mobile-ui: mobile strings zh —— 官方 App 风格的移动端文案（见 docs/mobile-ui-spec.md）
  welcomeBackGreeting: '欢迎回来，想从哪里开始？',
  chatInputPlaceholderMobile: '发消息或按住说话',
  addAttachment: '添加附件',
  camera: '拍照',
  album: '相册',
  fileAttachment: '文件',
  holdToTalk: '按住说话',
  releaseToSend: '松开发送，上滑取消',
  voiceTranscribing: '正在转写…',
  voiceTooShort: '说话时间太短',
  voiceInputKeyboard: '键盘输入',
  searchConversations: '搜索对话内容…',
  searching: '搜索中…',
  searchNoResults: '未找到相关对话',
  clearSearch: '清除',
  localAccountName: '本地用户',
  theme: '主题',
  changeAvatar: '更换头像',
  resetAvatar: '恢复默认头像',
  avatarUpdated: '头像已更新',
  avatarReset: '已恢复默认头像',
  avatarReadFailed: '图片读取失败，请换一张',
  balanceLabel: '余额',
  balanceLoading: '余额查询中…',
  balanceRefresh: '刷新余额',
  balanceKeyInvalid: 'Key 无效',
  balanceNetworkError: '网络异常',
  balanceFetchFailed: '获取失败',
  balanceInsufficient: '余额不足',
  // ── mobile-ui: mobile strings end ──
`

  const EN_STRINGS = `  // ── mobile-ui: mobile strings en —— 见 zh.ts 同名补丁
  welcomeBackGreeting: 'Welcome back. Where shall we start?',
  chatInputPlaceholderMobile: 'Message or hold to talk',
  addAttachment: 'Add attachment',
  camera: 'Camera',
  album: 'Photos',
  fileAttachment: 'Files',
  holdToTalk: 'Hold to talk',
  releaseToSend: 'Release to send, swipe up to cancel',
  voiceTranscribing: 'Transcribing…',
  voiceTooShort: 'Too short, please try again',
  voiceInputKeyboard: 'Keyboard',
  searchConversations: 'Search chats…',
  searching: 'Searching…',
  searchNoResults: 'No matching chats',
  clearSearch: 'Clear',
  localAccountName: 'Local user',
  theme: 'Theme',
  changeAvatar: 'Change avatar',
  resetAvatar: 'Reset avatar',
  avatarUpdated: 'Avatar updated',
  avatarReset: 'Avatar reset to default',
  avatarReadFailed: 'Could not read the image, try another',
  balanceLabel: 'Balance',
  balanceLoading: 'Checking balance…',
  balanceRefresh: 'Refresh balance',
  balanceKeyInvalid: 'Invalid API key',
  balanceNetworkError: 'Network error',
  balanceFetchFailed: 'Failed to load',
  balanceInsufficient: 'Insufficient balance',
  // ── mobile-ui: mobile strings end ──
`

  // i18n 的移动端文案增长很快（换头像、录音、搜索…），必须用 upsertBlock：
  // replaceOnce 见到旧标记就跳过，已打过补丁的 web/ 会永远停在第一版文案上。
  const MOBILE_STRINGS_END = '  // ── mobile-ui: mobile strings end ──'
  upsertBlock(
    'src/i18n/zh.ts',
    '  // ── mobile-ui: mobile strings zh',
    MOBILE_STRINGS_END,
    "  settingsLocaleEnUS: 'English',",
    ZH_STRINGS,
    'before'
  )

  upsertBlock(
    'src/i18n/en.ts',
    '  // ── mobile-ui: mobile strings en',
    MOBILE_STRINGS_END,
    "  settingsLocaleEnUS: 'English',",
    EN_STRINGS,
    'before'
  )

  // ── 补丁 21：引入移动端全局样式（tokens / 主题 / 列表留白）────────────────
  // 必须排在 global.css 之后：同名 CSS 变量要靠后加载覆盖。
  replaceOnce(
    'src/main.tsx',
    'mobile-ui: mobile css',
    "import './app/global.css'",
    `import './app/global.css'
// mobile-ui: mobile css —— 移动端官方 App 风格的 tokens 与全局修正（web-patches/mobile/common/mobile.css）
import './mobile/common/mobile.css'`
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

  step('注入移动端覆盖层')
  injectMobileSources()

  step('应用移动端 fork')
  await applyMobileOverrides()

  step('应用上游补丁')
  applyPatches()

  step('准备完成')
  info('下一步：pnpm build:web')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
