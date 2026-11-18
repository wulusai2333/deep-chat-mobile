/**
 * 上游 `src/services/chat/backup.ts` 的补丁说明 —— 对应 scripts/prepare-web.mjs 里的
 * 「mobile-shell: backup queue」与「mobile-shell: merge import」两处替换。
 *
 * 【为什么要动 backup.ts】
 * 1. `enqueueBackup()` 把「导入 / 导出 / 全部删除」串行化，避免读归档时数据被清空、
 *    或两个替换事务交错。合并导入也必须走这条队列，否则会出现「导出读到一半被合并写掉」。
 * 2. 但合并流程内部要先调一次导出做备份。如果直接调对外的 `exportHistory()`，
 *    它本身又会 `enqueueBackup(...)` —— 在队列任务里 await 队列任务 = 自己等自己，死锁。
 * 所以把导出的实现体抽成 `exportHistorySnapshot()`（不入队），
 * 对外的 `exportHistory()` 仍是 `enqueueBackup(exportHistorySnapshot)`，行为完全不变。
 * 合并流程调 snapshot 版，安全地待在同一个队列任务里。
 *
 * 【为什么把 importHistory 改成委派给 window.__CHAT_DEMO_IMPORT__】
 * 这是唯一能同时满足「不改上游 UI 组件」和「换掉导入语义」的位置：
 * SettingsDialog 只调 `importHistory(file)` 拿一个数字，内部换成合并还是覆盖它不关心。
 * 桥不存在时（理论上不会，因为桥在浏览器里也装）走原来的覆盖实现，属于安全回退。
 */

// ── 改动 1：导出实现体抽出，不入队 ──────────────────────────────────────────
export const exportHistorySnapshot = async (): Promise<{ name: string; blob: Blob }> => {
  // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
  const { sessions, sessionCache } = useChatStore.getState()
  async function* readSessions(): AsyncGenerator<Session> {
    for (const summary of sessions) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      if (!session) {
        throw new Error(`History session disappeared during export: ${summary.id}`)
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

// ── 改动 2：导入委派给合并桥 ────────────────────────────────────────────────
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const bridge = window.__CHAT_DEMO_IMPORT__
    if (bridge) {
      // 合并导入：返回「新增 + 更新」的数量，与上游「已导入 N 个对话」的提示兼容
      const result = await bridge.merge(file)
      return result.added + result.updated
    }
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file))
  })
