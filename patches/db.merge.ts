/**
 * 插入到上游 `src/services/chat/db.ts` 的合并导入辅助函数。
 * 由 `scripts/prepare-web.mjs` 在锚点 `export const addStagingSession` 前插入。
 *
 * 这段代码必须**长在 db.ts 内部**（而不是另开一个模块），因为它要用到 db.ts 私有的
 * `getDB()` 与 `abortTransaction()`，也不能把连接对象导出去破坏封装。
 *
 * 新增三个函数，全部只服务于「合并导入」，上游既有函数一个都没改：
 *
 *   stageCurrentHistory()      把正式表（sessions / files）整体复制进暂存
 *   putStagingSession()        put 语义写暂存（上游的 addStagingSession 是 add，同 id 会抛错）
 *   collectStagingFileTypes()  读出暂存里已有的附件 MIME，供 updateStagingFileTypes 合并
 *
 * 【为什么需要这些】
 * 上游 commitStaging 的实现是「先 clear 正式表，再从暂存搬入」，靠这个保证原子性。
 * 也正因为如此，暂存里必须是**完整的目标状态**，而不是「要新增的那部分」。
 * 所以合并的第一步是把现有数据复制进暂存，让暂存成为并集。
 *
 * 【为什么需要 collectStagingFileTypes】
 * 上游 updateStagingFileTypes(types) 对暂存里的每个附件执行：
 *     const type = types.get(file.id) ?? ''
 *     if (file.mimeType !== type) file.mimeType = type
 * 也就是说**映射里没有的附件会被清成空字符串**。覆盖式导入时所有附件都来自本次
 * ZIP，没问题；合并时现有会话的附件不在映射里，直接调用会把老会话的图片/PDF
 * 类型抹成空串。所以调用前要把暂存里已有的 MIME 一起并进映射。
 */
export const stageCurrentHistory = async (): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['sessions', 'files', 'sessionsStaging', 'filesStaging'], 'readwrite')
  try {
    const stagingSessions = tx.objectStore('sessionsStaging')
    const stagingFiles = tx.objectStore('filesStaging')
    // 暂存可能是上次中断留下的，先清空，保证结果是「当前正式数据」的精确副本
    await stagingSessions.clear()
    await stagingFiles.clear()
    for (
      let cursor = await tx.objectStore('sessions').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      await stagingSessions.put(cursor.value)
    }
    for (let cursor = await tx.objectStore('files').openCursor(); cursor; cursor = await cursor.continue()) {
      await stagingFiles.put(cursor.value)
    }
  } catch (error) {
    // 同步抛出的错误不会让事务自动回滚，需显式中止（与 commitStaging 的处理一致）
    abortTransaction(tx)
    throw error
  }
  await tx.done
}

/** put 语义：同 id 覆盖（导入的会话比本机新时替换它），与 addStagingSession 互补 */
export const putStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).put('sessionsStaging', session)
}

/** 暂存里已有附件的 MIME（附件 id → mimeType），用于在 updateStagingFileTypes 前保住老数据 */
export const collectStagingFileTypes = async (): Promise<Map<string, string>> => {
  const types = new Map<string, string>()
  for (const session of await (await getDB()).getAll('sessionsStaging')) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        // 只收非空值：空串代表「本来就没识别出来」，不该参与映射
        if (file.mimeType) {
          types.set(file.id, file.mimeType)
        }
      }
    }
  }
  return types
}
