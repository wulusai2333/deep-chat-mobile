/**
 * 本轮消耗面板 —— web-patches/mobile/cost/TurnCostSheet.tsx
 *
 * 【为什么要有它】
 * 官方 App 点回答下方的数据库图标，会从底部弹出「本轮消耗额度」：总额、峰谷口径、
 * 三个计费桶（命中缓存输入 / 未命中输入 / 输出）的单价·用量·金额，以及会话累计。
 * 上游没有金额，金额一律由 `pricing.ts` 按每条消息的 usage + 计费时刻重算 ——
 * 本文件只做展示，不重算任何口径（峰谷判定、token 归并都在 pricing.ts 里）。
 *
 * 【为什么挂到 document.body】
 * 面板在消息列表中间被打开，而消息气泡、markdown 内容都有各自的 transform / overflow；
 * 直接在原地 fixed 定位会被祖先的 transform 变成「相对祖先」，还会被 overflow 裁掉。
 * 渲染进 body 是唯一稳的做法（上游 Modal / Menu 同样处理）。
 *
 * 【为什么关面板要等 220ms 才通知父组件】
 * 父组件用 `open` 控制挂载，立刻卸载就没有退场动画。所以关闭时先把自己滑回屏幕外，
 * 过渡结束再调 onClose —— 下滑关闭、点遮罩、按 Esc 三条路径共用这一个出口。
 */

import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import type { ChatModel, MessageUsage } from '../../services/api/types.js'
import { useChatStore } from '../../services/chat/store.js'
import { MIconDatabase16 } from '../common/icons.js'
import { computeTurnCost, formatMoney, formatPrice, formatTokens } from './pricing.js'
import { usePricing } from './usePricing.js'
import styles from './TurnCostSheet.module.css'

/** 与 CSS 里面板位移过渡的时长保持一致；改一处必须改两处 */
const HIDE_MS = 220
/** 下滑超过这个位移就关闭（规格值） */
const DRAG_CLOSE_PX = 80
/** 页脚「刷新价格」的节流：连点不该触发多次抓取 */
const REFRESH_THROTTLE_MS = 300

/**
 * 「输入·缓存命中」拆成主标签 + 灰小字第二行（官方截图是两行排版）。
 * 键值里用「·」分隔是 i18n 侧的唯一约定；没有分隔符时整句当主标签，
 * 这样以后新增不会因为少个点就排版崩掉。
 */
const splitLabel = (text: string): { label: string; sub: string | null } => {
  const index = text.indexOf('·')
  if (index <= 0) {
    return { label: text, sub: null }
  }
  return { label: text.slice(0, index).trim(), sub: text.slice(index + 1).trim() || null }
}

export const TurnCostSheet = ({
  open,
  onClose,
  usage,
  model,
  createdAt,
  sessionId,
}: {
  open: boolean
  onClose: () => void
  usage: MessageUsage
  model: ChatModel | null
  /** 计费时刻：请求发起时间（跨峰谷边界的长回答按发起时刻结算） */
  createdAt: number
  sessionId: string
}) => {
  const t = useTranslate()
  const { table, status, refresh } = usePricing()

  // shown=false 表示面板在屏幕外（translateY(100%)），由 CSS 负责过渡
  const [shown, setShown] = useState(false)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const touchStartRef = useRef<number | null>(null)
  // 位移的「真值」放 ref：touchend 里必须拿到手指抬起那一刻的最新位移，
  // 而 state 要等下一次渲染才可见（小位移+快速抬起时可能还是 0），
  // 用 state 判断会出现「拖了很远却没关」。
  const dragRef = useRef(0)
  const lastRefreshRef = useRef(0)

  // 本轮：价表变化（抓取成功后）金额要跟着变，所以 table 进依赖
  const priced = useMemo(
    () => computeTurnCost(usage, model, createdAt, table),
    [usage, model, createdAt, table]
  )

  // 会话累计：直接读 store 的会话缓存。面板只从当前会话打开，不会读到别人的消息。
  const messages = useChatStore((state) => state.sessionCache[sessionId]?.messages)
  const sessionTotal = useMemo(() => {
    let total = 0
    for (const item of messages ?? []) {
      if (item.role !== 'assistant' || !item.usage) {
        continue
      }
      // 与「本轮」同一套算法：每条按自己的计费时刻与模型算，再求和
      const cost = computeTurnCost(item.usage, item.model, item.createdAt, table)
      if (cost) {
        total += cost.total
      }
    }
    return total
  }, [messages, table])

  /** 唯一关闭出口：先播退场动画，再让父组件卸载 */
  const requestClose = useCallback(() => {
    if (closingRef.current) {
      return
    }
    closingRef.current = true
    dragRef.current = 0
    setShown(false)
    setDragging(false)
    setDragY(0)
    hideTimerRef.current = setTimeout(onClose, HIDE_MS)
  }, [onClose])

  // 打开时先渲染在屏幕外，下一帧再切可见态 —— 首帧就是打开态的话 CSS 过渡不会播放
  useEffect(() => {
    if (!open) {
      setShown(false)
      closingRef.current = false
      return
    }
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => () => clearTimeout(hideTimerRef.current), [])

  // Esc 关闭 + 锁 body 滚动：面板是 fixed 的，底下的消息列表不能跟着滚
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const body = document.body
    // 还原「原值」而不是硬写 ''：别的浮层可能已经设过 overflow
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      body.style.overflow = previousOverflow
    }
  }, [open, requestClose])

  const handleRefresh = useCallback(() => {
    const now = Date.now()
    if (now - lastRefreshRef.current < REFRESH_THROTTLE_MS) {
      return
    }
    lastRefreshRef.current = now
    refresh()
  }, [refresh])

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    // 内容滚到中间时不抢手势；只有已经滚到顶，下滑才等于「关面板」
    if (closingRef.current || (sheetRef.current?.scrollTop ?? 0) > 0) {
      touchStartRef.current = null
      return
    }
    touchStartRef.current = event.touches[0]?.clientY ?? null
  }

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current
    const current = event.touches[0]?.clientY
    if (start === null || current === undefined) {
      return
    }
    const delta = current - start
    if (delta <= 0) {
      // 上滑不跟手：面板内容要能正常滚动
      if (dragRef.current !== 0) {
        dragRef.current = 0
        setDragging(false)
        setDragY(0)
      }
      return
    }
    dragRef.current = delta
    setDragging(true)
    setDragY(delta)
  }

  const handleTouchEnd = () => {
    touchStartRef.current = null
    const moved = dragRef.current
    dragRef.current = 0
    if (moved > DRAG_CLOSE_PX) {
      requestClose()
      return
    }
    // 没到阈值：弹回原位
    setDragging(false)
    setDragY(0)
  }

  // 钩子必须都在这里之前；open=false 时不挂载（父组件只在按钮被点过之后才会传 true）
  if (!open) {
    return null
  }

  const groups = priced
    ? [
        { key: 'cacheHit', text: t('costInputCacheHit'), bucket: priced.buckets.cacheHit },
        { key: 'cacheMiss', text: t('costInputCacheMiss'), bucket: priced.buckets.cacheMiss },
        { key: 'output', text: t('costOutput'), bucket: priced.buckets.output },
      ]
    : []

  // 算不出价格时用破折号占位：入口按钮已经挡掉绝大多数情况，剩下的是「价表里没有这个
  // 模型」之类的极端情形，此时露出外壳 + 会话累计仍然比一片空白有用。
  const totalText = priced ? formatMoney(priced.total) : '—'
  const metaParts = [`${t('costSessionTotal')} ¥${formatMoney(sessionTotal)}`]
  if (table.updatedOn) {
    metaParts.push(t('costPriceUpdatedAt', { date: table.updatedOn }))
  }

  return createPortal(
    <div
      className={clsx(styles.sheetRoot, shown && styles.rootOpen, dragging && styles.dragging)}
      data-price-status={status}
    >
      {/* 遮罩：点一下就关（与 Esc 同一出口） */}
      <div className={styles.mask} aria-hidden onClick={requestClose} />
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('costTurnTitle')}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <div className={styles.handleWrap}>
          <span className={styles.handle} aria-hidden />
        </div>

        <div className={styles.head}>
          <div className={styles.headMain}>
            <span className={styles.headIcon}>
              <MIconDatabase16 size={18} />
            </span>
            <span className={styles.headTitle}>{t('costTurnTitle')}</span>
          </div>
          <div className={styles.headTotal}>
            <span className={styles.totalNum}>{totalText}</span>
            <span className={styles.totalUnit}>元</span>
          </div>
        </div>

        {/* 模型标签从标题行挪到副标题行：393/360 宽度下「图标+标题+徽标+28px 合计」
            一行放不下，官方也是一行副标题带出模型（`按「…」价格估算 · deepseek-flash`）。
            标签保留小号 + 药丸底，只是换了位置，视觉层级不变。 */}
        <div className={styles.subtitle}>
          {priced ? (
            <>
              <span className={styles.subtitleHint}>
                {priced.peak ? t('costPeakHint') : t('costOffPeakHint')}
              </span>
              <span className={styles.subtitleDot} aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span className={styles.chip}>{priced?.modelKey ?? model ?? '—'}</span>
        </div>

        {groups.length > 0 ? (
          <div className={styles.card}>
            {groups.map((group) => {
              const { label, sub } = splitLabel(group.text)
              return (
                <div key={group.key} className={styles.group}>
                  <div>
                    <div className={styles.groupLabel}>{label}</div>
                    {sub ? <div className={styles.groupSub}>{sub}</div> : null}
                  </div>
                  <div className={styles.rows}>
                    <div className={styles.row}>
                      <span className={styles.rowLabel}>{t('costUnitPrice')}</span>
                      <span className={styles.rowValue}>
                        {formatPrice(group.bucket.pricePerMillion)} {t('costPerMillion')}
                      </span>
                    </div>
                    <div className={styles.row}>
                      <span className={styles.rowLabel}>{t('costUsageTokens')}</span>
                      <span className={styles.rowValue}>
                        {formatTokens(group.bucket.tokens)} tokens
                      </span>
                    </div>
                    <div className={styles.row}>
                      <span className={styles.rowLabel}>{t('costAmount')}</span>
                      <span className={styles.rowValue}>
                        {formatMoney(group.bucket.amount)} 元
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        <div className={styles.footer}>
          <div>{t('costContextUsed', { percent: priced ? priced.contextPercent : 0 })}</div>
          {/* 整行可点 = 刷新价表；文案本身就是「会话累计 · 价格更新于 …」 */}
          <button type="button" className={styles.footerMeta} onClick={handleRefresh}>
            {metaParts.join(' · ')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
