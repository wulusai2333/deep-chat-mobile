/**
 * 合并导入的端到端测试入口（在浏览器里跑）。
 *
 * 由 scripts/test-import.mjs 打包成 IIFE 后注入无头 Chrome，
 * 用真实的 IndexedDB / Blob / File / zip 读写跑完整流程。
 *
 * 输出汇总挂在 window.__TEST_RESULT__，由外面的 Node 脚本读 console。
 */

import * as db from '../web/src/services/chat/db.js'
import { exportHistorySnapshot, importHistory } from '../web/src/services/chat/backup.js'
import { replaceHistory, useChatStore } from '../web/src/services/chat/store.js'
import { writeArchive } from '../web/src/services/chat/history/zipWriter.js'
// 必须从 web/src/shell/ 引入，而不是 web-patches/：
// 注入后的文件在那里，导入路径（../services/...）才成立。
// 这样测的就是**实际进 APK 的那份代码**，而不是一份结构不同的副本。
import { consumePendingFile, installImportBridge, mergeImport } from '../web/src/shell/import-bridge.js'
import type { Session } from '../web/src/services/chat/types.js'

const log = (message) => console.log(`[test] ${message}`)

const results = []
const check = (ok, label, extra) => {
  results.push({ ok, label, extra })
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`)
}

// ── 构造归档 ──────────────────────────────────────────────────────────────

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const base64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

/** Uint8Array → base64，模拟原生桥每块返回的字符串（分块读路径用） */
const bytesToBase64 = (bytes) => {
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** 造一条消息 */
const msg = (id, parentId, role, text, insertedAt, files) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: insertedAt,
  fragments:
    role === 'USER'
      ? [
          { type: 'REQUEST', content: text },
          ...(files && files.length > 0 ? [{ type: 'FILE', files }] : []),
        ]
      : [{ type: 'RESPONSE', content: text }],
})

/** 造一个会话 JSON（归档格式） */
const sessionFile = ({ id, title, updatedAt, messages }) => ({
  id,
  title,
  pinned: false,
  current_message_id: messages[messages.length - 1]?.id ?? 0,
  inserted_at: messages[0]?.inserted_at ?? updatedAt,
  updated_at: updatedAt,
  messages,
})

/** 把会话列表打成合规 ZIP（manifest → sessions → index → images） */
const makeArchive = async (sessions, imagesBySession = new Map()) => {
  const entries = [
    { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
  ]
  for (const session of sessions) {
    entries.push({
      name: `chat_sessions/${session.id}.json`,
      blob: new Blob([JSON.stringify(session)]),
    })
  }
  entries.push({
    name: 'chat_session_index.json',
    blob: new Blob([
      JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          title: s.title,
          pinned: false,
          message_count: s.messages.length,
          inserted_at: s.inserted_at,
          updated_at: s.updated_at,
        }))
      ),
    ]),
  })
  for (const [sessionId, images] of imagesBySession) {
    for (const [fileName, bytes] of images) {
      entries.push({
        name: `chat_sessions/${sessionId}_files/${fileName}`,
        blob: new Blob([bytes], { type: 'application/octet-stream' }),
      })
    }
  }
  const blob = await writeArchive(entries)
  return new File([blob], 'test.zip', { type: 'application/zip' })
}

// ── 测试 ──────────────────────────────────────────────────────────────────

const T1 = '2026-11-01T00:00:00.000Z'
const T2 = '2026-11-02T00:00:00.000Z'
const T3 = '2026-11-03T00:00:00.000Z'
const T4 = '2026-11-04T00:00:00.000Z'

const run = async () => {
  // 清库，从干净状态开始
  indexedDB.deleteDatabase('chat-demo')
  await new Promise((resolve) => setTimeout(resolve, 300))
  localStorage.clear()

  // ══ 场景 1：空库导入两个会话 ══
  const zipA = await makeArchive([
    sessionFile({
      id: 'sess-a',
      title: '会话 A',
      updatedAt: T2,
      messages: [
        msg(1, null, 'USER', '你好 A', T1),
        msg(2, 1, 'ASSISTANT', '回复 A', T1),
      ],
    }),
    sessionFile({
      id: 'sess-b',
      title: '会话 B',
      updatedAt: T2,
      messages: [
        msg(1, null, 'USER', '你好 B', T1),
        msg(2, 1, 'ASSISTANT', '回复 B', T1),
      ],
    }),
  ])

  const r1 = await mergeImport(zipA)
  check(r1.added === 2 && r1.updated === 0 && r1.failed === 0, '场景1 空库导入两个会话', r1)
  let summaries = await db.loadSessionSummaries()
  check(summaries.length === 2, '场景1 库里有 2 个会话', summaries.map((s) => s.id))
  const loadedA = await db.loadSession('sess-a')
  check(loadedA?.messages.length === 2, '场景1 会话 A 有 2 条消息', loadedA?.messages.length)
  check(loadedA?.messages[0].content === '你好 A', '场景1 消息内容正确', loadedA?.messages[0].content)

  // ══ 场景 2：同一个 ZIP 再导一次（幂等）══
  const r2 = await mergeImport(zipA)
  check(r2.added === 0 && r2.updated === 0 && r2.skipped === 2, '场景2 重复导入全部跳过', r2)
  summaries = await db.loadSessionSummaries()
  check(summaries.length === 2, '场景2 会话数不变', summaries.length)

  // ══ 场景 3：第三次，仍然幂等 ══
  const r3 = await mergeImport(zipA)
  check(r3.added === 0 && r3.updated === 0 && r3.skipped === 2, '场景3 第三次导入仍全部跳过', r3)
  summaries = await db.loadSessionSummaries()
  check(summaries.length === 2, '场景3 会话数仍为 2', summaries.length)

  // ══ 场景 4：导入「更新的」同名会话 → updated，且不丢已有会话 ══
  const zipB = await makeArchive([
    sessionFile({
      id: 'sess-a',
      title: '会话 A（更新）',
      updatedAt: T4,
      messages: [
        msg(1, null, 'USER', '你好 A', T1),
        msg(2, 1, 'ASSISTANT', '回复 A', T1),
        msg(3, 2, 'USER', '追加的问题', T3),
        msg(4, 3, 'ASSISTANT', '追加的回答', T3),
      ],
    }),
  ])
  const r4 = await mergeImport(zipB)
  check(r4.added === 0 && r4.updated === 1, '场景4 更新一个会话', r4)
  summaries = await db.loadSessionSummaries()
  check(summaries.length === 2, '场景4 会话数不变（未丢 sess-b）', summaries.map((s) => s.id))
  const updatedA = await db.loadSession('sess-a')
  check(updatedA?.messages.length === 4, '场景4 sess-a 现在有 4 条消息', updatedA?.messages.length)
  const stillB = await db.loadSession('sess-b')
  check(stillB !== undefined, '场景4 sess-b 仍在库中')

  // ══ 场景 5：导入「更旧的」同名会话 → 跳过，不覆盖 ══
  const zipOld = await makeArchive([
    sessionFile({
      id: 'sess-a',
      title: '会话 A（旧版本）',
      updatedAt: T1,
      messages: [msg(1, null, 'USER', '旧内容', T1)],
    }),
  ])
  const r5 = await mergeImport(zipOld)
  check(r5.added === 0 && r5.updated === 0 && r5.skipped === 1, '场景5 旧数据被跳过', r5)
  const afterOld = await db.loadSession('sess-a')
  check(afterOld?.messages.length === 4, '场景5 sess-a 未被旧数据覆盖', afterOld?.messages.length)
  check(afterOld?.title === '会话 A（更新）', '场景5 标题仍是较新的', afterOld?.title)

  // ══ 场景 6：带图片附件的导入 ══
  // 注意 export_path：toLocalSession 靠它把「ZIP 条目」关联到「附件 id」，
  // 与上游 toArchive.ts 的 imagePath(sessionId, fileId, fileName) 必须一致。
  // 第一版测试把它写成 null，于是图片不被认领、断言全挂 —— 是测试数据错，
  // 不是产品逻辑错（这也正是要跑真机路径而不是 mock 的原因）。
  const pngBytes = base64ToBytes(PNG_1PX)
  const imageEntry = 'chat_sessions/sess-img_files/file-1_pic.png'
  const zipImg = await makeArchive(
    [
      sessionFile({
        id: 'sess-img',
        title: '带图会话',
        updatedAt: T2,
        messages: [
          msg(1, null, 'USER', '看这张图', T1, [
            {
              id: 'file-1',
              file_name: 'pic.png',
              file_size: pngBytes.length,
              token_usage: null,
              inserted_at: T1,
              export_path: imageEntry,
              is_image: true,
              width: 1,
              height: 1,
            },
          ]),
          msg(2, 1, 'ASSISTANT', '看到了', T1),
        ],
      }),
    ],
    new Map([['sess-img', new Map([['file-1_pic.png', pngBytes]])]])
  )
  const r6 = await mergeImport(zipImg)
  check(r6.added === 1 && r6.failed === 0, '场景6 带图片的会话导入成功', r6)
  const imgSession = await db.loadSession('sess-img')
  const attachment = imgSession?.messages[0]?.files?.[0]
  check(attachment?.id === 'file-1', '场景6 附件 id 正确', attachment?.id)
  check(attachment?.isImage === true, '场景6 附件标记为图片', attachment?.isImage)
  check(attachment?.mimeType === 'image/png', '场景6 MIME 被嗅探为 png', attachment?.mimeType)
  const blob = await db.loadFile('file-1')
  check(blob !== undefined, '场景6 原件已存入库')
  check(blob?.size === pngBytes.length, '场景6 原件大小正确', blob?.size)

  // ══ 场景 7：合并后现有会话的 MIME 不能被抹掉 ══
  // 这是 updateStagingFileTypes 的已知坑：映射里没有的会被清成 ''
  const r7 = await mergeImport(
    await makeArchive([
      sessionFile({
        id: 'sess-other',
        title: '另一个会话',
        updatedAt: T2,
        messages: [msg(1, null, 'USER', '无关', T1)],
      }),
    ])
  )
  check(r7.added === 1, '场景7 再导入一个纯文字会话', r7)
  const imgAfter = await db.loadSession('sess-img')
  check(
    imgAfter?.messages[0]?.files?.[0]?.mimeType === 'image/png',
    '场景7 既有图片的 MIME 未被后续导入抹掉',
    imgAfter?.messages[0]?.files?.[0]?.mimeType
  )
  const blobAfter = await db.loadFile('file-1')
  check(blobAfter !== undefined, '场景7 既有图片原件仍在')

  // ══ 场景 8：ZIP 结构损坏 → 整批回滚，库不变 ══
  const before = (await db.loadSessionSummaries()).length
  const brokenZip = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.zip', {
    type: 'application/zip',
  })
  let threw = false
  try {
    await mergeImport(brokenZip)
  } catch {
    threw = true
  }
  check(threw, '场景8 损坏的 ZIP 抛错')
  const after = (await db.loadSessionSummaries()).length
  check(before === after, '场景8 库中会话数未变（整批回滚）', { before, after })

  // ══ 场景 9：单条会话数据坏了 → 只跳这一条 ══
  // 手工造一个「manifest 正确、某条会话 JSON 缺字段」的 ZIP
  const badSessions = [
    sessionFile({
      id: 'sess-good',
      title: '好的会话',
      updatedAt: T2,
      messages: [msg(1, null, 'USER', '正常', T1)],
    }),
  ]
  const entries = [
    { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
    { name: 'chat_sessions/sess-good.json', blob: new Blob([JSON.stringify(badSessions[0])]) },
    // 这条消息缺 role/status 等必填字段
    {
      name: 'chat_sessions/sess-bad.json',
      blob: new Blob([JSON.stringify({ id: 'sess-bad', title: 'x', messages: [{ id: 1 }] })]),
    },
    { name: 'chat_session_index.json', blob: new Blob([JSON.stringify([])]) },
  ]
  const mixedZip = new File([await writeArchive(entries)], 'mixed.zip', { type: 'application/zip' })
  const r9 = await mergeImport(mixedZip)
  check(r9.added === 1 && r9.failed === 1, '场景9 好的导入、坏的记为 failed', r9)
  check(r9.errors.length === 1 && r9.errors[0].includes('sess-bad'), '场景9 错误信息指出坏的会话', r9.errors)
  const goodLoaded = await db.loadSession('sess-good')
  check(goodLoaded !== undefined, '场景9 好的会话确实入库了')

  // ══ 场景 10：导出快照可被重新导入（往返一致）══
  const snapshot = await exportHistorySnapshot()
  const roundTripFile = new File([snapshot.blob], 'roundtrip.zip', { type: 'application/zip' })
  const countBefore = (await db.loadSessionSummaries()).length
  const r10 = await mergeImport(roundTripFile)
  check(r10.failed === 0, '场景10 自己的导出能重新导入', r10)
  const countAfter = (await db.loadSessionSummaries()).length
  check(countBefore === countAfter, '场景10 往返后会话数不变', { countBefore, countAfter })

  // 导出进度（0.2.4）：壳层据此画进度条。回调在每条会话被消费完后触发一次，
  // 必须单调递增，且末值等于开始时的列表条数（漏掉最后一条会让进度条停在 x/y）。
  const exportProgress: number[] = []
  await exportHistorySnapshot((done) => exportProgress.push(done))
  const exportTotal = useChatStore.getState().sessions.length
  check(
    exportProgress.length > 0 &&
      exportProgress.every((value, index) => index === 0 || value >= exportProgress[index - 1]),
    '场景10 导出进度单调递增',
    exportProgress.slice(0, 5)
  )
  check(
    exportProgress.length === exportTotal &&
      exportProgress[exportProgress.length - 1] === exportTotal,
    '场景10 导出进度条数与末值等于会话数',
    { last: exportProgress[exportProgress.length - 1], exportTotal, calls: exportProgress.length }
  )

  // 跨端兼容（0.2.4）：手机导出的 ZIP 必须能被**桌面端 chat-demo 的导入实现**读取。
  // 此刻还没有 window.__DEEP_CHAT_IMPORT__（场景 11 才装），importHistory 会走上游
  // importArchive —— 也就是桌面版「设置 → 数据 → 导入」用的同一份代码。
  // 只用自己的合并导入往返，无法证明「手机导出 → 桌面」这条迁移路径。
  const desktopImported = await importHistory(roundTripFile)
  check(
    desktopImported === countBefore,
    '场景10b 手机导出可被桌面端覆盖式导入读取',
    { desktopImported, countBefore }
  )

  // ══ 场景 11：真机路径 —— importHistory() 内部入队 + 备份，不得死锁 ══
  //
  // 【为什么必须单独测这一条】
  // 前面 10 个场景都直接调 mergeImport()，此时 isNativeShell() 为 false，
  // 「导入前自动备份」整段被跳过。而真机上走的是上游的 importHistory()，
  // 它自己用 enqueueBackup() 排队；备份若调用同样会入队的 exportHistory()，
  // 就是「队列里的任务等一个排在它后面的任务」，队列永不前进。
  // 这个 bug 实际发生过：真机导入卡死、0 条会话进库，而 31 项测试全绿。
  // 所以这里伪造 window.Capacitor 让 isNativeShell() 为 true，走真实路径。
  /** 内存里的原生桥桩：分块备份上传 + 分块文件读取都在这里模拟 */
  const installNativeStub = (
    pendingBytes?: Uint8Array,
    stubOptions: { failAppendAt?: number } = {}
  ) => {
    const calls: string[] = []
    const backup = {
      begin: false,
      chunks: 0,
      bytes: 0,
      finished: false,
      aborted: false,
      appends: 0,
    }
    const uploads = new Map<string, { chunks: number; bytes: number }>()
    let nextUpload = 0
    const pending = pendingBytes === undefined ? null : { bytes: pendingBytes, offset: 0 }
    ;(globalThis as any).Capacitor = {
      nativePromise: async (_plugin: string, method: string, args: any) => {
        calls.push(method)
        const options = args ?? {}
        switch (method) {
          case 'hasPendingFile':
            return { pending: pending !== null }
          case 'openPendingFile':
            if (!pending) {
              return { name: null }
            }
            pending.offset = 0
            return { handle: 'stub-handle', name: 'stub.zip', size: pending.bytes.length }
          case 'readPendingFileChunk': {
            if (!pending) {
              throw new Error('readPendingFileChunk without pending file')
            }
            const offset = Number(options.offset)
            const length = Number(options.length)
            const end = Math.min(offset + length, pending.bytes.length)
            const slice = pending.bytes.subarray(offset, end)
            return {
              data: bytesToBase64(slice),
              size: slice.length,
              offset,
              eof: end >= pending.bytes.length,
            }
          }
          case 'closePendingFile':
            return { closed: true }
          case 'beginBackup': {
            const uploadId = `test-upload-${++nextUpload}`
            uploads.set(uploadId, { chunks: 0, bytes: 0 })
            backup.begin = true
            return { uploadId }
          }
          case 'appendBackupChunk': {
            const upload = uploads.get(String(options.uploadId))
            if (!upload) {
              throw new Error('appendBackupChunk for unknown upload')
            }
            backup.appends += 1
            if (stubOptions.failAppendAt !== undefined && backup.appends === stubOptions.failAppendAt) {
              throw new Error('simulated native write failure')
            }
            const bytes = atob(String(options.data)).length
            upload.chunks += 1
            upload.bytes += bytes
            backup.chunks += 1
            backup.bytes += bytes
            return { written: backup.bytes }
          }
          case 'finishBackup':
            backup.finished = true
            return { path: '/fake/deep-chat-backup.zip' }
          case 'abortBackup':
            backup.aborted = true
            return { aborted: true }
          default:
            return {}
        }
      },
    }
    return { calls, backup }
  }

  const stub = installNativeStub()
  // 桥在模块加载时按 isNativeShell() 决定装不装；此刻补 Capacitor 已经晚了，
  // 必须再装一次，否则 importHistory 会回退到上游覆盖逻辑，测不到合并路径。
  installImportBridge()

  // 用一个**合规**的归档（空归档会被 checkArchiveFormat 正确拒绝，
  // 那样测到的就是「格式校验通过了吗」而不是死锁，方向全错）
  const zipForNative = await makeArchive([
    sessionFile({
      id: 'sess-native',
      title: '真机路径会话',
      updatedAt: T4,
      messages: [msg(1, null, 'USER', '真机导入', T4)],
    }),
  ])
  // 给 promise 套超时：死锁和「慢」在结果上都是「没结束」，必须能区分开
  const withTimeout = async (promise: Promise<unknown>, ms: number): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__TIMEOUT__'), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
  const nativeOutcome = await withTimeout(importHistory(zipForNative), 20000)
  check(
    nativeOutcome !== '__TIMEOUT__',
    '场景11 真机路径 importHistory 不死锁（20s 内返回）',
    nativeOutcome === '__TIMEOUT__' ? '超时，疑似 enqueueBackup 自死锁' : 'ok'
  )
  check(
    stub.calls.includes('beginBackup') &&
      stub.calls.includes('appendBackupChunk') &&
      stub.calls.includes('finishBackup'),
    '场景11 导入前备份走分块协议（begin/append/finish）',
    stub.calls.filter((call) => call.toLowerCase().includes('backup'))
  )
  check(
    stub.backup.finished && !stub.backup.aborted && stub.backup.chunks > 0,
    '场景11 备份分块全部上传并正常收尾',
    { chunks: stub.backup.chunks, bytes: stub.backup.bytes }
  )
  check(
    stub.backup.chunks === Math.ceil(stub.backup.bytes / (256 * 1024)),
    '场景11 分块大小不超过 256 KB（桥负载上限）',
    { chunks: stub.backup.chunks, bytes: stub.backup.bytes }
  )
  delete (globalThis as any).Capacitor

  // ══ 场景 12：外部打开 ZIP 的分块读取路径（open/readChunk/close）══
  //
  // 【为什么必须有】前面所有场景拿到的都是已经拼好的 File。真机上 File 是
  // 「原生逐块 base64 → JS 拼 Blob」出来的：这条路径不测，等于没测用户真正的入口。
  // 这里用内存里的 ZIP 做原生桩，走真实的 consumePendingFile()。
  const chunkZip = await makeArchive([
    sessionFile({
      id: 'sess-chunked',
      title: '分块读取会话',
      updatedAt: T4,
      messages: [
        // 300 KB 正文：STORE（不压缩）ZIP 因此超过 256 KB，会分成多块读，
        // 才能真正验证「逐块拼 Blob」而不是碰巧一块读完。
        msg(1, null, 'USER', 'a'.repeat(300 * 1024), T4),
      ],
    }),
  ])
  const chunkZipBytes = new Uint8Array(await chunkZip.arrayBuffer())
  const chunkStub = installNativeStub(chunkZipBytes)
  installImportBridge()
  // consumePendingFile 内部会弹进度与结果页；headless 下 DOM 可用
  await consumePendingFile()
  const readCalls = chunkStub.calls.filter((call) => call === 'readPendingFileChunk').length
  check(
    chunkStub.calls.includes('hasPendingFile') &&
      chunkStub.calls.includes('openPendingFile') &&
      readCalls >= 2 &&
      chunkStub.calls.includes('closePendingFile'),
    '场景12 分块读文件路径走通（多块 readChunk + close）',
    { readCalls, calls: chunkStub.calls.slice(0, 6) }
  )
  // 多块拼接后必须仍然是完整可解析的 ZIP，内容一字不差
  const chunkedSession = await db.loadSession('sess-chunked')
  check(
    chunkedSession !== undefined &&
      chunkedSession.messages[0]?.content.length === 300 * 1024,
    '场景12 分块读进来的归档完整导入（正文长度一致）',
    chunkedSession?.messages[0]?.content.length
  )
  check(
    chunkStub.backup.chunks === 1 && chunkStub.backup.finished,
    '场景12 同一路径下的备份也走分块协议',
    { chunks: chunkStub.backup.chunks, finished: chunkStub.backup.finished }
  )
  delete (globalThis as any).Capacitor

  // ══ 场景 13：暂存辅助函数（批量写 / 游标收集 / 定向回填）══
  //
  // 真实归档 593 条会话让这几条路径上了真机：
  //   • putStagingSessions —— 批量事务代替逐条事务；
  //   • collectStagingFileTypes —— 游标遍历代替 getAll（内存峰值）；
  //   • updateStagingImageTypes —— 只改带图片的会话，不再全量扫描。
  const fakeSession = (id: string, files: { id: string; mimeType: string }[]) => ({
    id,
    title: id,
    createdAt: T1,
    updatedAt: T2,
    rootMessageId: '1',
    messages: [
      {
        id: '1',
        role: 'user',
        createdAt: T1,
        content: id,
        parentId: null,
        files: files.map((file) => ({
          id: file.id,
          serverId: null,
          name: `${file.id}.png`,
          size: 1,
          isImage: true,
          mimeType: file.mimeType,
        })),
      },
    ],
  })
  const helperSessions = [
    fakeSession('helper-a', [{ id: 'helper-file-a', mimeType: 'image/png' }]),
    fakeSession('helper-b', [{ id: 'helper-file-b', mimeType: '' }]),
  ] as unknown as Session[]
  await db.clearStaging()
  await db.putStagingSessions(helperSessions)
  const collected = await db.collectStagingFileTypes()
  check(
    collected.get('helper-file-a') === 'image/png' && !collected.has('helper-file-b'),
    '场景13 游标收集附件类型（批量写入的记录可读）',
    [...collected.entries()]
  )
  await db.updateStagingImageTypes(new Map([['helper-file-b', 'image/jpeg']]), ['helper-b'])
  const updatedTypes = await db.collectStagingFileTypes()
  check(
    updatedTypes.get('helper-file-b') === 'image/jpeg' &&
      updatedTypes.get('helper-file-a') === 'image/png',
    '场景13 定向回填只改指定会话且不影响其他会话',
    [...updatedTypes.entries()]
  )
  await db.clearStaging()

  // ══ 场景 14：备份分块上传中途失败 → abort 清理，导入中止 ══
  //
  // 真机上「备份写失败」必须保证两件事：临时文件被 abort 删掉、正式数据没被动过。
  // 这里让原生桩在第一次 append 时抛错，验证 JS 侧的 catch 清理路径。
  const abortStub = installNativeStub(undefined, { failAppendAt: 1 })
  installImportBridge()
  const beforeAbort = (await db.loadSessionSummaries()).length
  const abortZip = await makeArchive([
    sessionFile({
      id: 'sess-aborted',
      title: '备份失败不应导入',
      updatedAt: T4,
      messages: [msg(1, null, 'USER', '这条不该进库', T4)],
    }),
  ])
  let abortThrew = false
  try {
    await mergeImport(abortZip)
  } catch {
    abortThrew = true
  }
  check(abortThrew, '场景14 备份分块失败时导入中止（抛错）')
  check(
    abortStub.backup.aborted && !abortStub.backup.finished,
    '场景14 备份失败时调用 abort 清理临时上传',
    { aborted: abortStub.backup.aborted, finished: abortStub.backup.finished }
  )
  const afterAbort = (await db.loadSessionSummaries()).length
  check(
    beforeAbort === afterAbort && (await db.loadSession('sess-aborted')) === undefined,
    '场景14 备份失败不产生半截数据（正式会话数不变）',
    { beforeAbort, afterAbort }
  )
  delete (globalThis as any).Capacitor

  // ══ 汇总 ══
  const failed = results.filter((r) => !r.ok)
  log(
    `SUMMARY ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`
  )
  if (failed.length > 0) {
    log(`FAILED: ${failed.map((f) => f.label).join(' | ')}`)
  }
  window.__TEST_RESULT__ = { total: results.length, failed: failed.length, results }
}

run().catch((error) => {
  log(`ERROR ${error?.stack ?? error}`)
  window.__TEST_RESULT__ = { total: 1, failed: 1, results: [{ ok: false, label: String(error) }] }
})
