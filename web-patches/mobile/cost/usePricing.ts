/**
 * 峰谷价表的 React 入口 —— web-patches/mobile/cost/usePricing.ts
 *
 * 【为什么 UI 要经过这一层】
 * 价格来源有三个优先级：24h 内抓到的官方表 > 内置快照 > 无（不会出现无价格）。
 * 组件只关心「现在用哪张表、要不要提示刷新失败」，不应该各自实现抓取/缓存。
 * 这层把「首次读缓存 → 过期则后台抓一次 → 失败保留旧表」收敛成固定流程。
 *
 * 【去重与卸载】
 * - 模块级 inFlight：抽屉、消息列表、详情弹层可能同时挂载，不能让它们各抓一次。
 * - 24h 内最多成功一次：抓成功后写入缓存，后续 isStale 为 false，自然不再请求。
 * - aliveRef：后台请求可能比组件活得久，卸载后再 setState 是 React 警告来源；
 *   这里在 then/catch 里统一检查。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { FALLBACK_TABLE, type PriceTable } from './pricing.js'
import {
  fetchOfficialTable,
  isStale,
  readCachedTable,
  writeCachedTable,
} from './pricing-source.js'

export type PricingStatus = 'bundled' | 'cached' | 'fresh' | 'refreshing' | 'error'

type PricingState = { table: PriceTable; status: PricingStatus }

/** 模块级在途请求：多个组件同时过期时只发一次。 */
let inFlight: Promise<PriceTable> | null = null

/**
 * 抓一次并写缓存。成功/失败都会释放 inFlight，
 * 这样用户点「重试」时还能重新发起；失败不写缓存，isStale 仍为 true。
 */
const loadTable = (): Promise<PriceTable> => {
  if (inFlight) {
    return inFlight
  }
  const task = fetchOfficialTable().then((table) => {
    writeCachedTable(table)
    return table
  })
  inFlight = task
  void task.then(
    () => {
      inFlight = null
    },
    () => {
      inFlight = null
    }
  )
  return task
}

/** 首次状态：有缓存就用缓存（即使过期也先显示，随后后台刷新），否则内置快照。 */
const readInitialState = (): PricingState => {
  const cached = readCachedTable()
  return cached ? { table: cached, status: 'cached' } : { table: FALLBACK_TABLE, status: 'bundled' }
}

export function usePricing(): {
  table: PriceTable
  status: PricingStatus
  refresh: () => void
} {
  const [state, setState] = useState<PricingState>(readInitialState)
  // 挂载 effect 只跑一次，不能闭包捕获首帧 state；用 ref 取最新表。
  const tableRef = useRef<PriceTable>(state.table)
  tableRef.current = state.table
  const aliveRef = useRef(true)

  const run = useCallback((force: boolean) => {
    if (!force && !isStale(tableRef.current)) {
      return
    }
    setState((prev) => (prev.status === 'refreshing' ? prev : { ...prev, status: 'refreshing' }))
    loadTable().then(
      (table) => {
        if (!aliveRef.current) {
          return
        }
        setState({ table, status: 'fresh' })
      },
      () => {
        if (!aliveRef.current) {
          return
        }
        // 失败不改表：缓存/内置表仍可用于估算，只把状态标为 error 供 UI 提示。
        setState((prev) => ({ ...prev, status: 'error' }))
      }
    )
  }, [])

  useEffect(() => {
    aliveRef.current = true
    run(false)
    return () => {
      aliveRef.current = false
    }
  }, [run])

  const refresh = useCallback(() => {
    run(true)
  }, [run])

  return { table: state.table, status: state.status, refresh }
}
