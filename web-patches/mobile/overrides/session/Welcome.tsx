import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileChatInput } from '../../mobile/chatinput/MobileChatInput.js'
import { WhaleLogo } from '../../mobile/common/logo.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/**
 * 新对话：问候语 + 输入框。
 *
 * 桌面端保持上游原样（居中问候语 + 桌面输入框）。
 * 移动端按官方 App（docs/mobile-ui-spec.md §2.3）：顶栏 + 鲸鱼 logo + 问候语居中偏上、
 * 输入框吸底；不显示「内容由 AI 生成」的 caveat。
 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  if (isMobile) {
    return (
      <div className={styles.mobile}>
        <MobileHeader />
        <div className={styles.mobileHero}>
          <div className={styles.mobileLogo}>
            <WhaleLogo size={42} />
          </div>
          <div className={styles.mobileGreeting}>{t('welcomeBackGreeting')}</div>
        </div>
        <div className={styles.mobileComposer}>
          <MobileChatInput sessionId={null} />
        </div>
      </div>
    )
  }
  return (
    <div className={styles.container}>
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
      </div>
    </div>
  )
}
