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
import { replaceHistory } from '../web/src/services/chat/store.js'
import { writeArchive } from '../web/src/services/chat/history/zipWriter.js'
// 必须从 web/src/shell/ 引入，而不是 web-patches/：
// 注入后的文件在那里，导入路径（../services/...）才成立。
// 这样测的就是**实际进 APK 的那份代码**，而不是一份结构不同的副本。
import { installImportBridge, mergeImport } from '../web/src/shell/import-bridge.js'

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

  // ══ 场景 11：真机路径 —— importHistory() 内部入队 + 备份，不得死锁 ══
  //
  // 【为什么必须单独测这一条】
  // 前面 10 个场景都直接调 mergeImport()，此时 isNativeShell() 为 false，
  // 「导入前自动备份」整段被跳过。而真机上走的是上游的 importHistory()，
  // 它自己用 enqueueBackup() 排队；备份若调用同样会入队的 exportHistory()，
  // 就是「队列里的任务等一个排在它后面的任务」，队列永不前进。
  // 这个 bug 实际发生过：真机导入卡死、0 条会话进库，而 31 项测试全绿。
  // 所以这里伪造 window.Capacitor 让 isNativeShell() 为 true，走真实路径。
  const nativeCalls = []
  ;(globalThis as any).Capacitor = {
    nativePromise: async (plugin: string, method: string) => {
      nativeCalls.push(`${plugin}.${method}`)
      return method === 'saveBackup' ? { path: '/fake/deep-chat-backup.zip' } : {}
    },
  }
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
    nativeCalls.includes('DeepChatFiles.saveBackup'),
    '场景11 导入前确实调用了原生备份',
    nativeCalls
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
