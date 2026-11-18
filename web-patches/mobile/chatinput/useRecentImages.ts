/**
 * 最近历史图片 —— web-patches/mobile/chatinput/useRecentImages.ts
 *
 * 附件面板的「最近图片」行数据源：按会话更新时间从新到旧扫描本地 IndexedDB，
 * 收集用户消息里的图片附件原件（db.loadFile），最多 12 张。
 *
 * 【为什么不在渲染时直接读 db】
 * 面板只在打开时加载一次：扫描 N 个会话、读 N 个 blob，是明确的异步 IO。
 * 放到渲染路径里会让每次按键都触发一遍。这里用 enabled 控制生命周期，
 * 关闭面板即取消（cancelled 标记 + cleanup revoke object URL）。
 *
 * 【为什么直接转成 File】
 * 点选后要走和拍照/相册完全相同的上传通路（addDraftFiles 只接收 File[]），
 * 所以加载时就把 blob 还原成带文件名与 MIME 的 File，省掉点选时的二次异步。
 */

import { useEffect, useState } from 'react'
import * as db from '../../services/chat/db.js'

/** 面板最多展示的最近图片数（spec §2.5） */
const MAX_IMAGES = 12
/** 最多往前扫描多少个会话；通常最近几个会话里就有图片 */
const MAX_SESSIONS = 30

export type RecentImage = {
  /** 附件本地 id（也是消息里引用的 key），用于 React list key */
  key: string
  file: File
  /** 缩略图地址，由本 hook 统一创建并在关闭面板时回收 */
  url: string
}

/** 会话更新时间从新到旧；没有 updatedAt 的排最后。 */
const byUpdatedAtDesc = (a: { updatedAt: number }, b: { updatedAt: number }) =>
  (b.updatedAt ?? 0) - (a.updatedAt ?? 0)

export const useRecentImages = (enabled: boolean): RecentImage[] => {
  const [images, setImages] = useState<RecentImage[]>([])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const urls: string[] = []

    const load = async () => {
      try {
        const summaries = await db.loadSessionSummaries()
        const recent: RecentImage[] = []
        const seen = new Set<string>()
        for (const summary of [...summaries].sort(byUpdatedAtDesc).slice(0, MAX_SESSIONS)) {
          if (cancelled || recent.length >= MAX_IMAGES) {
            return
          }
          const session = await db.loadSession(summary.id)
          if (!session) {
            continue
          }
          // 同一会话内从最新消息往前找，保证「最近」优先。
          for (let index = session.messages.length - 1; index >= 0; index -= 1) {
            if (cancelled || recent.length >= MAX_IMAGES) {
              return
            }
            const message = session.messages[index]
            if (message.role !== 'user') {
              continue
            }
            for (let fileIndex = message.files.length - 1; fileIndex >= 0; fileIndex -= 1) {
              if (cancelled || recent.length >= MAX_IMAGES) {
                return
              }
              const file = message.files[fileIndex]
              if (!file.isImage || seen.has(file.id)) {
                continue
              }
              seen.add(file.id)
              const blob = await db.loadFile(file.id)
              if (cancelled) {
                return
              }
              if (!blob) {
                continue
              }
              const restored = new File([blob], file.name, {
                type: file.mimeType || blob.type,
              })
              const url = URL.createObjectURL(restored)
              urls.push(url)
              recent.push({ key: file.id, file: restored, url })
            }
          }
        }
        if (!cancelled) {
          setImages(recent)
        }
      } catch {
        // 最近图片只是便利入口：读不出来就不渲染这一行，不影响面板其余功能。
        if (!cancelled) {
          setImages([])
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [enabled])

  return images
}
