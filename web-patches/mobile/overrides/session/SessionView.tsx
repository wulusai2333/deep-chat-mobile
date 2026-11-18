import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileChatInput } from '../../mobile/chatinput/MobileChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/**
 * 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底。
 *
 * 桌面端保持上游原样。
 * 移动端按官方 App（docs/mobile-ui-spec.md §2.2）：顶栏把 session 交给 MobileTopBar
 * （朗读按钮要读当前会话最后一条回答），底部换成 MobileChatInput。
 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} session={session} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          isMobile ? (
            <div className={styles.mobileInputContainer}>
              <MobileChatInput sessionId={session.id} />
            </div>
          ) : (
            <div className={styles.inputContainer}>
              <ChatInput sessionId={session.id} />
              <div className={styles.caveat}>{t('contentCaveat')}</div>
            </div>
          )
        }
      />
    </div>
  )
}
