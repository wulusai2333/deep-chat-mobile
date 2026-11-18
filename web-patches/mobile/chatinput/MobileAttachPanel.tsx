/**
 * 移动端附件面板 —— web-patches/mobile/chatinput/MobileAttachPanel.tsx
 *
 * 点输入框右侧 `⊕` 后展开（spec §2.5）：
 *   1. 最近历史图片行：本地历史会话里的图片附件（最多 12 张），点选 = 加入草稿并关面板
 *   2. 拍照 / 相册 / 文件 三个等宽操作块
 *
 * 三条上传路径最终都交给父组件的 acceptFiles：与桌面端附件按钮完全同一套校验、
 * 同一套上传队列（addDraftFiles），这里只负责「从哪个 input 拿到 File」。
 */

import { memo, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ACCEPT } from '../../services/attachments.js'
import { MIconCamera, MIconCheck, MIconPaperclip, MIconPhoto } from '../common/icons.js'
import type { RecentImage } from './useRecentImages.js'
import styles from './MobileAttachPanel.module.css'

export const MobileAttachPanel = memo(function MobileAttachPanel({
  images,
  disabled,
  onPickImage,
  onFiles,
}: {
  images: RecentImage[]
  /** 导入历史等全局锁定期间禁用所有入口 */
  disabled: boolean
  /** 点选最近图片：加入草稿后由父组件关闭面板 */
  onPickImage: (file: File) => void
  /** 拍照 / 相册 / 选文件：交给父组件的 acceptFiles */
  onFiles: (files: File[]) => void
}) {
  const t = useTranslate()
  const cameraRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const openPicker = (input: HTMLInputElement | null) => {
    if (!disabled) {
      input?.click()
    }
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // 允许再次选择同一个文件
    event.target.value = ''
    if (files.length > 0) {
      onFiles(files)
    }
  }

  return (
    <div className={styles.panel}>
      {images.length > 0 ? (
        <div className={styles.recentRow}>
          {images.map((image) => (
            <button
              key={image.key}
              type="button"
              className={styles.recentItem}
              aria-label={image.file.name}
              disabled={disabled}
              onClick={() => onPickImage(image.file)}
            >
              <img className={styles.recentImage} src={image.url} alt="" />
              <span className={styles.selectCircle} aria-hidden>
                <span className={styles.selectCheck}>
                  <MIconCheck />
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          disabled={disabled}
          onClick={() => openPicker(cameraRef.current)}
        >
          <MIconCamera />
          <span>{t('camera')}</span>
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={disabled}
          onClick={() => openPicker(albumRef.current)}
        >
          <MIconPhoto />
          <span>{t('album')}</span>
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={disabled}
          onClick={() => openPicker(fileRef.current)}
        >
          <MIconPaperclip />
          <span>{t('fileAttachment')}</span>
        </button>
      </div>

      {/* 拍照：移动端直接调起相机 */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handleChange}
      />
      {/* 相册：可多选 */}
      <input ref={albumRef} type="file" accept="image/*" multiple hidden onChange={handleChange} />
      {/* 文件：与桌面端同一个扩展名白名单，可多选 */}
      <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={handleChange} />
    </div>
  )
})
