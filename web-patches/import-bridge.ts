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
 * 0.2.4 的合并实现让暂存装**并集**：先把现有正式数据整条复制进暂存，再把导入数据 put 进去，
 * 最后整体搬回。正确，但等于每次导入都把本机全量数据多写两遍 —— 真机上这是分钟级耗时的
 * 主因之一。0.2.5 改成 `db.commitMergeStaging()`：只把本次导入的会话/原件 put 进正式表，
 * 不清空正式表；**仍是同一个事务**，失败整体回滚。原子性不变，写入量降到 1/3。
 *
 * 【附件 MIME 的坑】
 * 上游 `updateStagingFileTypes(types)` 对暂存里每个附件执行
 *   `file.mimeType = types.get(id) ?? ''`
 * 即**映射里没有的附件会被清成空字符串**。覆盖导入时所有附件都在映射里，没问题；
 * 合并时现有会话的附件不在映射里，直接调用会把老会话的图片/PDF 类型抹掉。
 * 第一版用 `collectStagingFileTypes()` 全量重读暂存再叠加，代价是 593 条会话 / 35 MB JSON
 * 再反序列化一次（实测堆峰值 227 MB）。现在改成 `updateStagingImageTypes(types, ids)`：
 * 现有会话不再进暂存，本来就不需要回填；只给「本次新写入、且带图片」的会话回填。
 *
 * 【大归档为什么要分块 + 分批】
 * 用户的真实归档是 31 MB / 677 条目 / 593 条会话 / 81 张图。整包 base64 过桥、593 个单条
 * 事务、getAll 全量进堆，三者叠加会同时「慢到分钟级」和「把低端机顶到 OOM 闪退」。现在：
 *   • 备份上传与文件读入都走原生分块（原生契约见 native/file-open/README.md）；
 *   • 暂存会话/图片按批写（每批一个事务），批间让出主线程让进度条能画；
 *   • 中央目录在 zipReader 里按 File 缓存，且整份目录只读一次（见 zipReader fork）。
 *
 * 【重复导入为什么能快】
 * 账本 v2 的键是 `会话id|CRC|解压后大小`，三者都来自**已校验过的中央目录**，不需要解压。
 * 命中且本机仍存在该会话时，直接把该条目的原始字节丢掉（不 inflate、不 parse、不写库）。
 * 旧版账本键（文本指纹）会被自动忽略，升级后第一次导入仍走完整解析，只多一轮。
 *
 * 【为什么单条坏会话不整批失败】
 * 需求要求结果页给出 {added, updated, skipped, failed}，说明允许部分成功。
 * 但 **ZIP 结构本身损坏**（ArchiveError）必须整批回滚 —— 那说明文件不可信，
 * 继续读只会在半截数据上做决策。
 *
 * 【导入前的自动备份】
 * 0.2.4 在解析之前就做备份；0.2.5 改到「解析完、确认本次确实要写数据」之后、提交之前：
 *   • 本机没有会话 → 没什么可备份的；
 *   • 本次全部被跳过 → 不写数据，也就没有退路问题；
 *   • 上次成功备份后数据没变 → 复用上次的备份即可；
 *   • 用户关掉开关 → 按用户选择（默认开）。
 * 备份仍然严格发生在写正式表之前，失败仍然中止导入。
 */

import { exportHistorySnapshot } from '../services/chat/backup.js'
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
  countZipEntries,
  readArchive,
  readEntryBytes,
  skipEntry,
} from '../services/chat/history/zipReader.js'
import { replaceHistory } from '../services/chat/store.js'
import type { Session, SessionSummary } from '../services/chat/types.js'
import { PLUGIN_FILES, callNative, isNativeShell } from './bridge.js'
import { NATIVE_CHUNK_BYTES, saveArchiveToDevice, yieldToPaint } from './native-backup.js'
import { showImportResult, showImportProgress, type ImportProgress } from './import-ui.js'
import { readLocalStorage, writeLocalStorage } from './storage-utils.js'

/** 归档是怎么交给解析器的：一次性读入内存 / 流式收集 / 直接读原 File（回退） */
export type ReadMode = 'memory' | 'stream' | 'direct'

/** 各阶段耗时（毫秒）。提交包含「搬数据 + 重载摘要 + 状态收尾」，是总时长减出来的。 */
export type ImportTiming = {
  /** 把系统选择器给的 File 读进内存（SAF content URI 必须一次性读，见 materializeArchive） */
  read: number
  check: number
  /** 解析总时长；下面几个子桶是它的拆分 */
  parse: number
  /** readEntryBytes：解压 + CRC */
  decompress: number
  /** TextDecoder + JSON.parse */
  json: number
  /** readSessionFile + toLocalSession（校验与树重建） */
  convert: number
  /** 写暂存会话的 IndexedDB 等待 */
  stageWrite: number
  /** 读图片条目 */
  imageRead: number
  /** 写暂存图片的 IndexedDB 等待 */
  imageWrite: number
  backup: number
  commit: number
  total: number
}

/** 备份被跳过的原因；真的做了备份时为 null */
export type BackupSkipReason = 'empty' | 'unchanged' | 'disabled' | 'nothing'

/** 导入结果：四个数字加起来应当等于 ZIP 里的会话数 */
export type MergeResult = {
  added: number
  updated: number
  skipped: number
  failed: number
  /** 导入前自动备份的位置；未备份（浏览器 / 跳过）为 null */
  backupPath: string | null
  /** 备份被跳过的原因；真备份了是 null */
  backupSkipped: BackupSkipReason | null
  /** 逐条失败原因，最多 5 条，避免刷屏 */
  errors: string[]
  /** 实际解压并解析的会话数；账本快速跳过的不算 */
  parsed: number
  /** 本次靠账本 + 原生跳过（不解析、不写库）的会话数 */
  skippedFast: number
  /** 归档原始大小（字节） */
  archiveBytes: number
  /** 归档读取方式 */
  readMode: ReadMode
  /** 会话暂存事务次数 / 图片暂存事务次数（真机事务提交有固定成本，这两个数直接对应耗时） */
  stageTxns: number
  imageTxns: number
  timing: ImportTiming
}

/** 进度回调：合并过程中反复调用，让界面能显示「到哪一步了」 */
export type ProgressReporter = (progress: ImportProgress) => void

declare global {
  interface Window {
    /** 上游 backup.ts 补丁检测到它就改用合并导入；浏览器里不存在 */
    __DEEP_CHAT_IMPORT__?: { merge(file: File): Promise<MergeResult> }
    /** 最近一次导入的阶段耗时，供真机诊断/回归读数；浏览器里也有 */
    __IMPORT_PROFILE__?: ImportTiming & {
      added: number
      updated: number
      skipped: number
      skippedFast: number
      parsed: number
      archiveBytes: number
      readMode: ReadMode
      stageTxns: number
      imageTxns: number
    }
  }
}

const LEDGER_KEY = 'deep-chat:import-ledger'
const BACKUP_ENABLED_KEY = 'deep-chat:import-backup'
const LAST_BACKUP_KEY = 'deep-chat:last-backup'

/**
 * 暂存会话批量写：按字节 / 条数双阈值。
 *
 * 【为什么从 24 条改成 8 MB / 250 条】真机上 IndexedDB 每次事务提交都有可观的固定成本：
 * 用户 594 条首次导入时，25 个「24 条/批」的小事务花了 96 s，而 commit 用 1 个事务写 594 条
 * 只要 8 s。批大一点、事务少一点，是这台机器上最直接的提速手段。
 */
const SESSION_BATCH_BYTES = 8 * 1024 * 1024
const SESSION_BATCH_SIZE = 250

/** 图片批量写：单批字节上限。图片单张最大 0.9 MB，16 MB 一批兼顾内存与事务数。 */
const IMAGE_BATCH_BYTES = 16 * 1024 * 1024

/** 图片批量写：单批条数上限（小图时避免一批塞太多记录）。 */
const IMAGE_BATCH_COUNT = 64

/** 账本上限：只保留最近 5000 条（约 300 KB localStorage），避免无限增长。 */
const LEDGER_LIMIT = 5000

/** 账本 v2 键：`会话id|CRC|解压后大小`；旧版（文本指纹）键不匹配，读时丢弃。 */
const LEDGER_KEY_PATTERN = /^[^|]+\|\d+\|\d+$/

const readLedger = (): Record<string, true> => {
  const raw = readLocalStorage(LEDGER_KEY)
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    // 只接受 v2 键；旧版键在这里被自然淘汰。
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([key, value]) => value === true && LEDGER_KEY_PATTERN.test(key)
      )
    ) as Record<string, true>
  } catch {
    return {}
  }
}

const writeLedger = (ledger: Record<string, true>): void => {
  // 账本只是「跳过重复导入」的优化；写失败不影响正确性（updatedAt 兜底）
  let entries = Object.entries(ledger)
  if (entries.length > LEDGER_LIMIT) {
    entries = entries.slice(entries.length - LEDGER_LIMIT)
  }
  writeLocalStorage(LEDGER_KEY, JSON.stringify(Object.fromEntries(entries)))
}

/** 导入前自动备份开关（确认弹窗里的复选框写这里）：默认开 */
export const isAutoBackupEnabled = (): boolean => readLocalStorage(BACKUP_ENABLED_KEY) !== '0'

export const setAutoBackupEnabled = (enabled: boolean): void => {
  writeLocalStorage(BACKUP_ENABLED_KEY, enabled ? '1' : '0')
}

type BackupMeta = {
  at: number
  count: number
  latest: number
  titles: string
}

const readBackupMeta = (): BackupMeta | null => {
  const raw = readLocalStorage(LAST_BACKUP_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackupMeta>
    return typeof parsed.at === 'number' &&
      typeof parsed.count === 'number' &&
      typeof parsed.latest === 'number' &&
      typeof parsed.titles === 'string'
      ? { at: parsed.at, count: parsed.count, latest: parsed.latest, titles: parsed.titles }
      : null
  } catch {
    return null
  }
}

const writeBackupMeta = (meta: BackupMeta): void => {
  writeLocalStorage(LAST_BACKUP_KEY, JSON.stringify(meta))
}

/** FNV-1a：把会话 id + 标题滚成一个短指纹；改名也会让备份失效（宁可多备份一次） */
const titleFingerprint = (summaries: readonly SessionSummary[]): string => {
  let hash = 0x811c9dc5
  const ids = summaries.map((summary) => summary.id).sort()
  const byId = new Map(summaries.map((summary) => [summary.id, summary.title]))
  for (const id of ids) {
    const text = `${id}|${byId.get(id) ?? ''}`
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16)
}

const historyFingerprint = (
  summaries: readonly SessionSummary[]
): { count: number; latest: number; titles: string } => ({
  count: summaries.length,
  latest: summaries.reduce((latest, summary) => Math.max(latest, summary.updatedAt), 0),
  titles: titleFingerprint(summaries),
})

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
 *
 * 【为什么改成 begin / appendChunk / finish 分块上传】
 * 旧实现把整个 ZIP 转成一个 base64 字符串，再作为一次 `saveBackup` 的入参过桥。
 * 真实归档（31 MB → 备份 ZIP 52 MB）实测单次桥负载 **69.6 MB 字符串**：
 * WebView 侧要再序列化一遍 JSON，Java 侧要再解码出 52 MB byte[] —— 低端机直接 OOM。
 * 分块后原生先把数据写进应用缓存临时文件，finish 时才流式落到 Documents；
 * 任一步失败都 abort 并删除临时文件，不会留下半截备份。
 *
 * 【分块循环为什么在 native-backup.ts】
 * 用户手动「导出所有历史对话」也要写同一份协议（此前它靠 `<a download>`，
 * 在 WebView 里是静默无效的）。两个入口共用 `saveArchiveToDevice()`，
 * 避免 256 KB 分块契约改了一处漏一处。
 */
const backupBeforeImport = async (report: ProgressReporter): Promise<string> => {
  // mobile-shell: backup no enqueue —— 这里必须用不入队的快照版本。
  // mergeImport 是被上游 importHistory() 调进来的，而后者已经坐在 enqueueBackup
  // 的队列里；再调同样会入队的 exportHistory()，就变成「队列里的任务 A 等在它之后
  // 才可能执行的任务 B」，队列永远不前进。
  // 真机表现：导入卡死、一条会话都进不去。浏览器里测不出来 —— isNativeShell() 为
  // false 时这段备份整段跳过，正好绕开了 bug。
  const { blob } = await exportHistorySnapshot()
  const fileName = `deep-chat-backup-${backupStamp(new Date())}.zip`
  const phase = '正在备份本机现有会话'
  return saveArchiveToDevice(blob, fileName, (written, total) => {
    report({ phase, done: written, total })
  })
}

/**
 * 数出归档里有多少个可读条目（不含目录项），用来算真实进度百分比。
 *
 * 【为什么不用 readArchive 数】
 * readArchive 会把每个条目**完整解压**（skipEntry 也要走 CRC 校验），
 * 为了计数再解压一遍等于让导入耗时翻倍 —— 手机上从几秒变十几秒，不能接受。
 * 归档的中央目录里本来就有全部条目，只读末尾那一段就够了（zipReader fork 已一次性读入）。
 */
const countArchiveEntries = async (file: File): Promise<number | null> => {
  try {
    return await countZipEntries(file)
  } catch {
    // 数不出来不该挡住导入：退化为「已处理 N 条」
    return null
  }
}

/** 原生 openPendingFile 的返回；没有待处理文件时只有 name: null */
type OpenPendingResult = {
  handle?: string
  name: string | null
  /** 文件大小；少数 provider 不提供时为 -1/undefined */
  size?: number
}

/** 原生 readPendingFileChunk 的返回 */
type PendingChunk = {
  /** 本块原始字节的 base64 */
  data: string
  /** 本块字节数（0 表示已到结尾） */
  size: number
  eof: boolean
}

/**
 * 把「外部打开」的 ZIP 分块读进 WebView，拼成上游认识的 File。
 *
 * 【为什么不能一次拿整包】
 * content:// URI 只能原生读。旧实现一次返回整个 ZIP 的 base64：31 MB 归档 →
 * 42 MB 字符串，JS 侧再 atob 成 32 MB 数组，峰值内存上百 MB；跨桥的大字符串
 * 本身也要几秒。现在每次只取一块（0.2.5 起 1 MB，base64 ≤ 1.4 MB），逐块塞进 Blob；
 * Blob 的字节不占 JS 堆，单块数组随即回收，峰值与单块大小成正比。
 *
 * 【错误与清理】
 * 任何一个 chunk 失败都会抛错，finally 里一定 closePendingFile 释放原生句柄；
 * 原生侧读失败也会自行丢弃句柄，close 是幂等的。
 */
const readPendingArchive = async (report: ProgressReporter): Promise<File | null> => {
  const opened = await callNative<OpenPendingResult>(PLUGIN_FILES, 'openPendingFile')
  if (!opened.handle || !opened.name) {
    return null
  }
  const handle = opened.handle
  const total = typeof opened.size === 'number' && opened.size > 0 ? opened.size : null
  const parts: Blob[] = []
  let offset = 0
  report({ phase: '正在读取导入文件', done: 0, total })
  try {
    for (;;) {
      const chunk = await callNative<PendingChunk>(PLUGIN_FILES, 'readPendingFileChunk', {
        handle,
        offset,
        length: NATIVE_CHUNK_BYTES,
      })
      if (chunk.size > 0) {
        // 逐块转成 Blob 后立刻丢掉 Uint8Array：JS 堆里只留 Blob 引用
        const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0))
        parts.push(new Blob([bytes]))
        offset += chunk.size
        report({ phase: '正在读取导入文件', done: offset, total })
      }
      if (chunk.eof || chunk.size === 0) {
        break
      }
      // 每块一次原生往返，块间让出主线程保持界面响应
      await yieldToPaint()
    }
  } finally {
    await callNative(PLUGIN_FILES, 'closePendingFile', { handle }).catch(() => {})
  }
  if (offset === 0) {
    return null
  }
  // Blob 拼接不复制数据；File 只是给它一个名字，供上游的错误提示使用
  const blob = new Blob(parts, { type: 'application/zip' })
  const file = new File([blob], opened.name, { type: 'application/zip' })
  // 这条路径已经把内容读进内存了：再 materialize 一次是纯拷贝，标记后跳过。
  inMemoryArchives.add(file)
  return file
}

/**
 * 导入期间尽量保持屏幕常亮。
 *
 * 【为什么需要】Android WebView 在页面不可见时会钳制定时器（`setTimeout` 最少约 1 秒）。
 * 导入要几分钟，用户把屏幕放下/切走后再回来，进度会像「一秒一条」一样爬。
 * Wake Lock 在 https 安全上下文可用（本 App 是 https://localhost）；拿不到就静默降级。
 */
const keepScreenAwake = (): (() => void) => {
  const wakeLock = (
    navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
  ).wakeLock
  if (!wakeLock?.request) {
    return () => {}
  }
  type WakeLockSentinelLike = {
    release(): Promise<void>
    addEventListener?(type: 'release', listener: () => void): void
  }
  let sentinel: WakeLockSentinelLike | null = null
  let released = false
  const request = () => {
    void wakeLock
      .request('screen')
      .then((next) => {
        if (released) {
          void next.release().catch(() => {})
          return
        }
        sentinel = next
        next.addEventListener?.('release', () => {
          sentinel = null
        })
      })
      .catch(() => {})
  }
  request()
  const onVisible = () => {
    if (!released && document.visibilityState === 'visible' && !sentinel) {
      request()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    released = true
    document.removeEventListener('visibilitychange', onVisible)
    void sentinel?.release().catch(() => {})
  }
}

/**
 * 把归档读成内存里的 File。
 *
 * 【为什么必须这么做】系统文件选择器给出的是 `content://` 流：每一次 `slice().arrayBuffer()`
 * 都会重新 open + seek 到偏移。条目越多、偏移越大，累计读取量就越接近 O(n²)：
 * 用户真机（归档 > 48 MB）第二轮「全部跳过」什么都没解析、什么都没写，却花了 75.6 s ——
 * 时间全花在这种随机读上。
 *
 * 0.2.5 只对 ≤ 48 MB 做了这件事，用户的归档刚好超过上限，等于没生效。现在：
 *   • ≤ 128 MB：`arrayBuffer()` 一次性读入（一次 open、顺序读）；
 *   • 128–256 MB：`file.stream()` 逐块收进 Blob 分片（字节留在浏览器进程，避免 JS 大数组）；
 *   • 原生「用其他应用打开 ZIP」拼出来的 File 本来就在内存里，直接跳过拷贝；
 *   • 任一步失败都回退原 File（最坏回到旧行为，不会更差）。
 */
const BUFFER_LIMIT = 128 * 1024 * 1024
const MATERIALIZE_LIMIT = 256 * 1024 * 1024

/** 原生分块读取路径拼出来的 File：已经在内存里，不必再拷贝一次 */
const inMemoryArchives = new WeakSet<File>()

/** 把 File/Blob 流式收进 Blob 分片，再包成 File（字节不进 JS 堆） */
const readAllViaStream = async (file: File): Promise<File> => {
  const parts: Blob[] = []
  const stream = file.stream()
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value && value.length > 0) {
        parts.push(new Blob([value as Uint8Array<ArrayBuffer>]))
      }
    }
  } finally {
    reader.releaseLock()
  }
  return new File([new Blob(parts)], file.name, { type: 'application/zip' })
}

const materializeArchive = async (
  file: File,
  report: ProgressReporter
): Promise<{ archive: File; mode: ReadMode }> => {
  if (inMemoryArchives.has(file)) {
    return { archive: file, mode: 'memory' }
  }
  if (file.size === 0 || file.size > MATERIALIZE_LIMIT) {
    return { archive: file, mode: 'direct' }
  }
  report({ phase: '正在读取导入文件', done: null, total: file.size })
  if (file.size <= BUFFER_LIMIT) {
    try {
      const buffer = await file.arrayBuffer()
      return { archive: new File([buffer], file.name, { type: 'application/zip' }), mode: 'memory' }
    } catch {
      // 内存不足：退到流式收集，不把整个文件放进 JS 堆
    }
  }
  try {
    return { archive: await readAllViaStream(file), mode: 'stream' }
  } catch {
    return { archive: file, mode: 'direct' }
  }
}

/** 合并导入主流程。 */
export const mergeImport = async (
  file: File,
  onProgress?: ProgressReporter
): Promise<MergeResult> => {
  const report: ProgressReporter = onProgress ?? (() => {})
  const startedAt = performance.now()
  const releaseWakeLock = keepScreenAwake()

  const result: MergeResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    backupPath: null,
    backupSkipped: null,
    errors: [],
    parsed: 0,
    skippedFast: 0,
    archiveBytes: file.size,
    readMode: 'direct',
    stageTxns: 0,
    imageTxns: 0,
    timing: {
      read: 0,
      check: 0,
      parse: 0,
      decompress: 0,
      json: 0,
      convert: 0,
      stageWrite: 0,
      imageRead: 0,
      imageWrite: 0,
      backup: 0,
      commit: 0,
      total: 0,
    },
  }

  // 账本在 try 之外读/写：成功才写（finally 里不写，异常会直接抛出去）。
  const ledger = readLedger()

  try {
    // 1. 先把归档读进内存（content:// 流不能反复 slice，见 materializeArchive）。
    const readStart = performance.now()
    const { archive, mode } = await materializeArchive(file, report)
    result.readMode = mode
    result.timing.read = Math.round(performance.now() - readStart)

    // 2. 格式校验（上游实现，含 manifest 版本检查）。目录只读一次，后续全都命中缓存。
    report({ phase: '正在检查文件格式', done: null, total: null })
    const checkStart = performance.now()
    await checkArchiveFormat(archive)
    const checkEnd = performance.now()

    // 2. 先读摘要：既用于「本机有没有这条」，也用于判断「上次备份后数据有没有变」。
    const summaries = await db.loadSessionSummaries()
    /** 现有会话 id → updatedAt，用来判断「导入的这份是不是更新的」 */
    const existing = new Map<string, number>()
    for (const summary of summaries) {
      existing.set(summary.id, summary.updatedAt)
    }
    const fingerprint = historyFingerprint(summaries)
    const lastBackup = readBackupMeta()
    /** 本机数据与上次成功备份一致 → 这份备份可以直接复用 */
    const backupReusable =
      lastBackup !== null &&
      lastBackup.count === fingerprint.count &&
      lastBackup.latest === fingerprint.latest &&
      lastBackup.titles === fingerprint.titles

    /** 本次真正写进暂存的会话 id —— 只有它们引用的图片才需要保存 */
    const kept = new Set<string>()
    /** 被保留会话引用的 ZIP 条目名 → 附件 id */
    const images = new Map<string, string>()
    /** 已写入暂存的附件 id → 嗅探到的 MIME，同一张图在多个会话目录出现时只写一次 */
    const sniffed = new Map<string, string>()
    /** 本次真正写进暂存、且带图片的会话 id —— 只给它们回填 MIME */
    const imageOwners = new Set<string>()
    /** 暂存会话批写缓冲：按字节 / 条数上限提交（真机上事务提交有固定成本） */
    const sessionBatch: Session[] = []
    let sessionBatchBytes = 0
    /** 图片批写缓冲：条数或字节数到上限就提交，避免大批量图片把内存顶上去 */
    const imageBatch: { id: string; blob: Blob }[] = []
    let imageBatchBytes = 0
    /** 本批次里实际解压 + 解析的会话数（进度条用真实数据说话） */
    let parsed = 0
    let skippedFast = 0

    const parseStart = performance.now()
    await replaceHistory(
      async () => {
        /**
         * 提交当前会话批次并让出主线程。
         * 【为什么写库失败必须抛出去】暂存写失败说明存储层有问题（配额/IO），
         * 不能当成「这条会话坏了」跳过 —— 那会在用户不知情时吞掉数据。
         */
        const flushSessions = async () => {
          if (sessionBatch.length === 0) {
            return
          }
          const batch = sessionBatch.splice(0, sessionBatch.length)
          sessionBatchBytes = 0
          const started = performance.now()
          await db.putStagingSessions(batch)
          result.timing.stageWrite += Math.round(performance.now() - started)
          result.stageTxns += 1
          await yieldToPaint()
        }

        /** 提交当前图片批次并让出主线程 */
        const flushImages = async () => {
          if (imageBatch.length === 0) {
            return
          }
          const batch = imageBatch.splice(0, imageBatch.length)
          imageBatchBytes = 0
          const started = performance.now()
          await db.saveStagingFiles(batch)
          result.timing.imageWrite += Math.round(performance.now() - started)
          result.imageTxns += 1
          await yieldToPaint()
        }

        // 归档的目录表能给出精确的条目总数（含图片），进度是真实百分比。
        // 总数拿不到时退化为「已处理 N 条」。
        const archiveTotal = await countArchiveEntries(archive)
        let processed = 0
        let manifest = false
        let sawIndex = false
        let sawSession = false
        const tick = (phase: string) => {
          processed += 1
          report({ phase, done: processed, total: archiveTotal, skipped: skippedFast })
        }
        report({ phase: '正在读取归档目录', done: 0, total: archiveTotal })

        for await (const entry of readArchive(archive)) {
          const { path } = entry

          if (!manifest) {
            if (path !== MANIFEST_PATH) {
              throw new BackupError('backupUnrecognized')
            }
            checkManifest(JSON.parse(new TextDecoder().decode(await readEntryBytes(entry))))
            manifest = true
            tick('正在校验归档')
            continue
          }

          // user.json 是脱敏的账号信息，本来就不导入
          if (path === USER_PATH && !sawIndex && !sawSession) {
            await skipEntry(entry)
            tick('正在解析会话')
            continue
          }

          const sessionId = parseSessionPath(path)
          if (sessionId !== null) {
            // 账本 v2：同一份条目内容（id + CRC + 大小）已经成功导入过、且本机还有这条
            // 会话 → 不需要解压、不需要解析、不需要写库。这是重复导入的主路径。
            const known = existing.get(sessionId)
            if (ledger[`${sessionId}|${entry.crc}|${entry.size}`] && known !== undefined) {
              await entry.discard()
              result.skipped += 1
              skippedFast += 1
              tick('正在跳过已导入会话')
              continue
            }

            // 解析与分类放在 try 里：单条会话数据坏了只记 failed，不整批回滚。
            // 【注意】写暂存刻意留在 try 外面：写库失败必须中止整个导入，
            // 不能被误判成「这一条会话坏了」然后继续。
            let session: Session | undefined
            let sessionImages: Map<string, string> | undefined
            let sessionBytes = 0
            try {
              const decompressStart = performance.now()
              const bytes = await readEntryBytes(entry)
              result.timing.decompress += Math.round(performance.now() - decompressStart)
              const jsonStart = performance.now()
              const json = JSON.parse(new TextDecoder().decode(bytes))
              result.timing.json += Math.round(performance.now() - jsonStart)
              const convertStart = performance.now()
              const parsedFile = readSessionFile(json)
              // 文件名与内容 id 不一致属于归档损坏，不是「这一条跳过」能解决的
              if (parsedFile.id !== sessionId) {
                throw new Error(`会话 id 不一致：文件名 ${sessionId}，内容 ${parsedFile.id}`)
              }
              const local = toLocalSession(parsedFile)
              result.timing.convert += Math.round(performance.now() - convertStart)
              parsed += 1
              sessionBytes = bytes.length
              if (known !== undefined && local.session.updatedAt <= known) {
                // 本机这份不比导入的旧 → 留本机，绝不拿旧内容覆盖用户正在用的会话
                result.skipped += 1
                tick('正在解析会话')
                continue
              }
              session = local.session
              sessionImages = local.images
            } catch (error) {
              // ZIP 结构坏了要整批回滚；单条会话数据坏了只跳这一条
              if (error instanceof ArchiveError) {
                throw error
              }
              result.failed += 1
              if (result.errors.length < 5) {
                result.errors.push(`${sessionId}: ${(error as Error).message}`)
              }
              tick('正在写入本机会话')
              continue
            }
            if (session === undefined || sessionImages === undefined) {
              // 不可达：上面的 catch 分支已经 continue；这里只是让类型收窄
              continue
            }
            sessionBatch.push(session)
            sessionBatchBytes += sessionBytes
            if (
              sessionBatch.length >= SESSION_BATCH_SIZE ||
              sessionBatchBytes >= SESSION_BATCH_BYTES
            ) {
              await flushSessions()
            }
            sawSession = true
            kept.add(session.id)
            if (sessionImages.size > 0) {
              imageOwners.add(session.id)
            }
            for (const [imagePath, id] of sessionImages) {
              images.set(imagePath, id)
            }
            // 只记录「真正写进库」的条目；被 updatedAt 跳过的不能记，否则会把本机较新的
            // 内容挡在后续导入之外。
            ledger[`${session.id}|${entry.crc}|${entry.size}`] = true
            if (known === undefined) {
              result.added += 1
            } else {
              result.updated += 1
            }
            // 写库是整条流水线里最慢的一步，放在这里报进度最贴近真实感受
            tick('正在写入本机会话')
            continue
          }

          if (path === INDEX_PATH && !sawIndex) {
            // 只做格式校验；合并模式下 index 不再需要与导入集合一一对应
            readSessionIndex(JSON.parse(new TextDecoder().decode(await readEntryBytes(entry))))
            sawIndex = true
            tick('正在校验归档')
            continue
          }

          // 剩下的是图片。只保存「被保留的会话」引用到的那些；其余读完丢弃（也要消耗流）。
          const owner = /^chat_sessions\/([^/]+)_files\//.exec(path)?.[1]
          const id = owner !== undefined && kept.has(owner) ? images.get(path) : undefined
          if (id === undefined || sniffed.has(id)) {
            await skipEntry(entry)
            tick('正在处理附件')
            continue
          }
          const imageReadStart = performance.now()
          const data = await readEntryBytes(entry)
          result.timing.imageRead += Math.round(performance.now() - imageReadStart)
          const mimeType = imageType(data.subarray(0, 16))
          imageBatch.push({ id, blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeType }) })
          imageBatchBytes += data.length
          sniffed.set(id, mimeType)
          if (imageBatch.length >= IMAGE_BATCH_COUNT || imageBatchBytes >= IMAGE_BATCH_BYTES) {
            await flushImages()
          }
          tick('正在保存图片附件')
        }

        // 收尾：把最后不足一批的会话与图片写进去
        await flushSessions()
        await flushImages()

        if (!manifest) {
          throw new BackupError('backupUnrecognized')
        }

        // 回填附件 MIME：只改「本次新写入、且带图片」的暂存会话。
        // 现有会话不会进暂存，不存在被清空 MIME 的风险。
        if (sniffed.size > 0) {
          await db.updateStagingImageTypes(sniffed, [...imageOwners])
        }

        // 解析结束。现在才决定要不要备份 —— 只有确实要写正式表时才付这笔钱。
        const parseEnd = performance.now()
        result.timing.parse = Math.round(parseEnd - parseStart)

        if (!isNativeShell()) {
          // 浏览器 / PWA 没有写 Documents 的能力，也走不到合并导入；测试里直接调用
          // mergeImport 时同样跳过备份（与 0.2.4 的 isNativeShell 分支一致）。
          result.backupSkipped = 'disabled'
        } else if (!isAutoBackupEnabled()) {
          result.backupSkipped = 'disabled'
        } else if (summaries.length === 0) {
          result.backupSkipped = 'empty'
        } else if (result.added + result.updated === 0) {
          result.backupSkipped = 'nothing'
        } else if (backupReusable) {
          result.backupSkipped = 'unchanged'
        } else {
          report({ phase: '正在备份本机现有会话', done: null, total: null })
          const backupStart = performance.now()
          result.backupPath = await backupBeforeImport(report)
          result.timing.backup = Math.round(performance.now() - backupStart)
          writeBackupMeta({
            at: Date.now(),
            count: fingerprint.count,
            latest: fingerprint.latest,
            titles: fingerprint.titles,
          })
        }
        report({ phase: '正在写入本机数据库', done: null, total: null })
      },
      // 增量提交：只把本次导入写进正式表，不清空、不复制现有数据。
      db.commitMergeStaging
    )
    result.timing.check = Math.round(checkEnd - checkStart)
    result.parsed = parsed
    result.skippedFast = skippedFast
  } finally {
    releaseWakeLock()
    result.timing.total = Math.round(performance.now() - startedAt)
    result.timing.commit = Math.max(
      0,
      result.timing.total - result.timing.check - result.timing.parse - result.timing.backup
    )
    const profile = {
      ...result.timing,
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      skippedFast: result.skippedFast,
      parsed: result.parsed,
      archiveBytes: result.archiveBytes,
      readMode: result.readMode,
      stageTxns: result.stageTxns,
      imageTxns: result.imageTxns,
    }
    window.__IMPORT_PROFILE__ = profile
    // Capacitor 会把 WebView 的 console 转发到 logcat（tag Capacitor/Console），
    // 真机排查「到底慢在哪」直接筛 [import-perf] 即可。
    // eslint-disable-next-line no-console
    console.info('[import-perf]', JSON.stringify(profile))
  }

  writeLedger(ledger)
  return result
}

/** 暴露给测试/诊断：账本当前条数与最近一次备份时间 */
export const importDiagnostics = (): { ledger: number; lastBackup: BackupMeta | null } => ({
  ledger: Object.keys(readLedger()).length,
  lastBackup: readBackupMeta(),
})

/**
 * 装到 window 上，供上游 `backup.ts` 的补丁判断「有没有原生合并导入可用」。
 * 浏览器 / PWA 里不装，上游的覆盖式导入照常工作 —— PWA 回退路线不受影响。
 */
export const installImportBridge = (): void => {
  if (!isNativeShell()) {
    return
  }
  window.__DEEP_CHAT_IMPORT__ = {
    merge: async (file: File) => {
      // 进度浮层必须在 finally 里关：导入抛错时若留在屏幕上，
      // 用户看到的是一个永远停在某个百分比的遮罩，比没有进度更糟。
      const progress = showImportProgress({ phase: '正在准备导入', done: null, total: null })
      try {
        const result = await mergeImport(file, progress.update)
        progress.close()
        // 结果页由桥自己弹：上游那边只拿到一个数字，展示不下四种统计
        await showImportResult(result)
        return result
      } catch (error) {
        progress.close()
        throw error
      }
    },
  }
}

let running = false

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
 *
 * 【为什么 export 给测试】import-test.entry.ts 要用内存里的分块桥桩把
 * 「原生分块读 → 拼 File → 合并导入」整条路径跑通，不能只测 mergeImport。
 */
export const consumePendingFile = async (): Promise<void> => {
  if (running || !isNativeShell()) {
    return
  }
  running = true
  try {
    const pending = await callNative<{ pending: boolean }>(PLUGIN_FILES, 'hasPendingFile')
    if (!pending.pending) {
      return
    }
    // 31 MB 归档分块读回来，每块一次 IPC —— 必须全程有进度，
    // 否则用户看到的还是「点了没反应」。
    const progress = showImportProgress({ phase: '正在读取导入文件', done: null, total: null })
    try {
      const archive = await readPendingArchive(progress.update)
      if (!archive) {
        progress.close()
        return
      }
      // 从文件管理器直接打开 ZIP 这条路径原本是**全静默**的：
      // 没有设置弹窗、没有按钮状态、结束才弹结果页。
      // 大归档要几分钟，用户在此期间看不到任何东西，只能以为失败 —— 必须给进度。
      const result = await mergeImport(archive, progress.update)
      progress.close()
      await showImportResult(result)
    } catch (error) {
      progress.close()
      throw error
    }
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
