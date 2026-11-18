/**
 * 会话历史合并导入桥 —— web-patches/import-bridge.ts
 *
 * 【为什么不直接用上游的 importHistory】
 * 上游 `importHistory()` 走 `replaceHistory(() => importArchive(file))` —— **整体覆盖**：
 * commitStaging 先 clear 掉 sessions / files，再把 ZIP 里的内容搬进去。
 * 桌面端「导入备份」的语义是「把这台机器恢复成备份时的样子」，覆盖是对的。
 * 本项目的需求是「把别处的会话合并进手机」，覆盖会直接抹掉手机上已有的对话，
 * 属于数据丢失。所以必须把语义改成 **merge**。
 *
 * 【merge 怎么做到既合并又不破坏上游的原子性】
 * 上游 `commitStaging()` 是「清空正式表 → 从暂存搬入」，靠这个保证「要么全成、要么全不动」。
 * 想复用它做合并，唯一办法是让暂存里装的是 **并集**：
 *   1. `db.stageCurrentHistory()` 先把正式表的会话与原件整体复制进暂存；
 *   2. 再把 ZIP 里的会话按 id `put` 进暂存（同 id 覆盖 = 更新，新 id 追加）；
 *   3. 交给 `commitStaging()` 一次性搬回 —— 事务失败则整体回滚，正式数据不变。
 * 既保留了上游的原子性，又实现了合并。这两个 db 辅助函数是本项目新增的
 * （见 patches/db.merge.ts.patch），上游既有函数一个都没改。
 *
 * 【附件 MIME 的坑】
 * 上游 `updateStagingFileTypes(types)` 对暂存里每个附件执行
 *   `file.mimeType = types.get(id) ?? ''`
 * 即**映射里没有的附件会被清成空字符串**。覆盖导入时所有附件都在映射里，没问题；
 * 合并时现有会话的附件不在映射里，直接调用会把老会话的图片/PDF 类型抹掉。
 * 所以这里先用 `collectStagingFileTypes()` 读出暂存里已有的值，再叠上新嗅探的结果。
 *
 * 【幂等】
 * 同一个 ZIP 连导三次，会话数不能变。两层保障：
 *   1. 账本（localStorage，只有 id 与计数，无敏感信息）：命中即 skipped；
 *   2. `updatedAt` 不比本机新的也 skipped —— 账本丢了也不会重复追加或回退内容。
 *
 * 【为什么单条坏会话不整批失败】
 * 需求要求结果页给出 {added, updated, skipped, failed}，说明允许部分成功。
 * 但 **ZIP 结构本身损坏**（ArchiveError）必须整批回滚 —— 那说明文件不可信，
 * 继续读只会在半截数据上做决策。
 */

import { exportHistory } from '../services/chat/backup.js'
import * as db from '../services/chat/db.js'
import { BackupError } from '../services/chat/history/errors.js'
import { checkArchiveFormat } from '../services/chat/history/importArchive.js'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  USER_PATH,
  parseSessionPath,
} from '../services/chat/history/paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from '../services/chat/history/schema.js'
import { toLocalSession } from '../services/chat/history/toLocal.js'
import {
  ArchiveError,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from '../services/chat/history/zipReader.js'
import { replaceHistory } from '../services/chat/store.js'
import type { Session } from '../services/chat/types.js'
import { PLUGIN_FILES, callNative, isNativeShell } from './bridge.js'
import { showImportResult } from './import-ui.js'
import { readLocalStorage, writeLocalStorage } from './storage-utils.js'

/** 导入结果：四个数字加起来应当等于 ZIP 里的会话数 */
export type MergeResult = {
  added: number
  updated: number
  skipped: number
  failed: number
  /** 导入前自动备份的位置；浏览器（无原生壳）为 null */
  backupPath: string | null
  /** 逐条失败原因，最多 5 条，避免刷屏 */
  errors: string[]
}

declare global {
  interface Window {
    /** 上游 backup.ts 补丁检测到它就改用合并导入；浏览器里不存在 */
    __CHAT_DEMO_IMPORT__?: { merge(file: File): Promise<MergeResult> }
  }
}

const LEDGER_KEY = 'chat-demo:import-ledger'

const readLedger = (): Record<string, true> => {
  const raw = readLocalStorage(LEDGER_KEY)
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // 只接受对象；数组/null/原始值一律当空账本
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, true>)
      : {}
  } catch {
    return {}
  }
}

const writeLedger = (ledger: Record<string, true>): void => {
  // 账本只是「跳过重复导入」的优化；写失败不影响正确性（updatedAt 兜底）
  writeLocalStorage(LEDGER_KEY, JSON.stringify(ledger))
}

/** 末条消息的「体积」：用户消息看文本长度，助手消息看内容块数 */
const tailSize = (session: Session): number => {
  const last = session.messages[session.messages.length - 1]
  if (!last) {
    return 0
  }
  return last.role === 'user' ? last.content.length : last.blocks.length
}

/** 内容指纹：会话没变过就一定命中，变了就大概率不命中 */
const fingerprint = (session: Session): string =>
  [
    session.id,
    session.messages.length,
    session.messages[session.messages.length - 1]?.id ?? '-',
    tailSize(session),
  ].join('|')

/** Blob → base64，分块拼接避免 `String.fromCharCode(...bigArray)` 爆栈 */
const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** 与上游 backup.ts 的 backupFileName 同风格，但精确到秒，避免同一天覆盖 */
const backupStamp = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 从原件字节嗅探图片 MIME。
 * 与上游 importArchive.ts 里的 `imageType` 逻辑一致 —— 那边没导出，所以这里复制一份。
 * 返回值只用于展示与后续上传，不参与「是不是图片」的判断（那由归档的 is_image 决定）。
 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

/**
 * 导入前自动备份：把当前全部会话导出为 ZIP 并写到 Documents。
 * 需求硬性要求 —— 合并万一出错，用户还有退路。
 * 备份失败时**直接抛错中止导入**：宁可不让用户导，也不能在没有退路的情况下动数据。
 */
const backupBeforeImport = async (): Promise<string> => {
  const { blob } = await exportHistory()
  const fileName = `deep-chat-backup-${backupStamp(new Date())}.zip`
  const { path } = await callNative<{ path: string }>(PLUGIN_FILES, 'saveBackup', {
    fileName,
    data: await toBase64(blob),
  })
  return path
}

/** JSON 解析失败的会话记为单条失败，不整批回滚 */
const parseJson = async (entry: ArchiveEntry): Promise<unknown> =>
  JSON.parse(await (await readEntry(entry)).text())

/**
 * 合并导入主流程。
 *
 * 顺序刻意如此：
 *   1. 先校验 ZIP 格式 —— 坏文件不该触发一次全量备份（别让用户白等大文件拷贝）；
 *   2. 备份当前数据 —— 没有退路就不动数据；
 *   3. 一个 replaceHistory 事务内完成「复制现有 + 合并导入」，失败整体回滚。
 */
export const mergeImport = async (file: File): Promise<MergeResult> => {
  // 1. 格式校验（上游实现，含 manifest 版本检查）
  await checkArchiveFormat(file)

  // 2. 备份（仅原生壳；浏览器里交给上游原来的覆盖式导入）
  const backupPath = isNativeShell() ? await backupBeforeImport() : null

  const result: MergeResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    backupPath,
    errors: [],
  }
  const ledger = readLedger()
  /** 现有会话 id → updatedAt，用来判断「导入的这份是不是更新的」 */
  const existing = new Map<string, number>()
  for (const summary of await db.loadSessionSummaries()) {
    existing.set(summary.id, summary.updatedAt)
  }
  /** 本次真正写进暂存的会话 id —— 只有它们引用的图片才需要保存 */
  const kept = new Set<string>()
  /** 被保留会话引用的 ZIP 条目名 → 附件 id */
  const images = new Map<string, string>()
  /** 已写入暂存的附件 id → 嗅探到的 MIME，同一张图在多个会话目录出现时只写一次 */
  const sniffed = new Map<string, string>()

  await replaceHistory(async () => {
    // 3.1 并集的底：把现有正式数据整体复制进暂存
    await db.stageCurrentHistory()

    // 3.2 逐条读 ZIP
    let manifest = false
    let sawIndex = false
    let sawSession = false
    for await (const entry of readArchive(file)) {
      const { path } = entry

      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          throw new BackupError('backupUnrecognized')
        }
        checkManifest(await parseJson(entry))
        manifest = true
        continue
      }

      // user.json 是脱敏的账号信息，本来就不导入
      if (path === USER_PATH && !sawIndex && !sawSession) {
        await skipEntry(entry)
        continue
      }

      const sessionId = parseSessionPath(path)
      if (sessionId !== null) {
        const text = await (await readEntry(entry)).text()
        // 先解析再分类：这一步失败可能是单条会话数据坏了（记为 failed 继续），
        // 也可能是 JSON 本身不可解析（同上）。ZIP 结构层面的错误在 readArchive
        // 里抛 ArchiveError，会穿过下面的 catch 整批回滚。
        try {
          const parsed = readSessionFile(JSON.parse(text))
          // 文件名与内容 id 不一致属于归档损坏，不是「这一条跳过」能解决的
          if (parsed.id !== sessionId) {
            throw new Error(`会话 id 不一致：文件名 ${sessionId}，内容 ${parsed.id}`)
          }
          const { session, images: sessionImages } = toLocalSession(parsed)
          if (ledger[fingerprint(session)]) {
            result.skipped += 1
            continue
          }
          const known = existing.get(session.id)
          if (known !== undefined && session.updatedAt <= known) {
            // 本机这份不比导入的旧 → 留本机，绝不拿旧内容覆盖用户正在用的会话
            result.skipped += 1
            continue
          }
          await db.putStagingSession(session)
          sawSession = true
          kept.add(session.id)
          for (const [imagePath, id] of sessionImages) {
            images.set(imagePath, id)
          }
          ledger[fingerprint(session)] = true
          if (known === undefined) {
            result.added += 1
          } else {
            result.updated += 1
          }
        } catch (error) {
          // ZIP 结构坏了要整批回滚；单条会话数据坏了只跳这一条
          if (error instanceof ArchiveError) {
            throw error
          }
          result.failed += 1
          if (result.errors.length < 5) {
            result.errors.push(`${sessionId}: ${(error as Error).message}`)
          }
        }
        continue
      }

      if (path === INDEX_PATH && !sawIndex) {
        // 只做格式校验；合并模式下 index 不再需要与导入集合一一对应
        readSessionIndex(await parseJson(entry))
        sawIndex = true
        continue
      }

      // 剩下的是图片。只保存「被保留的会话」引用到的那些；其余读完丢弃（也要消耗流）。
      const owner = /^chat_sessions\/([^/]+)_files\//.exec(path)?.[1]
      const id = owner !== undefined && kept.has(owner) ? images.get(path) : undefined
      if (id === undefined || sniffed.has(id)) {
        await skipEntry(entry)
        continue
      }
      const data = await readEntry(entry)
      const mimeType = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
      await db.saveStagingFiles([{ id, blob: new Blob([data], { type: mimeType }) }])
      sniffed.set(id, mimeType)
    }

    if (!manifest) {
      throw new BackupError('backupUnrecognized')
    }

    // 3.3 回填附件 MIME：暂存里已有的（= 现有会话的）先垫底，再用本次嗅探结果覆盖
    if (sniffed.size > 0) {
      const types = await db.collectStagingFileTypes()
      for (const [id, mimeType] of sniffed) {
        types.set(id, mimeType)
      }
      await db.updateStagingFileTypes(types)
    }
  })

  writeLedger(ledger)
  return result
}

/**
 * 装到 window 上，供上游 `backup.ts` 的补丁判断「有没有原生合并导入可用」。
 * 浏览器 / PWA 里不装，上游的覆盖式导入照常工作 —— PWA 回退路线不受影响。
 */
export const installImportBridge = (): void => {
  if (!isNativeShell()) {
    return
  }
  window.__CHAT_DEMO_IMPORT__ = {
    merge: async (file: File) => {
      const result = await mergeImport(file)
      // 结果页由桥自己弹：上游那边只拿到一个数字，展示不下四种统计
      await showImportResult(result)
      return result
    },
  }
}

/**
 * 检查有没有「外部打开 ZIP」传进来的待处理文件，有就走合并导入。
 *
 * 【为什么要轮询而不是等原生推事件】
 * 原生侧用静态字段存 URI（见 native/file-open/FileOpenPlugin.java 的 setPendingUri），
 * 因为冷启动时 Activity.onCreate 早于插件实例化，没有实例可调。
 * 网页拿这个字段只能主动问。轮询一次的成本是一次 IPC，比维护事件监听器
 * 的生命周期（页面可能被系统连杀几次）可靠得多。
 *
 * 【触发时机】
 *   • 启动时一次（冷启动：用户从文件管理器直接点开 ZIP）；
 *   • 每次页面重新可见时（热启动：应用在后台，用户又分享了一个 ZIP 过来）。
 * visibilitychange 是 WebView 里最可靠的返回前台信号，
 * onResume 对应的原生事件在 Capacitor 里没有稳定的 JS 事件。
 *
 * 【并发保护】
 * 两次触发可能重叠（例如恢复前台的同时又收到一次 visibilitychange），
 * 用 running 标志挡住，避免同一个 ZIP 被并行导入两遍。
 */
let running = false

const consumePendingFile = async (): Promise<void> => {
  if (running || !isNativeShell()) {
    return
  }
  running = true
  try {
    const pending = await callNative<{ pending: boolean }>(PLUGIN_FILES, 'hasPendingFile')
    if (!pending.pending) {
      return
    }
    const file = await callNative<{ name: string | null; data?: string }>(
      PLUGIN_FILES,
      'getPendingFile'
    )
    if (!file.name || !file.data) {
      return
    }
    // 原生给的是 base64（WebView 读不到 content:// URI），还原成 Blob 再包成 File，
    // 这样上游那套基于 File/Blob 的 ZIP 读取逻辑可以原样复用
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'application/zip' })
    const archive = new File([blob], file.name, { type: 'application/zip' })
    const result = await mergeImport(archive)
    await showImportResult(result)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[mobile-shell] failed to import incoming file', error)
  } finally {
    running = false
  }
}

/** 装好「外部打开 ZIP」的处理：只挂监听，首次检查由 kickIncomingFile() 触发 */
export const installIncomingFileHandler = (): void => {
  if (!isNativeShell()) {
    return
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void consumePendingFile()
    }
  })
}

/**
 * 主动查一次待处理文件。
 *
 * 由 shell.ts 在**首启引导结束之后**调用，而不是在 install 时立刻调：
 * 合并导入要用上游的 db 与 store，而它们要等 App 挂载后才初始化；
 * 同时引导浮层和导入结果页不能叠在一起。
 */
export const kickIncomingFile = (): void => {
  void consumePendingFile()
}
