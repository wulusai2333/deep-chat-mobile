/**
 * 移动端顶栏 —— web-patches/mobile/topbar/MobileTopBar.tsx
 *
 * 官方 App 的顶栏（欢迎页与会话页共用，见 docs/mobile-ui-spec.md §2.2）：
 *   左：汉堡（打开抽屉）
 *   中：会话标题（只有会话页有；单行省略）
 *   右：朗读（读当前会话最后一条有正文的助手回答） + 新建对话
 *
 * 【为什么朗读按钮放在顶栏而不是每条回答下面】
 * 官方 App 只在顶栏放一个喇叭，读「当前这条回答」。上游桌面版是每条回答一个
 * ReadAloudButton；移动端改为顶栏一个入口，但复用的仍是同一套
 * `toggleReadAloud` / `useReadAloud`，不另写一套播放逻辑。
 *
 * 【朗读中是「同一个喇叭变蓝」，不是换图标】
 * 官方 App 的可见反馈只有颜色：朗读中（loading / playing）喇叭变成品牌蓝，
 * 再点一次即停止，所以按钮必须始终显示喇叭本身（早期版本会换成 16px 的
 * ReadingBars，用户既看不出状态、也找不到关闭入口）。
 * 同时用 aria-pressed / data-reading 暴露开关态，别只靠颜色（色弱用户与验收脚本）。
 *
 * 【没有可读内容时按钮 disabled 但仍显示】
 * 欢迎页（或空会话）没有助手回答，按官方截图喇叭照样出现，只是不可点。
 * 因此这里不隐藏按钮，只加 disabled。
 */

import clsx from 'clsx'
import { showToast } from '../../components/base/toastState.js'
import { openMobileSider } from '../../components/sider/mobileSiderState.js'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { newChat } from '../../services/chat/store.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import type { Session } from '../../services/chat/types.js'
import { MIconMenu, MIconPlusCircle, MIconSpeaker } from '../common/icons.js'
import styles from './MobileTopBar.module.css'

/** 可朗读的回复：消息 id + 正文纯文本 */
type ReadableReply = { messageId: string; text: string }

/**
 * 取当前会话**最后一条正文非空的助手回复**。
 *
 * - 只沿当前选中的分支往回找（getVisibleMessages，和消息列表展示的是同一条链）：
 *   用户切换过回答版本时，`session.messages` 里最后一条可能是没显示出来的旧分支。
 * - 从末尾往前找：最后一条 assistant 可能还在流式接收、正文为空（或只有思考/工具块），
 *   那种情况朗读没有意义，继续往前找上一条有正文的回答。
 * - 正文按上游的规则由 `blocks` 里所有 text 块拼接（见 services/chat/view.ts
 *   的 joinTextBlocks：服务端会把同一段正文拆成多个 text 块，直接相连即可）。
 * - `isTemplate` 块是服务端提示文案，不属于模型回答，不参与朗读。
 */
const findReadableReply = (session: Session | undefined): ReadableReply | null => {
  if (!session) {
    return null
  }
  const messages = getVisibleMessages(session)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    let text = ''
    for (const block of message.blocks) {
      if (block.type === 'text' && !block.isTemplate) {
        text += block.text
      }
    }
    const trimmed = text.trim()
    if (trimmed.length > 0) {
      return { messageId: message.id, text }
    }
  }
  return null
}

export const MobileTopBar = ({ title, session }: { title?: string; session?: Session }) => {
  const t = useTranslate()
  const reply = findReadableReply(session)
  // 只有「正在朗读这条回复」才算播放态；切换到别的会话时自然回到 idle。
  const readStatus = useReadAloud((state) =>
    reply !== null && state.messageId === reply.messageId ? state.status : 'idle'
  )
  const reading = readStatus !== 'idle'

  return (
    <div className={styles.topbar}>
      <button
        type="button"
        className={styles.action}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      >
        <MIconMenu />
      </button>
      {title === undefined ? null : <div className={styles.title}>{title}</div>}
      <div className={styles.actions}>
        <button
          type="button"
          className={clsx(styles.action, reading && styles.active)}
          aria-label={reading ? t('ttsStop') : t('ttsPlay')}
          aria-pressed={reading}
          data-reading={reading ? 'true' : 'false'}
          disabled={reply === null}
          onClick={() => {
            if (reply === null) {
              return
            }
            // 必须在点击事件里同步调用：AudioContext 需要用户手势才能出声。
            // 同一条再点一次 = 停止（toggleReadAloud 内部处理），所以这里不另设状态。
            toggleReadAloud(reply.messageId, reply.text, (error) =>
              showToast(describeReadAloudError(error))
            )
          }}
        >
          <MIconSpeaker />
        </button>
        <button
          type="button"
          className={styles.action}
          aria-label={t('newChat')}
          onClick={newChat}
        >
          <MIconPlusCircle />
        </button>
      </div>
    </div>
  )
}
