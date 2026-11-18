/**
 * 导入耗时分解探针 —— scripts/probe.entry.ts
 *
 * 【要回答的问题】
 * 用户实测：导入 32 MB 历史归档时「好几分钟」才静默成功/闪退，中间完全没反馈。
 * 需要知道时间/内存到底花在：备份、解压、解析、写库、还是提交。
 * 只有量出来才知道该优化哪里、进度条该按什么粒度上报。
 *
 * 【这次补了什么测量】
 *   • 峰值 JS heap（performance.memory，若浏览器没暴露就如实说明）；
 *   • 原生桥单次调用的负载体积 —— 旧实现是「整包 44 MB base64 字符串一次过桥」，
 *     新实现是「每 256 KB 一块」，这个数字直接对应「WebView 桥 + Java 堆」的爆点；
 *   • 两次导入：第一次空库（量合并本身），第二次库里有 593 条会话
 *     （量真机场景下「导入前备份」的成本 —— 这是旧实现第二个 44 MB 字符串的来源）。
 *
 * 探针不改产品代码：原生桥是内存桩，只记录调用参数，不落盘。
 */

import { installImportBridge } from '../web/src/shell/import-bridge.js'
import { exportHistorySnapshot } from '../web/src/services/chat/backup.js'
import * as db from '../web/src/services/chat/db.js'

type HeapState = {
  peakUsed: number
  limit: number
  samples: number
}

type NativeStats = {
  /** 旧协议 saveBackup 收到的 base64 字符串长度（字节数） */
  legacyBackupBase64: number
  /** 新协议单次 appendBackupChunk 的最大 base64 长度 */
  chunkMax: number
  /** 新协议分块数量与累计字节 */
  chunkCount: number
  backupBytes: number
  /** 分块上传是否按 begin → append* → finish 完整走完 */
  backupFinished: boolean
  backupAborted: boolean
}

declare global {
  interface Window {
    __PROBE__?: (file: File) => Promise<unknown>
    __PROBE_HEAP__?: HeapState | null
    __PROBE_HEARTBEAT__?: string
  }
}

const log = (message: string) => console.log(`[probe] ${message}`)

/** 阶段心跳：页面卡住时，外面的 Node 脚本能看出停在哪个阶段 */
const beat = (phase: string) => {
  window.__PROBE_HEARTBEAT__ = phase
  console.log(`[probe] >> ${phase}`)
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Chrome / WebView 暴露的非标准内存信息；没有就返回 null（不伪造） */
const heapNow = (): { used: number; limit: number } | null => {
  const memory = (
    performance as unknown as {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  if (!memory) {
    return null
  }
  return { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit }
}

const startHeapSampler = () => {
  const state: HeapState = { peakUsed: 0, limit: 0, samples: 0 }
  const sample = () => {
    const now = heapNow()
    if (!now) {
      return
    }
    state.samples += 1
    state.limit = now.limit
    if (now.used > state.peakUsed) {
      state.peakUsed = now.used
    }
  }
  // 20 ms 一次：导入过程中大部分时间在等 IndexedDB / 解压的 await 边界，
  // 定时器有机会插进来。纯同步的分配峰值仍可能被漏掉（见文档里的估算）。
  const timer = setInterval(sample, 20)
  sample()
  return {
    state,
    stop: () => {
      clearInterval(timer)
      sample()
      window.__PROBE_HEAP__ = state
    },
  }
}

/** 直接数 IndexedDB 里已提交的原件数，验证图片确实入库（探针不依赖产品代码） */
const countStoredFiles = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const tx = database.transaction('files', 'readonly')
      const count = tx.objectStore('files').count()
      count.onsuccess = () => {
        database.close()
        resolve(count.result)
      }
      count.onerror = () => reject(count.error)
    }
  })

/**
 * 原生桥内存桩。同时实现旧协议（saveBackup 整包 base64）与新协议
 * （begin / appendBackupChunk / finishBackup / abortBackup），
 * 所以同一份探针既能测修复前、也能测修复后，数字可比。
 */
const installNativeStub = (): NativeStats => {
  const stats: NativeStats = {
    legacyBackupBase64: 0,
    chunkMax: 0,
    chunkCount: 0,
    backupBytes: 0,
    backupFinished: false,
    backupAborted: false,
  }
  let nextUpload = 0
  const uploads = new Map<string, number>()

  ;(globalThis as { Capacitor?: unknown }).Capacitor = {
    nativePromise: async (_plugin: string, method: string, options?: unknown) => {
      const args = (options ?? {}) as Record<string, unknown>
      switch (method) {
        // ── 旧协议：整包 base64 ──
        case 'saveBackup': {
          const data = String(args.data ?? '')
          stats.legacyBackupBase64 = Math.max(stats.legacyBackupBase64, data.length)
          return { path: '/fake/Documents/deep-chat-backup.zip' }
        }
        // ── 新协议：分块上传 ──
        case 'beginBackup': {
          const uploadId = `upload-${++nextUpload}`
          uploads.set(uploadId, 0)
          return { uploadId }
        }
        case 'appendBackupChunk': {
          const text = String(args.data ?? '')
          if (text.length > stats.chunkMax) {
            stats.chunkMax = text.length
          }
          const bytes = Math.floor((text.length * 3) / 4)
          stats.chunkCount += 1
          stats.backupBytes += bytes
          const uploadId = String(args.uploadId ?? '')
          uploads.set(uploadId, (uploads.get(uploadId) ?? 0) + bytes)
          return { written: bytes }
        }
        case 'finishBackup': {
          stats.backupFinished = true
          return { path: '/fake/Documents/deep-chat-backup.zip' }
        }
        case 'abortBackup': {
          stats.backupAborted = true
          return { aborted: true }
        }
        default:
          return {}
      }
    },
  }
  return stats
}

/** 分块协议模拟：JS 侧把每块 base64 解码后拼 Blob，再包成 File */
const chunkedBase64DecodeToBlob = async (source: Blob, chunkSize: number): Promise<Blob> => {
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < source.size; offset += chunkSize) {
    const slice = source.slice(offset, Math.min(offset + chunkSize, source.size))
    const bytes = new Uint8Array(await slice.arrayBuffer())
    // 模拟原生：每块编码成 base64 过桥
    const CHUNK = 0x8000
    let binary = ''
    for (let index = 0; index < bytes.length; index += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
    }
    const encoded = btoa(binary)
    // 模拟 JS：解码回来拼进 Blob
    parts.push(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
  }
  return new Blob(parts, { type: 'application/zip' })
}

window.__PROBE__ = async (file: File) => {
  const marks: Record<string, number> = {}
  const t0 = performance.now()
  const t = (name: string) => {
    marks[name] = Math.round(performance.now() - t0)
  }
  const heap = startHeapSampler()
  const heapLog: Record<string, number | null> = {}
  const markHeap = (name: string) => {
    heapLog[name] = heapNow()?.used ?? null
  }

  log(`文件 ${mb(file.size)}`)
  beat('export-empty')

  // 1. 空库导出快照（基线里的固定起点；真机上这份通常不是空的）
  const empty = await exportHistorySnapshot()
  t('1_exportSnapshot')
  log(`空库导出快照 ${mb(empty.blob.size)}: ${marks['1_exportSnapshot']} ms`)

  // 2. 安装原生桥（内存桩）+ 合并导入桥
  const native = installNativeStub()
  installImportBridge()

  // 3. 第一次导入：空库 → 量「合并本身」（解析 + 写库 + 提交）
  const before = (await db.loadSessionSummaries()).length
  markHeap('beforeMerge')
  beat('merge1')
  const result = await window.__DEEP_CHAT_IMPORT__!.merge(file)
  beat('merge1-done')
  t('2_mergeImportEmptyDb')
  markHeap('afterMerge')
  const after = (await db.loadSessionSummaries()).length
  log(
    `导入(空库): ${JSON.stringify({ ...result, errors: result.errors.length })}，会话 ${before} -> ${after}，` +
      `${marks['2_mergeImportEmptyDb']} ms`
  )

  // 4. 第二次导入：库里已有 593 条 → 真机场景下的「导入前备份」
  //    旧实现会在这里做 导出 ZIP → 整包 base64 → saveBackup；新实现走分块上传。
  beat('merge2')
  const result2 = await window.__DEEP_CHAT_IMPORT__!.merge(file)
  beat('merge2-done')
  t('3_mergeImportPopulatedDb')
  markHeap('afterSecondMerge')
  log(
    `导入(有库): ${JSON.stringify({ ...result2, errors: result2.errors.length })}，` +
      `${marks['3_mergeImportPopulatedDb']} ms；备份桥负载 ` +
      `legacy=${mb(native.legacyBackupBase64)} chunks=${native.chunkCount}×max${(native.chunkMax / 1024).toFixed(0)}KB ` +
      `total=${mb(native.backupBytes)} finished=${native.backupFinished}`
  )

  // 5. 已提交的原件数（图片是否真的进了正式表）
  const storedFiles = await countStoredFiles()
  t('4_countFiles')
  log(`已提交原件(图片) ${storedFiles} 个`)

  // 6. 读一遍全部会话摘要（模拟首页列表首次渲染的成本）
  beat('loadList')
  const summaries = await db.loadSessionSummaries()
  t('5_loadList')
  markHeap('afterLoadList')
  beat('loadList-done')

  heap.stop()
  const heapPeak: HeapState | null = heap.state.samples > 0 ? heap.state : null
  log(
    heapPeak
      ? `峰值 JS heap ${mb(heapPeak.peakUsed)} / 上限 ${mb(heapPeak.limit)}（${heapPeak.samples} 次采样）`
      : '浏览器未暴露 performance.memory，无法报告峰值 JS heap'
  )
  log(`加载列表 ${summaries.length} 条: ${marks['5_loadList']} ms`)

  // 7. 技术对比（不参与上面的耗时口径，只回答「旧写法 vs 新写法各要多少内存」）：
  //    把「有 593 条会话时的导出 ZIP」分别按旧整包 base64、新 256 KB 分块编码一次。
  beat('technique-export')
  const populated = await exportHistorySnapshot()
  const populatedBytes = new Uint8Array(await populated.blob.arrayBuffer())
  t('6_exportPopulated')
  log(`有库导出快照 ${mb(populated.blob.size)}: ${marks['6_exportPopulated']} ms`)

  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < populatedBytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...populatedBytes.subarray(offset, offset + CHUNK))
  }
  const whole = btoa(binary)
  t('7_wholeBase64')
  log(`旧写法 整包 base64: ${mb(whole.length)} 字符串，${marks['7_wholeBase64']} ms`)

  const chunked = await chunkedBase64DecodeToBlob(populated.blob, 256 * 1024)
  t('8_chunkedRoundTrip')
  log(
    `新写法 256KB 分块编码+解码: ${marks['8_chunkedRoundTrip']} ms，` +
      `结果 ${mb(chunked.size)}（单块过桥字符串 ≤ ${(256 * 1024 * 4) / 3 / 1024 | 0} KB）`
  )

  t('total')
  beat('done')
  return {
    marks,
    heap: { ...heapPeak, at: heapLog },
    native: {
      legacyBackupBase64: native.legacyBackupBase64,
      chunkMax: native.chunkMax,
      chunkCount: native.chunkCount,
      backupBytes: native.backupBytes,
      backupFinished: native.backupFinished,
    },
    result,
    result2: { ...result2, errors: result2.errors.length },
    before,
    after,
    storedFiles,
    titles: summaries.slice(0, 5).map((session) => session.title),
  }
}
