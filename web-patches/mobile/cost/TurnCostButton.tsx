/**
 * 「本轮消耗额度」入口按钮 —— web-patches/mobile/cost/TurnCostButton.tsx
 *
 * 【为什么要有它】
 * 官方 App 在最后一条回答的动作栏最左侧放了一个数据库图标，点开是本轮 token
 * 消耗与费用明细。上游没有这个能力，这里把「能不能计价」与「面板开关」收在一个
 * 组件里，交给 `AssistantMessage.tsx` 里一行 JSX（prepare-web 的 insertOnce）使用。
 *
 * 【为什么先判 isMobile 再判 usage】
 * 桌面端必须零变化：非移动端直接返回 null，连图标都不渲染。桌面端的消息动作栏
 * 由上游自己维护，任何尺寸/间距变化都会破坏「桌面 UI 与上游一致」的验收项。
 *
 * 【为什么 priced 为 null 就整块不渲染】
 * 计价需要「用量 + 模型 + 价格表」三样齐全：历史导入的消息没有 usage、
 * 模型名不在价表里、时间戳缺失都可能算不出价格。此时露出一个点开空白的图标
 * 比不露出更糟，所以直接隐藏入口。
 */

import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { MIconDatabase16 } from '../common/icons.js'
import { computeTurnCost } from './pricing.js'
import { TurnCostSheet } from './TurnCostSheet.js'
// 入口按钮与面板共用一份样式表，理由见 TurnCostSheet.module.css 顶部注释
import styles from './TurnCostSheet.module.css'

export const TurnCostButton = ({
  message,
  sessionId,
  isLast,
}: {
  message: AssistantMessage
  sessionId: string
  isLast: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  // 桌面端、非最后一条、没有用量：都不需要这个入口
  if (!isMobile || !isLast || !message.usage) {
    return null
  }
  // 不传价表 = 用内置价表判断「这个模型能不能计价」；面板里再用在线/缓存价表细化
  if (!computeTurnCost(message.usage, message.model, message.createdAt)) {
    return null
  }

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t('costOpen')}
        onClick={() => setOpen(true)}
      >
        <MIconDatabase16 />
      </button>
      {/* 第一次点开才挂载面板：usePricing 在挂载时可能触发一次抓价，
          没人打开过的会话不该为此付代价。关闭时要等面板自己的退场动画走完
          才把 open 置 false（见 TurnCostSheet 的 requestClose）。 */}
      {open ? (
        <TurnCostSheet
          open
          onClose={() => setOpen(false)}
          usage={message.usage}
          model={message.model}
          createdAt={message.createdAt}
          sessionId={sessionId}
        />
      ) : null}
    </>
  )
}
