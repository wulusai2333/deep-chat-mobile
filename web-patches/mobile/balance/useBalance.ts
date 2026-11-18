/**
 * 账户余额 —— web-patches/mobile/balance/useBalance.ts
 *
 * 抽屉账户行「本地用户」下面那行 `余额 ¥12.34` 的数据来源。
 *
 * 【接口】
 * DeepSeek 官方：GET {API_ORIGIN}/user/balance（Authorization: Bearer <key>），返回
 *   { is_available: boolean,
 *     balance_infos: [{ currency: 'CNY'|'USD', total_balance, granted_balance, topped_up_balance }] }
 * 金额是字符串（两位小数），这里原样展示，不做四舍五入。
 *
 * 【为什么只放内存、不持久化】
 * 余额是账号敏感信息：不写 localStorage / IndexedDB、不进导出的历史 ZIP、也不打日志。
 * 页面级模块缓存只活到 WebView 进程结束，足够做「60 秒内不重复请求」。
 *
 * 【刷新策略】
 * 抽屉打开时自动拉取，60s 内复用缓存；点击余额强制重新请求。
 * 请求带 8 秒超时；抽屉关闭 / 组件卸载时 abort，并用请求令牌丢弃过期响应，
 * 避免「关了抽屉又回来」时旧响应覆盖新状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, API_ORIGIN, request } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'

export type BalanceInfo = {
  currency: string
  /** 总可用余额（赠金 + 充值） */
  total: string
  /** 未过期赠金 */
  granted: string
  /** 充值余额 */
  toppedUp: string
}

export type BalanceErrorKind = 'unauthorized' | 'network' | 'other'

export type BalanceState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  infos: BalanceInfo[]
  /** 服务端 is_available；false 表示余额不足以继续调用 */
  available: boolean
  error: BalanceErrorKind | null
}

const IDLE: BalanceState = { status: 'idle', infos: [], available: true, error: null }
const CACHE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 8_000

/** 页面级缓存：同一个 API Key 在 60s 内不重复请求（不落盘） */
let cache: { apiKey: string; at: number; state: BalanceState } | null = null

const asAmount = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

/** 校验并归一化接口响应；格式不对返回 null（由调用方按错误处理） */
export const parseBalanceResponse = (
  body: unknown
): { available: boolean; infos: BalanceInfo[] } | null => {
  if (!body || typeof body !== 'object') {
    return null
  }
  const record = body as Record<string, unknown>
  if (typeof record.is_available !== 'boolean' || !Array.isArray(record.balance_infos)) {
    return null
  }
  const infos: BalanceInfo[] = []
  for (const item of record.balance_infos) {
    if (!item || typeof item !== 'object') {
      return null
    }
    const info = item as Record<string, unknown>
    const currency = typeof info.currency === 'string' ? info.currency : null
    const total = asAmount(info.total_balance)
    if (!currency || total === null) {
      return null
    }
    infos.push({
      currency,
      total,
      granted: asAmount(info.granted_balance) ?? '0',
      toppedUp: asAmount(info.topped_up_balance) ?? '0',
    })
  }
  return { available: record.is_available, infos }
}

const currencySymbol = (currency: string): string => {
  if (currency === 'CNY') {
    return '¥'
  }
  if (currency === 'USD') {
    return '$'
  }
  return `${currency} `
}

/** 多币种用 " / " 连接；未知币种显示 "CUR 12.34" */
export const formatBalance = (infos: readonly BalanceInfo[]): string =>
  infos.map((info) => `${currencySymbol(info.currency)}${info.total}`).join(' / ')

const toErrorKind = (error: unknown): BalanceErrorKind => {
  const condition = classifyApiError(error)
  if (condition === 'unauthorized') {
    return 'unauthorized'
  }
  return condition === 'network' ? 'network' : 'other'
}

const fetchBalance = async (apiKey: string, signal: AbortSignal): Promise<BalanceState> => {
  const response = await request(`${API_ORIGIN}/user/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError('protocol', 'invalid balance response')
  }
  const parsed = parseBalanceResponse(body)
  if (!parsed) {
    throw new ApiError('protocol', 'invalid balance response')
  }
  return { status: 'ready', infos: parsed.infos, available: parsed.available, error: null }
}

/**
 * @param apiKey 当前 API Key；为空时不请求、返回 idle
 * @param active 抽屉是否打开；关闭时中止在途请求，打开时按需拉取
 */
export const useBalance = (apiKey: string | null, active: boolean) => {
  const [state, setState] = useState<BalanceState>(() =>
    cache && cache.apiKey === apiKey ? cache.state : IDLE
  )
  const requestId = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(
    (force: boolean) => {
      if (!apiKey) {
        setState(IDLE)
        return
      }
      if (!force && cache && cache.apiKey === apiKey && Date.now() - cache.at < CACHE_TTL_MS) {
        setState(cache.state)
        return
      }
      // 令牌 + abort：只允许最后一次请求的结果落地
      const id = requestId.current + 1
      requestId.current = id
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      setState((prev) => ({ ...prev, status: 'loading', error: null }))
      fetchBalance(apiKey, controller.signal)
        .then((next) => {
          if (id !== requestId.current) {
            return
          }
          cache = { apiKey, at: Date.now(), state: next }
          setState(next)
        })
        .catch((error: unknown) => {
          if (id !== requestId.current || controller.signal.aborted) {
            return
          }
          setState({ status: 'error', infos: [], available: true, error: toErrorKind(error) })
        })
        .finally(() => window.clearTimeout(timer))
    },
    [apiKey]
  )

  // API Key 变化时丢掉旧 Key 的缓存展示（换 Key 后不能还显示上一个账号的余额）
  useEffect(() => {
    setState(cache && cache.apiKey === apiKey ? cache.state : IDLE)
  }, [apiKey])

  // 抽屉打开才拉取；关闭时中止在途请求（下次打开会重新走缓存/请求）
  useEffect(() => {
    if (!active) {
      controllerRef.current?.abort()
      return
    }
    load(false)
  }, [active, load])

  // 组件卸载时清理
  useEffect(
    () => () => {
      controllerRef.current?.abort()
    },
    []
  )

  const refresh = useCallback(() => load(true), [load])

  return { state, refresh }
}
