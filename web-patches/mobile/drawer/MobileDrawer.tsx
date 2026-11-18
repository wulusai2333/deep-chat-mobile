/**
 * 移动端抽屉面板 —— web-patches/mobile/drawer/MobileDrawer.tsx
 *
 * 官方 App 的抽屉：顶部搜索框 / 按时间分组的会话列表 / 底部账户行。
 * 视觉与交互口径见 docs/mobile-ui-spec.md §2.7。
 *
 * 【范围】
 * 只负责抽屉内部内容。抽屉的定位、宽度（--m-drawer-width）与「主界面右移」
 * 由 App 层与 overrides/sider/Sider.tsx 的 MobileSider 负责，这里不叠任何蒙层。
 *
 * 【搜索】
 * - 标题匹配同步计算（输入即出结果）；
 * - 消息正文匹配异步扫描：按会话摘要从新到旧，未加载的用 db.loadSession 读出来，
 *   最多扫 200 条、最多 50 条结果；输入变化时丢弃旧扫描（effect 清理 + 本地 token）。
 * - 搜索态不显示分组标题，平铺结果。
 *
 * 【长按】
 * 会话行按下 500ms 弹 Menu（重命名 / 删除）。菜单复用 components/base/Menu：
 * 每行本身是 Menu 的锚点，长按调用 Menu 暴露的 toggle，等价于「点一下触发器」。
 * 重命名在行内变成输入框（和上游 SessionItem 一致），删除确认沿用上游 Sider 的 Modal 逻辑。
 */

import clsx from 'clsx'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  IconDarkOutline16,
  IconEditOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
} from '../../components/base/icons.js'
import { Button } from '../../components/base/Button.js'
import { Menu, type MenuOption } from '../../components/base/Menu.js'
import { Modal } from '../../components/base/Modal.js'
import { showToast } from '../../components/base/toastState.js'
import { openSettings } from '../../components/settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from '../../components/sider/mobileSiderState.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { formatBalance, useBalance } from '../balance/useBalance.js'
import { APP_ICON_DATA_URL } from '../common/app-icon-data.js'
import { fileToAvatarDataUrl } from '../common/avatar-image.js'
import { resetLocalAvatar, setLocalAvatar, useLocalAvatar } from '../common/localAvatar.js'
import { MIconClose, MIconEllipsis, MIconSearch } from '../common/icons.js'
import { loadSession } from '../../services/chat/db.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  renameSession,
  removeSession,
  selectSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session, SessionSummary } from '../../services/chat/types.js'
import {
  setThemePreference,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import styles from './MobileDrawer.module.css'

/** 长按多久弹菜单 */
const LONG_PRESS_MS = 500
/** 搜索输入防抖 */
const SEARCH_DEBOUNCE_MS = 250
/** 正文扫描最多读多少个会话 */
const SEARCH_SCAN_LIMIT = 200
/** 最多展示多少条搜索结果 */
const SEARCH_RESULT_LIMIT = 50

const THEME_ORDER: ThemePreference[] = ['light', 'dark', 'system']

const THEME_LABEL_KEYS: Record<ThemePreference, TranslationKey> = {
  light: 'avatarMenuSettingsDialogThemeSelectLightOption',
  dark: 'avatarMenuSettingsDialogThemeSelectDarkOption',
  system: 'avatarMenuSettingsDialogThemeSelectSystemOption',
}

const nextTheme = (current: ThemePreference): ThemePreference =>
  THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]

const themeIcon = (preference: ThemePreference): ReactNode => {
  if (preference === 'light') {
    return <IconLightOutline16 />
  }
  if (preference === 'dark') {
    return <IconDarkOutline16 />
  }
  return <IconFollowsystemOutline16 />
}

/** 会话正文里是否出现关键词（用户消息正文 + 助手文本块，忽略思考块） */
const sessionMatchesText = (session: Session, needle: string): boolean =>
  session.messages.some((message) =>
    message.role === 'user'
      ? message.content.toLowerCase().includes(needle)
      : message.blocks.some(
          (block) => block.type === 'text' && block.text.toLowerCase().includes(needle)
        )
  )

type ScanState = {
  /** 这次扫描对应的关键词；和当前输入不一致说明结果过期，不能展示 */
  query: string
  status: 'scanning' | 'done'
  hits: SessionSummary[]
}

const IDLE_SCAN: ScanState = { query: '', status: 'done', hits: [] }

/** 搜索框：40px 药丸、左侧放大镜、有内容时右侧清除 */
const SearchBox = ({
  query,
  onChange,
  onClear,
}: {
  query: string
  onChange: (value: string) => void
  onClear: () => void
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={styles.searchWrap}>
      <div className={styles.search}>
        <span className={styles.searchIcon}>
          <MIconSearch size={18} />
        </span>
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="text"
          value={query}
          placeholder={t('searchConversations')}
          aria-label={t('searchConversations')}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className={styles.clearButton}
            aria-label={t('clearSearch')}
            onClick={() => {
              onClear()
              inputRef.current?.focus()
            }}
          >
            <MIconClose size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 一行会话。放在 Menu 里时由长按触发菜单，onLongPress 传 Menu 的 toggle；
 * 搜索平铺结果不需要长按，onLongPress 不传。
 */
const SessionRow = ({
  session,
  active,
  renaming = false,
  onOpen,
  onLongPress,
  onRenameEnd,
}: {
  session: SessionSummary
  active: boolean
  renaming?: boolean
  onOpen: () => void
  onLongPress?: () => void
  onRenameEnd?: () => void
}) => {
  const t = useTranslate()
  const displayTitle = session.title || t('untitledChat')
  const [pressed, setPressed] = useState(false)
  const timerRef = useRef(0)
  const longPressedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  if (renaming) {
    const finish = (title: string) => {
      onRenameEnd?.()
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        aria-label={t('sessionItemMenuRenameOption')}
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            onRenameEnd?.()
          }
        }}
      />
    )
  }

  const clearPress = () => {
    window.clearTimeout(timerRef.current)
    setPressed(false)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    longPressedRef.current = false
    startRef.current = { x: event.clientX, y: event.clientY }
    setPressed(true)
    window.clearTimeout(timerRef.current)
    // 长按回馈：撑住 500ms 才弹菜单；期间滚动/抬起都会取消
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true
      setPressed(false)
      onLongPress?.()
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = startRef.current
    if (Math.abs(event.clientX - x) > 8 || Math.abs(event.clientY - y) > 8) {
      clearPress()
    }
  }

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-current={active ? 'true' : undefined}
      className={clsx(styles.row, active && styles.rowActive, pressed && styles.rowPressed)}
      // 移动端长按会触发系统的文字选择/上下文菜单，全部拦掉
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onLongPress ? onPointerDown : undefined}
      onPointerMove={onLongPress ? onPointerMove : undefined}
      onPointerUp={onLongPress ? clearPress : undefined}
      onPointerCancel={onLongPress ? clearPress : undefined}
      onPointerLeave={onLongPress ? clearPress : undefined}
      onClick={() => {
        if (longPressedRef.current) {
          longPressedRef.current = false
          return
        }
        onOpen()
      }}
    >
      <span className={styles.rowTitle}>{displayTitle}</span>
    </div>
  )
}

/** 抽屉：搜索 + 分组会话列表（长按菜单）+ 底部账户行 */
export const MobileDrawer = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const themePreference = useSettings((state) => state.themePreference)
  const open = useMobileSider((state) => state.open)

  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [scan, setScan] = useState<ScanState>(IDLE_SCAN)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // 本地账户头像：默认 App 图标，用户可换成自己的图（存 localStorage，见 localAvatar.ts）
  const [avatarPending, setAvatarPending] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const avatarUrl = useLocalAvatar()
  const avatarCustom = avatarUrl !== APP_ICON_DATA_URL
  // 账户余额：抽屉打开时自动拉取（60s 缓存），点余额强制刷新；只存在内存里
  const apiKey = useSettings((state) => state.apiKey)
  const { state: balance, refresh: refreshBalance } = useBalance(apiKey, open)

  // 抽屉关闭后清掉搜索态：下次打开回到会话列表（官方 App 的行为），
  // 避免「点了搜索结果 → 再打开抽屉还是搜索结果」。
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebounced('')
      setScan(IDLE_SCAN)
      setRenamingId(null)
    }
  }, [open])

  // 分组标题（今天/昨天…）跨零点要自己刷新，逻辑与上游 Sider 一致
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // 250ms 防抖：输入变化时把上一次还没到点的搜索取消掉
  useEffect(() => {
    if (!query.trim()) {
      setDebounced('')
      return
    }
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // 正文异步扫描；输入再变时 effect 重跑，cancelled 让旧结果一条也进不来
  useEffect(() => {
    if (!debounced) {
      setScan(IDLE_SCAN)
      return
    }
    let cancelled = false
    const needle = debounced.toLowerCase()
    setScan({ query: debounced, status: 'scanning', hits: [] })

    const run = async () => {
      const hits: SessionSummary[] = []
      let scanned = 0
      try {
        for (const summary of useChatStore.getState().sessions) {
          if (cancelled || hits.length >= SEARCH_RESULT_LIMIT || scanned >= SEARCH_SCAN_LIMIT) {
            break
          }
          // 标题命中的会话会由同步匹配展示，正文扫描跳过它们
          if (summary.title.toLowerCase().includes(needle)) {
            continue
          }
          scanned += 1
          const cached = useChatStore.getState().sessionCache[summary.id]
          const session = cached ?? (await loadSession(summary.id))
          if (cancelled) {
            return
          }
          if (session && sessionMatchesText(session, needle)) {
            hits.push(summary)
            setScan({ query: debounced, status: 'scanning', hits: [...hits] })
          }
        }
      } catch {
        // 单条读取失败（存储异常）不影响已经找到的结果；没有结果时按「无结果」展示
      }
      if (!cancelled) {
        setScan({ query: debounced, status: 'done', hits: [...hits] })
      }
    }
    void run()

    return () => {
      cancelled = true
    }
  }, [debounced])

  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])

  const needle = query.trim()
  const needleLower = needle.toLowerCase()
  // 标题命中同步出结果（不等防抖）
  const titleHits = useMemo(
    () =>
      needleLower
        ? sessions.filter((session) => session.title.toLowerCase().includes(needleLower))
        : [],
    [sessions, needleLower]
  )
  const scanInSync = scan.query === needle
  const titleIds = useMemo(() => new Set(titleHits.map((session) => session.id)), [titleHits])
  const bodyHits = scanInSync
    ? scan.hits.filter((session) => !titleIds.has(session.id))
    : []
  const results = [...titleHits, ...bodyHits].slice(0, SEARCH_RESULT_LIMIT)
  const scanning = needle !== '' && (!scanInSync || scan.status === 'scanning')
  const searching = needle !== ''

  const openSession = (id: string) => {
    selectSession(id)
    closeMobileSider()
  }

  /** 打开系统文件选择器换头像；处理完统一压成 256×256 JPEG 再存 */
  const pickAvatar = () => {
    if (!avatarPending) {
      avatarInputRef.current?.click()
    }
  }

  const onAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 先清空 value：同一个文件连选两次也要能触发 change
    event.target.value = ''
    if (!file) {
      return
    }
    setAvatarPending(true)
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      setLocalAvatar(dataUrl)
      showToast(t('avatarUpdated'))
    } catch {
      showToast(t('avatarReadFailed'))
    } finally {
      setAvatarPending(false)
    }
  }

  const restoreAvatar = () => {
    resetLocalAvatar()
    showToast(t('avatarReset'))
  }

  const resetAvatarOption: MenuOption = {
    key: 'reset-avatar',
    label: t('resetAvatar'),
    icon: <IconTrashOutline16 />,
    onSelect: restoreAvatar,
  }

  const accountOptions: MenuOption[] = [
    {
      key: 'change-avatar',
      label: t('changeAvatar'),
      icon: <IconEditOutline16 />,
      onSelect: pickAvatar,
    },
    ...(avatarCustom ? [resetAvatarOption] : []),
    {
      key: 'settings',
      label: t('settings'),
      icon: <IconSettingsOutline16 />,
      onSelect: () => openSettings('general'),
    },
    {
      key: 'theme',
      label: `${t('theme')} · ${t(THEME_LABEL_KEYS[themePreference])}`,
      icon: themeIcon(themePreference),
      onSelect: () => setThemePreference(nextTheme(themePreference)),
    },
  ]

  // 余额展示：无 Key 整行隐藏；loading / 正常 / 余额不足 / 各类失败各一句
  const balanceStatus = apiKey === null ? 'hidden' : balance.status
  const balanceInsufficient = balance.status === 'ready' && !balance.available
  const balanceText = (() => {
    if (apiKey === null) {
      return ''
    }
    if (balance.status === 'loading') {
      return t('balanceLoading')
    }
    if (balance.status === 'ready') {
      return balance.available
        ? `${t('balanceLabel')} ${formatBalance(balance.infos) || '—'}`
        : t('balanceInsufficient')
    }
    if (balance.status === 'error') {
      if (balance.error === 'unauthorized') {
        return `${t('balanceLabel')} ${t('balanceKeyInvalid')}`
      }
      if (balance.error === 'network') {
        return `${t('balanceLabel')} ${t('balanceNetworkError')}`
      }
      return t('balanceFetchFailed')
    }
    return t('balanceLabel')
  })()

  return (
    <div className={styles.panel}>
      <SearchBox query={query} onChange={setQuery} onClear={() => setQuery('')} />

      <div className={styles.list}>
        {searching ? (
          <div className={styles.results}>
            {results.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === activeId}
                onOpen={() => openSession(session.id)}
              />
            ))}
            {scanning ? (
              <div className={styles.status} role="status">
                {t('searching')}
              </div>
            ) : null}
            {!scanning && results.length === 0 ? (
              <div className={styles.status} role="status">
                {t('searchNoResults')}
              </div>
            ) : null}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <Menu
                  key={session.id}
                  options={[
                    {
                      key: 'rename',
                      label: t('sessionItemMenuRenameOption'),
                      icon: <IconEditOutline16 />,
                      onSelect: () => setRenamingId(session.id),
                    },
                    {
                      key: 'delete',
                      label: t('delete'),
                      icon: <IconTrashOutline16 />,
                      danger: true,
                      onSelect: () => setDeleting(session),
                    },
                  ]}
                >
                  {({ toggle }) => (
                    <SessionRow
                      session={session}
                      active={session.id === activeId}
                      renaming={renamingId === session.id}
                      onOpen={() => openSession(session.id)}
                      onLongPress={toggle}
                      onRenameEnd={() => setRenamingId(null)}
                    />
                  )}
                </Menu>
              ))}
            </div>
          ))
        )}
      </div>

      <div className={styles.bottom}>
        <div
          className={styles.accountRow}
          role="button"
          tabIndex={-1}
          onClick={() => openSettings('general')}
        >
          <input
            ref={avatarInputRef}
            className={styles.avatarInput}
            type="file"
            accept="image/*"
            onChange={onAvatarChange}
          />
          <span
            className={clsx(styles.avatar, avatarPending && styles.avatarBusy)}
            role="button"
            tabIndex={0}
            aria-label={t('changeAvatar')}
            onClick={(event) => {
              // 账户行本身点击 = 打开设置；点头像要换头像，不能顺带弹设置
              event.stopPropagation()
              pickAvatar()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                pickAvatar()
              }
            }}
          >
            <img
              className={styles.avatarImage}
              src={avatarUrl}
              alt=""
              draggable={false}
              data-avatar="local"
            />
          </span>
          <span className={styles.accountText}>
            <span className={styles.accountName}>{t('localAccountName')}</span>
            {apiKey === null ? null : (
              <button
                type="button"
                className={clsx(styles.balance, balanceInsufficient && styles.balanceDanger)}
                data-balance="local"
                data-balance-status={balanceStatus}
                aria-label={t('balanceRefresh')}
                onClick={(event) => {
                  // 账户行本身点击=打开设置；点余额只刷新，不弹设置
                  event.stopPropagation()
                  refreshBalance()
                }}
              >
                {balanceText}
              </button>
            )}
          </span>
          {/* Menu 的浮层用 portal 挂到 body，但 React 事件仍沿组件树冒泡：
              在菜单项上点击会一路冒泡到账户行的 onClick（=打开设置）。
              这里用一层 span 在组件树里截断，避免「切主题顺手打开设置」。 */}
          <span className={styles.menuSlot} onClick={(event) => event.stopPropagation()}>
            <Menu options={accountOptions}>
              {({ toggle }) => (
                <button
                  type="button"
                  className={styles.moreButton}
                  aria-label={t('more')}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggle()
                  }}
                >
                  <MIconEllipsis size={20} />
                </button>
              )}
            </Menu>
          </span>
        </div>
      </div>

      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}
