/**
 * 移动端顶栏（上游同名组件，移动端专用）—— fork：web-patches/mobile/overrides/session/MobileHeader.tsx
 *
 * 上游这里的实现是「图标 + 标题 + 新建」；本次改版按官方 App 重做，实际渲染
 * 移动端覆盖层里的 `src/mobile/topbar/MobileTopBar.tsx`（汉堡 + 标题 + 朗读 + 新建）。
 *
 * 保留本组件与原导出名，是因为上游 App.tsx / Welcome.tsx / SessionView.tsx 都通过
 * `./MobileHeader.js` 引入；桌面端从不渲染它，所以这里不需要 isMobile 分支。
 */

import type { Session } from '../../services/chat/types.js'
import { MobileTopBar } from '../../mobile/topbar/MobileTopBar.js'

export const MobileHeader = ({ title, session }: { title?: string; session?: Session }) => (
  <MobileTopBar title={title} session={session} />
)
