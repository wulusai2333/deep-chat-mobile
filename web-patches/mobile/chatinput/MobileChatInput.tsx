/**
 * 移动端输入框 —— web-patches/mobile/chatinput/MobileChatInput.tsx
 *
 * 官方 App 风格（docs/mobile-ui-spec.md §2.4 / §2.5 / §2.6）：
 *   ┌──────────────────────────────────────────────┐
 *   │ [草稿附件行]                                 │
 *   │ 发消息或按住说话 / 按住说话大区 + 分隔线      │
 *   │ (深度思考)(智能搜索)              (⊕)(麦克风) │
 *   └──────────────────────────────────────────────┘
 *   [附件面板：最近图片行 + 拍照/相册/文件]           ← 仅打开时
 *
 * 【只做视觉层，业务逻辑全部复用上游】
 * 草稿（useDrafts/getDraft/setDraftText）、上传（addDraftFiles/useUploads/
 * prepareDraftMessage）、发送（sendMessage/stopReply/ensureApiKey）、
 * 语音（useVoiceInput）都沿用上游 components/chatInput/ChatInput.tsx 的通路，
 * 这里不另写状态机，也不直接调 API。与桌面的差异只有三处交互：
 *   1. Enter 换行，发送只走按钮（移动端键盘的「发送」键语义在官方 App 里是换行）
 *   2. 发送后收起键盘（blur），而不是把焦点留在输入框
 *   3. 麦克风按钮进入「按住说话」模式，而不是点击开始/结束的 oneshot
 */

import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { IconGlobeLanguageOutline14, IconThinkOutline16 } from '../../components/base/icons.js'
import { showToast } from '../../components/base/toastState.js'
import { DraftAttachments } from '../../components/chatInput/DraftAttachments.js'
import { useVoiceInput } from '../../components/chatInput/useVoiceInput.js'
import { ensureApiKey } from '../../components/settings/settingsDialogState.js'
import { useTranslate } from '../../i18n/index.js'
import { useUploads } from '../../services/attachments.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import {
  MIconArrowUp,
  MIconClose,
  MIconKeyboard,
  MIconMic,
  MIconPlusCircle,
  MIconStop,
} from '../common/icons.js'
import { MobileAttachPanel } from './MobileAttachPanel.js'
import { useRecentImages } from './useRecentImages.js'
import styles from './MobileChatInput.module.css'

/** 按住录音的最短时长（spec §2.6）：短于它就当成误触，取消并提示 */
const MIN_HOLD_MS = 600
/** 按住后向上滑超过这个距离松手 = 取消录音（releaseToSend 文案里承诺的行为） */
const SLIDE_CANCEL_DISTANCE = 60

export const MobileChatInput = ({ sessionId }: { sessionId: string | null }) => (
  // 切换会话时重置录音、面板与 DOM 状态；文字和附件由草稿服务保留。
  <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
)

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const importingHistory = useChatStore((state) => state.importingHistory)
  const thinking = useSettings((state) => state.thinking)
  const search = useSettings((state) => state.search)

  /** 附件面板（输入卡下方）是否展开 */
  const [attachOpen, setAttachOpen] = useState(false)
  /** 语音模式：输入卡第一行换成「按住说话」 */
  const [voiceMode, setVoiceMode] = useState(false)
  /** 正在按住说话（仅用于按压反馈，不影响录音状态机） */
  const [holding, setHolding] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  const focusTextarea = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }, [])

  /** 转写结果写回草稿（光标处插入），随后退出语音模式并聚焦输入框。 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    setVoiceMode(false)
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 录音入口在 pointerdown 时可能还没触发一次重渲染（权限申请是异步的），
  // 所以用 ref 保存最新状态；结束/取消时以 ref 为准，避免「按一下又松开却一直在录」。
  const statusRef = useRef(voice.status)
  statusRef.current = voice.status

  const pressRef = useRef<{ startedAt: number; startY: number; cancelled: boolean } | null>(null)

  /** 关闭语音模式；cancelRecording 用于正在录/正在转写时中止。 */
  const exitVoice = useCallback(
    (focus: boolean) => {
      setVoiceMode(false)
      pressRef.current = null
      setHolding(false)
      if (statusRef.current !== 'idle') {
        voice.cancel()
      }
      if (focus) {
        focusTextarea()
      }
    },
    [focusTextarea, voice.cancel]
  )

  // 进入/开始录音时若历史导入接管了界面，按上游做法取消录音。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 导入历史期间输入框整体锁定：收起面板与语音模式，避免留下可点入口。
  useEffect(() => {
    if (importingHistory) {
      setAttachOpen(false)
      setVoiceMode(false)
      pressRef.current = null
      setHolding(false)
    }
  }, [importingHistory])

  // 点输入框/面板以外的空白处关闭附件面板（spec §2.5）。
  useEffect(() => {
    if (!attachOpen) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return
      }
      setAttachOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [attachOpen])

  // 最近历史图片只在附件面板打开时读取。
  const recentImages = useRecentImages(attachOpen)

  // 窄屏隐藏药丸文字，避免和右侧按钮挤在一起（与上游同一套处理）。
  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }
    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }
    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  /** 拍照 / 相册 / 文件 / 历史图片共用的上传入口（与上游文件按钮同一条通路）。 */
  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }

  /** 面板里选完文件：加入草稿后关闭面板 */
  const handlePanelFiles = (files: File[]) => {
    acceptFiles(files)
    setAttachOpen(false)
  }

  /** 最近图片：本地原件已在面板打开时载入，直接加入草稿并关闭面板 */
  const handlePickImage = (file: File) => {
    acceptFiles([file])
    setAttachOpen(false)
  }

  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )

  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送。
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    // 移动端发完收起键盘，不再自动聚焦。
    textareaRef.current?.blur()
  }

  /** 麦克风入口：进入按住说话模式（真正录音在按下时才开始）。 */
  const enterVoice = () => {
    if (importingHistory) {
      return
    }
    if (!voice.available) {
      showToast({ key: 'voiceInputRequiresHttps' })
      return
    }
    setVoiceMode(true)
  }

  const startHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (importingHistory || !voice.available || statusRef.current !== 'idle') {
      return
    }
    // 录音要调转写接口，先确保有 Key（没有就按上游做法弹设置）。
    if (!ensureApiKey()) {
      return
    }
    event.preventDefault()
    pressRef.current = { startedAt: performance.now(), startY: event.clientY, cancelled: false }
    // 乐观标记：即使这次渲染还没更新 status，结束时的判断也不会退化成「再点一次」。
    statusRef.current = 'recording'
    setHolding(true)
    try {
      // 捕获指针：手指移出大区也能收到 pointerup。合成事件没有活动指针，失败可忽略。
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针已释放或不支持捕获，不影响录音状态机。
    }
    void voice.toggle()
  }

  const moveHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    if (press && !press.cancelled && event.clientY < press.startY - SLIDE_CANCEL_DISTANCE) {
      press.cancelled = true
    }
  }

  const finishHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    if (!press) {
      return
    }
    pressRef.current = null
    setHolding(false)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // 指针已经不存在（合成事件 / 指针被系统取消），无需处理。
    }
    if (press.cancelled) {
      // 上滑取消：静默丢弃本次录音。
      if (statusRef.current === 'recording') {
        voice.cancel()
      }
      return
    }
    if (performance.now() - press.startedAt < MIN_HOLD_MS) {
      // 太短：不当成一次语音输入，取消录音并提示重来。
      if (statusRef.current !== 'idle') {
        voice.cancel()
      }
      showToast({ key: 'voiceTooShort' })
      return
    }
    if (statusRef.current === 'recording') {
      // 松开 = 结束录音并转写（useVoiceInput 的 toggle 在录音中即 finish）。
      void voice.toggle()
    }
  }

  const cancelHold = () => {
    pressRef.current = null
    setHolding(false)
    if (statusRef.current !== 'idle') {
      voice.cancel()
    }
  }

  const handleAttachClick = () => {
    if (importingHistory) {
      return
    }
    if (attachOpen) {
      setAttachOpen(false)
      return
    }
    if (!ensureApiKey()) {
      // 没有 Key 时上游的做法是先弹设置窗，这里同样不展开面板。
      return
    }
    setAttachOpen(true)
  }

  const recording = voice.status === 'recording'
  const transcribing = voice.status === 'transcribing'
  const hasContent = text.trim().length > 0 || attachments.length > 0

  const voiceRow = (
    <>
      <div
        className={clsx(
          styles.voiceRow,
          holding && styles.voiceRowHolding,
          transcribing && styles.voiceRowBusy
        )}
        role="button"
        tabIndex={transcribing ? -1 : 0}
        aria-label={t('holdToTalk')}
        onPointerDown={startHold}
        onPointerMove={moveHold}
        onPointerUp={finishHold}
        onPointerCancel={cancelHold}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className={styles.voiceLabel}>
          {transcribing ? t('voiceTranscribing') : recording ? t('releaseToSend') : t('holdToTalk')}
        </span>
        {recording ? (
          <span className={styles.voiceTimer}>{t('voiceInputTimer', { seconds: voice.seconds })}</span>
        ) : null}
      </div>
    </>
  )

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.card}>
        <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />

        {voiceMode ? (
          voiceRow
        ) : (
          <div className={styles.textareaWrapper}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder={t('chatInputPlaceholderMobile')}
              rows={1}
              // 移动端不自动聚焦，避免一打开就弹出键盘
              autoFocus={false}
              disabled={importingHistory}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onMouseDown={(event) => {
                // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
                if (event.button === 0 && document.activeElement !== event.currentTarget) {
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length > 0) {
                  event.preventDefault()
                  acceptFiles(files)
                }
              }}
            />
            <div className={styles.mirror} aria-hidden>
              {`${text}\n`}
            </div>
          </div>
        )}

        <div className={styles.functionRow}>
          <div ref={togglesRef} className={styles.toggles}>
            <button
              type="button"
              className={clsx(styles.toggle, thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline16 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </div>

          <div className={styles.right}>
            {voiceMode ? (
              <>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('close')}
                  onClick={() => exitVoice(false)}
                >
                  <span className={styles.ringIcon}>
                    <MIconClose size={22} />
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('voiceInputKeyboard')}
                  onClick={() => exitVoice(true)}
                >
                  <span className={styles.ringIcon}>
                    <MIconKeyboard size={22} strokeWidth={1.7} />
                  </span>
                </button>
              </>
            ) : attachOpen ? (
              <>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('close')}
                  onClick={() => setAttachOpen(false)}
                >
                  <span className={styles.ringIcon}>
                    <MIconClose size={22} />
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('voiceInput')}
                  disabled={!voice.available || importingHistory}
                  onClick={enterVoice}
                >
                  <span className={styles.ringIcon}>
                    <MIconMic size={20} />
                  </span>
                </button>
              </>
            ) : streaming && sessionId ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('chatInputStopButtonTooltip')}
                onClick={() => {
                  stopReadAloud()
                  stopReply(sessionId)
                }}
              >
                <MIconStop size={14} />
              </button>
            ) : hasContent ? (
              <button
                type="button"
                className={clsx(styles.sendButton, !canSend && styles.sendButtonDisabled)}
                aria-label={t('send')}
                aria-disabled={!canSend}
                onClick={send}
              >
                <MIconArrowUp size={17} strokeWidth={2.4} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('addAttachment')}
                  aria-expanded={attachOpen}
                  disabled={importingHistory}
                  onClick={handleAttachClick}
                >
                  <MIconPlusCircle size={28} strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('voiceInput')}
                  disabled={!voice.available || importingHistory}
                  onClick={enterVoice}
                >
                  <span className={styles.ringIcon}>
                    <MIconMic size={20} />
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {attachOpen ? (
        <MobileAttachPanel
          images={recentImages}
          disabled={importingHistory}
          onPickImage={handlePickImage}
          onFiles={handlePanelFiles}
        />
      ) : null}
    </div>
  )
}
