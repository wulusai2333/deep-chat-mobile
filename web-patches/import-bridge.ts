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
 * 第一版用 `collectStagingFileTypes()` 全量重读暂存再叠加，代价是 593 条会话 / 35 MB JSON
 * 再反序列化一次（实测堆峰值 227 MB）。现在改成 `updateStagingImageTypes(types, ids)`：
 * 现有会话是整条复制进暂存的，MIME 原样保留；只给「本次新写入、且带图片」的会话回填，
 * 结果等价但不再全量扫描。
 *
 * 【大归档为什么要分块 + 分批】
 * 用户的真实归档是 31 MB / 677 条目 / 593 条会话 / 81 张图。整包 base64 过桥、593 个单条
 * 事务、getAll 全量进堆，三者叠加会同时「慢到分钟级」和「把低端机顶到 OOM 闪退」。现在：
 *   • 备份上传与文件读入都走 256 KB 分块（原生契约见 native/file-open/README.md）；
 *   • 暂存会话/图片按批写（每批一个事务），批间让出主线程让进度条能画；
 *   • 中央目录在 zipReader 里按 File 缓存，一次导入只解析一遍。
 * 实测数据与上界估算见 docs/import-performance.md。
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
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from '../services/chat/history/zipReader.js'
import { replaceHistory } from '../services/chat/store.js'
import type { Session } from '../services/chat/types.js'
import { PLUGIN_FILES, callNative, isNativeShell } from './bridge.js'
import {
  NATIVE_CHUNK_BYTES,
  saveArchiveToDevice,
  yieldToPaint,
} from './native-backup.js'
import { showImportResult, showImportProgress, type ImportProgress } from './import-ui.js'
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

/** 进度回调：合并过程中反复调用，让界面能显示「到哪一步了」 */
export type ProgressReporter = (progress: ImportProgress) => void

declare global {
  interface Window {
    /** 上游 backup.ts 补丁检测到它就改用合并导入；浏览器里不存在 */
    __DEEP_CHAT_IMPORT__?: { merge(file: File): Promise<MergeResult> }
  }
}

const LEDGER_KEY = 'deep-chat:import-ledger'

/** 暂存会话批量写：每批条数。593 条 → 约 20–30 个事务（旧实现是 593 个）。 */
const SESSION_BATCH_SIZE = 24

/** 图片批量写：单批字节上限。图片单张最大 0.9 MB，4 MB 一批兼顾内存与事务数。 */
const IMAGE_BATCH_BYTES = 4 * 1024 * 1024

/** 图片批量写：单批条数上限（小图时避免一批塞太多记录）。 */
const IMAGE_BATCH_COUNT = 16

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

/** JSON 解析失败的会话记为单条失败，不整批回滚 */
const parseJson = async (entry: ArchiveEntry): Promise<unknown> =>
  JSON.parse(await (await readEntry(entry)).text())

/**
 * 数出归档里有多少个可读条目（不含目录项），用来算真实进度百分比。
 *
 * 【为什么不用 readArchive 数】
 * readArchive 会把每个条目**完整解压**（skipEntry 也要走 CRC 校验），
 * 为了计数再解压一遍等于让导入耗时翻倍 —— 手机上从几秒变十几秒，不能接受。
 * 归档的中央目录里本来就有全部条目，只读末尾那一段就够了。
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
 * 本身也要几秒。现在每次只取 256 KB（base64 ≤ 341 KB），逐块塞进 Blob；
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
      // 每 256 KB 一次原生往返，块间让出主线程保持界面响应
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
  return new File([blob], opened.name, { type: 'application/zip' })
}

/**
 * 合并导入主流程。
 *
 * 顺序刻意如此：
 *   1. 先校验 ZIP 格式 —— 坏文件不该触发一次全量备份（别让用户白等大文件拷贝）；
 *   2. 备份当前数据 —— 没有退路就不动数据；
 *   3. 一个 replaceHistory 事务内完成「复制现有 + 合并导入」，失败整体回滚。
 */
export const mergeImport = async (
  file: File,
  onProgress?: ProgressReporter
): Promise<MergeResult> => {
  const report: ProgressReporter = onProgress ?? (() => {})

  // 1. 格式校验（上游实现，含 manifest 版本检查）
  report({ phase: '正在检查文件格式', done: null, total: null })
  await checkArchiveFormat(file)

  // 2. 备份（仅原生壳；浏览器里交给上游原来的覆盖式导入）
  //    这一步在大归档上也要几秒，必须单独报，否则用户会以为卡在校验
  report({
    phase: isNativeShell() ? '正在备份本机现有会话' : '正在准备导入',
    done: null,
    total: null,
  })
  const backupPath = isNativeShell() ? await backupBeforeImport(report) : null

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

  /** 本次真正写进暂存、且带图片的会话 id —— 只给它们回填 MIME */
  const imageOwners = new Set<string>()
  /** 暂存会话批写缓冲：满 SESSION_BATCH_SIZE 条提交一次 */
  const sessionBatch: Session[] = []
  /** 图片批写缓冲：条数或字节数到上限就提交，避免大批量图片把内存顶上去 */
  const imageBatch: { id: string; blob: Blob }[] = []
  let imageBatchBytes = 0

  await replaceHistory(async () => {
    // 3.1 并集的底：把现有正式数据整体复制进暂存
    report({ phase: '正在备份本机现有会话', done: null, total: null })
    await db.stageCurrentHistory()

    /**
     * 提交当前会话批次并让出一帧。
     * 【为什么写库失败必须抛出去】暂存写失败说明存储层有问题（配额/IO），
     * 不能当成「这条会话坏了」跳过 —— 那会在用户不知情时吞掉数据。
     */
    const flushSessions = async () => {
      if (sessionBatch.length === 0) {
        return
      }
      const batch = sessionBatch.splice(0, sessionBatch.length)
      await db.putStagingSessions(batch)
      await yieldToPaint()
    }

    /** 提交当前图片批次并让出一帧 */
    const flushImages = async () => {
      if (imageBatch.length === 0) {
        return
      }
      const batch = imageBatch.splice(0, imageBatch.length)
      imageBatchBytes = 0
      await db.saveStagingFiles(batch)
      await yieldToPaint()
    }

    // 3.2 逐条读 ZIP
    //    归档的目录表能给出精确的条目总数（含图片），所以进度是真实百分比，
    //    而不是「假装动一下」的不确定动画。总数拿不到时退化为「已处理 N 条」。
    const archiveTotal = await countArchiveEntries(file)
    let processed = 0
    let manifest = false
    let sawIndex = false
    let sawSession = false
    const tick = (phase: string) => {
      processed += 1
      report({ phase, done: processed, total: archiveTotal })
    }
    report({ phase: '正在读取归档目录', done: 0, total: archiveTotal })
    for await (const entry of readArchive(file)) {
      const { path } = entry

      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          throw new BackupError('backupUnrecognized')
        }
        checkManifest(await parseJson(entry))
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
        // 解析与分类放在 try 里：单条会话数据坏了只记 failed，不整批回滚。
        // 【注意】写暂存刻意留在 try 外面：写库失败必须中止整个导入，
        // 不能被误判成「这一条会话坏了」然后继续。
        let session: Session | undefined
        let sessionImages: Map<string, string> | undefined
        try {
          const text = await (await readEntry(entry)).text()
          const parsed = readSessionFile(JSON.parse(text))
          // 文件名与内容 id 不一致属于归档损坏，不是「这一条跳过」能解决的
          if (parsed.id !== sessionId) {
            throw new Error(`会话 id 不一致：文件名 ${sessionId}，内容 ${parsed.id}`)
          }
          const local = toLocalSession(parsed)
          if (ledger[fingerprint(local.session)]) {
            result.skipped += 1
            tick('正在解析会话')
            continue
          }
          const known = existing.get(local.session.id)
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
        if (sessionBatch.length >= SESSION_BATCH_SIZE) {
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
        ledger[fingerprint(session)] = true
        const known = existing.get(session.id)
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
        readSessionIndex(await parseJson(entry))
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
      const data = await readEntry(entry)
      const mimeType = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
      imageBatch.push({ id, blob: new Blob([data], { type: mimeType }) })
      imageBatchBytes += data.size
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

    // 3.3 回填附件 MIME：只改「本次新写入、且带图片」的暂存会话。
    //     现有会话是整条复制进暂存的，MIME 原样保留，不需要也不应该再全量扫一遍
    //     （旧实现 getAll 593 条会话重读 35 MB JSON，是内存峰值 225 MB 的主因）。
    if (sniffed.size > 0) {
      await db.updateStagingImageTypes(sniffed, [...imageOwners])
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
    // 31 MB 归档分 129 块读回来，每块一次 IPC —— 必须全程有进度，
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
