/**
 * 官方价目页的抓取与本地缓存 —— web-patches/mobile/cost/pricing-source.ts
 *
 * 【为什么走原生 HTTP】
 * 官方价目页的 `.md` 是纯静态文本（HTTP 200 / text/markdown），但**没有 CORS 头**，
 * WebView 里直接 fetch 会被拦。APK 内改走 CapacitorHttp 原生通道：它绕过同源策略，
 * 也顺带避开 WebView 的证书/代理差异；浏览器 / PWA 没有原生桥，只能退回 fetch
 * （失败是预期行为，此时继续用缓存或内置价表，不影响计价）。
 *
 * 【为什么缓存 24 小时】
 * 价格不是秒级变化的数据，但用户可能一天打开几十次；每次启动都抓既是浪费，
 * 也可能被官方当成异常流量。24h 内直接用缓存，过期后后台静默刷新一次。
 * 读写一律 try/catch：WebView 隐私模式下 localStorage 可能直接抛 SecurityError，
 * 缓存只是加速手段，绝不能让它把计价功能带崩。
 */

import { callNative } from '../../shell/bridge.js'
import {
  parsePricingMarkdown,
  type ModelPricing,
  type PriceTable,
  type PriceTier,
} from './pricing.js'

export const PRICING_MD_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md'

/** localStorage 键。带版本号：价表结构变更时换键，避免读到旧结构后反复解析失败。 */
export const PRICING_CACHE_KEY = 'deep-chat:cost:pricing:v1'

export const PRICING_TTL_MS = 24 * 3600 * 1000

/** 抓价总超时（含原生通道 + 解析前的读取）。原生侧另有 connect 5s / read 8s。 */
const FETCH_TIMEOUT_MS = 20_000

/** 价目页正文上限 2MB；正常页面约 10KB，超过说明拿到的不是价目页（例如代理错误页）。 */
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

type NativeHttpResponse = { data?: unknown }

const getStorage = (): Storage | null => {
  try {
    // 访问全局 localStorage 本身就可能抛（隐私模式 / 存储被禁用），所以放在 try 里。
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const isTier = (value: unknown): value is PriceTier => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const tier = value as Record<string, unknown>
  return ['cacheHit', 'cacheMiss', 'output'].every(
    (key) => typeof tier[key] === 'number' && Number.isFinite(tier[key])
  )
}

const isModelPricing = (value: unknown): value is ModelPricing => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const model = value as Record<string, unknown>
  return (
    isTier(model.offPeak) &&
    isTier(model.peak) &&
    typeof model.contextWindow === 'number' &&
    Number.isFinite(model.contextWindow)
  )
}

/** 缓存反序列化后做最小结构校验：旧版本 / 手改过的坏数据按「无缓存」处理。 */
const normalizeCachedTable = (value: unknown): PriceTable | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) {
    return null
  }
  if (typeof record.updatedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.updatedOn)) {
    return null
  }
  if (record.source !== 'official' && record.source !== 'bundled') {
    return null
  }
  if (!record.models || typeof record.models !== 'object' || Array.isArray(record.models)) {
    return null
  }
  const models = record.models as Record<string, unknown>
  const keys = Object.keys(models)
  if (keys.length === 0) {
    return null
  }
  for (const key of keys) {
    if (!isModelPricing(models[key])) {
      return null
    }
  }
  return {
    fetchedAt: record.fetchedAt,
    updatedOn: record.updatedOn,
    source: record.source,
    models: models as Record<string, ModelPricing>,
  }
}

export function readCachedTable(): PriceTable | null {
  try {
    const raw = getStorage()?.getItem(PRICING_CACHE_KEY)
    if (!raw) {
      return null
    }
    return normalizeCachedTable(JSON.parse(raw))
  } catch {
    // JSON 损坏 / 存储不可用：当作没有缓存。
    return null
  }
}

export function writeCachedTable(table: PriceTable): void {
  try {
    getStorage()?.setItem(PRICING_CACHE_KEY, JSON.stringify(table))
  } catch {
    // 配额满 / 隐私模式：丢缓存不影响本次计价。
  }
}

/**
 * 是否需要重新抓价。内置表 fetchedAt=0，所以永远算过期。
 * @param now 便于测试注入的当前时刻，默认 Date.now()。
 */
export function isStale(table: PriceTable | null, now: number = Date.now()): boolean {
  if (!table || !Number.isFinite(table.fetchedAt)) {
    return true
  }
  return now - table.fetchedAt >= PRICING_TTL_MS
}

const requestWithNative = async (): Promise<string> => {
  const response = await callNative<NativeHttpResponse>('CapacitorHttp', 'request', {
    url: PRICING_MD_URL,
    method: 'GET',
    responseType: 'text',
    connectTimeout: 5000,
    readTimeout: 8000,
    headers: { Accept: 'text/markdown' },
  })
  if (typeof response?.data !== 'string' || response.data.length === 0) {
    // 这里故意抛普通 Error 而不是 NOT_NATIVE：桥是通的，只是响应不对，不该再降级到 fetch。
    throw new Error('CapacitorHttp 未返回价目页文本')
  }
  return response.data
}

const requestWithFetch = async (signal: AbortSignal): Promise<string> => {
  const response = await fetch(PRICING_MD_URL, {
    method: 'GET',
    headers: { Accept: 'text/markdown' },
    signal,
  })
  if (!response.ok) {
    throw new Error(`官方价目页返回 HTTP ${response.status}`)
  }
  return await response.text()
}

const loadMarkdown = async (signal: AbortSignal): Promise<string> => {
  try {
    return await requestWithNative()
  } catch (error) {
    if ((error as { code?: string }).code !== 'NOT_NATIVE') {
      throw error
    }
    // 只有「没有原生桥」才降级。浏览器 / PWA 下这一步大概率因 CORS 失败，属预期。
    return await requestWithFetch(signal)
  }
}

const withTimeout = async <T>(task: Promise<T>, onTimeout: () => void): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 原生请求本身无法取消；这里只负责让上层尽快失败，并中止 fetch 分支。
      onTimeout()
      reject(new Error(`抓取官方价目页超时（${FETCH_TIMEOUT_MS / 1000}s）`))
    }, FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * 抓官方价目页并解析成价表。任何失败（网络、格式、空响应、超限）都抛错，
 * 由调用方决定保留旧表 —— 这里不吞异常，因为「静默用错价」比报错更难排查。
 */
export async function fetchOfficialTable(): Promise<PriceTable> {
  const controller = new AbortController()
  const markdown = await withTimeout(loadMarkdown(controller.signal), () => controller.abort())
  if (markdown.length > MAX_MARKDOWN_BYTES) {
    throw new Error(`官方价目页过大（${markdown.length} 字符），疑似不是价目页`)
  }
  // 用抓取完成的时刻：TTL 从「拿到价」开始算，页面的 updatedOn 也因此是北京抓取日。
  const fetchedAt = Date.now()
  const table = parsePricingMarkdown(markdown, fetchedAt)
  if (!table) {
    throw new Error('官方价目页格式无法解析（缺少价格行或模型列）')
  }
  return table
}
