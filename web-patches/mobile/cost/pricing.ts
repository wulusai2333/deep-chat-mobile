/**
 * DeepSeek 官方峰谷计价 —— web-patches/mobile/cost/pricing.ts
 *
 * 【为什么要有这一层】
 * 官方人民币价目页把同一模型拆成高峰 / 空闲两档，且价格会随调价漂移；
 * 而「跟官方 App 截图逐分对齐」要求本地按每条消息的用量与**计费时刻**重算，
 * 不能依赖上游返回的金额（上游根本没返回金额）。
 *
 * 本文件是纯函数：不碰网络、DOM、React、localStorage。好处是价格算法可以单独测，
 * 而且抓价 / 缓存失败时，已有消息的金额仍然能按内置价表算出来。
 *
 * 【时区】
 * 峰谷按北京日历日判定。中国不实行夏令时，所以固定 UTC+8 平移，再用 Date 的
 * **UTC getter** 取小时 / 星期 / 日期 —— 完全不看设备本地时区：用户把手机时区
 * 改成 UTC 或纽约，金额不能跟着变。
 */

export type PriceTier = { cacheHit: number; cacheMiss: number; output: number }

export type ModelPricing = { offPeak: PriceTier; peak: PriceTier; contextWindow: number }

export type PriceTable = {
  /** 抓取完成的时刻（epoch ms）；内置表固定 0，便于被 isStale 判为过期 */
  fetchedAt: number
  /** 'YYYY-MM-DD'，抓取日 / 页面标注日 */
  updatedOn: string
  source: 'official' | 'bundled'
  /** 键：'deepseek-flash' | 'deepseek-v4-pro' */
  models: Record<string, ModelPricing>
}

/** 与 web/src/services/api/types.ts 的 MessageUsage 结构兼容；字段全可选，缺字段按 0 计。 */
export type TurnUsageLike = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

export type CostBucket = { tokens: number; pricePerMillion: number; amount: number }

export type TurnCost = {
  peak: boolean
  modelKey: string
  buckets: { cacheHit: CostBucket; cacheMiss: CostBucket; output: CostBucket }
  total: number
  /** 命中缓存 + 本次新算输入（缓存写入已计入新算输入，不重复加） */
  promptTokens: number
  /** 0..100 整数 */
  contextPercent: number
}

const HOUR_MS = 3600_000
const TOKENS_PER_MILLION = 1_000_000

/**
 * 高峰时段窗口（**北京时间**小时，半开区间 [start, end)）。
 * DSH 参考实现里存的是 UTC 1-4 / 6-10；这里固定 +8 后直接写北京小时，
 * 少一次加法，也让「9:00-12:00、14:00-18:00」能跟官方页面文字对上。
 */
export const PEAK_WINDOWS: readonly { start: number; end: number }[] = [
  { start: 9, end: 12 },
  { start: 14, end: 18 },
]

/**
 * 中国法定节假日（北京日历日）。
 *
 * 2026 年整表来自《国务院办公厅关于 2026 年部分节假日安排的通知》
 * （国办发明电〔2025〕7 号，2025-11-04）：元旦 1/1–1/3、春节 2/15–2/23、
 * 清明 4/4–4/6、劳动 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。
 * 假期序列里本来就含周末（周末已由 `isPeakHour` 判为谷价），这里照样列出，
 * 是为了让这张表能和官方通知逐条对照，而不是靠「反正周末也是谷」少写几天。
 *
 * 通知里的调休上班日（2026-01-04、02-14、02-28、05-09、09-20、10-10 等）**不列**：
 * 官方峰谷规则是「周末全天谷价」，调休上班也不改变它是周末，与 DSH 口径一致。
 *
 * 按国务院安排逐年维护：漏一天就会把谷价按峰价多算一倍（已知限制）。
 * 2027 年的安排通常在 2026 年 11 月公布，公布后补到这里。
 */
export const CN_HOLIDAYS: readonly string[] = [
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/**
 * 内置价表（人民币 / 百万 tokens），2026-11-27 官方页快照。
 * 抓价失败或首次启动尚无缓存时用它兜底：宁可显示「略微过期但正确量级」的金额，
 * 也不要空着。source='bundled' 让 UI 能提示这不是实时抓到的价。
 */
export const FALLBACK_TABLE: PriceTable = {
  fetchedAt: 0,
  updatedOn: '2026-11-27',
  source: 'bundled',
  models: {
    'deepseek-flash': {
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      contextWindow: 1_000_000,
    },
    'deepseek-v4-pro': {
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      contextWindow: 1_000_000,
    },
  },
}

const MODEL_KEYS: readonly string[] = ['deepseek-flash', 'deepseek-v4-pro']
const DEFAULT_MODEL_KEY = 'deepseek-flash'

/** 北京时间日期键 'YYYY-MM-DD'；非有限时刻返回 ''（调用方按「无法判定」处理）。 */
export function beijingDateKey(atMs: number): string {
  if (!Number.isFinite(atMs)) {
    return ''
  }
  return new Date(atMs + 8 * HOUR_MS).toISOString().slice(0, 10)
}

/**
 * 某一时刻是否处于高峰时段。
 * 高峰 = 北京周一至周五、且当日不是法定节假日的 [9,12) 或 [14,18)；
 * 其余（含周末与调休上班的周末）全按谷价。
 */
export function isPeakHour(atMs: number): boolean {
  if (!Number.isFinite(atMs)) {
    return false
  }
  const beijing = new Date(atMs + 8 * HOUR_MS)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) {
    return false
  }
  if (CN_HOLIDAYS.includes(beijingDateKey(atMs))) {
    return false
  }
  const hour = beijing.getUTCHours()
  return PEAK_WINDOWS.some((window) => hour >= window.start && hour < window.end)
}

/**
 * 消息模型 → 价表键。
 *
 * 上游把模型存成 ChatModel 联合类型，但历史数据里可能出现服务端版本号
 * （如 deepseek-v4-pro-0813）或 null（早期消息没记模型）。null / 未知一律按
 * Flash 档处理：它是应用默认模型，也是更便宜的一档，不会夸大数据。
 */
export function modelPricing(
  table: PriceTable,
  model: string | null
): { key: string; pricing: ModelPricing } {
  const requested = typeof model === 'string' ? model.trim() : ''
  let key = DEFAULT_MODEL_KEY
  if (requested.length > 0) {
    if (table.models[requested]) {
      key = requested
    } else if (requested.includes('pro')) {
      key = 'deepseek-v4-pro'
    }
  }
  // 抓来的表可能因为官方改版缺某个键：退回内置表同键，再退回 Flash，绝不返回 undefined。
  const pricing =
    table.models[key] ?? FALLBACK_TABLE.models[key] ?? FALLBACK_TABLE.models[DEFAULT_MODEL_KEY]
  return { key, pricing }
}

/** 非有限 / 负数 token 一律按 0，避免脏数据把金额算成 NaN 或负数。 */
const tokenCount = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const bucket = (tokens: number, pricePerMillion: number): CostBucket => {
  // 价格本身也做防护：解析/缓存被污染时宁可金额为 0，也不要把 NaN 带进 UI。
  const price = Number.isFinite(pricePerMillion) && pricePerMillion > 0 ? pricePerMillion : 0
  return { tokens, pricePerMillion: price, amount: (tokens * price) / TOKENS_PER_MILLION }
}

/**
 * 一次调用的费用。
 *
 * 计费口径（与官方用量字段对齐）：
 * - 命中缓存 = cache_read_input_tokens
 * - 缓存写入 = cache_creation_input_tokens，官方按「未命中输入」价计费，所以并入 miss
 * - 未命中输入 = input_tokens + cache_creation_input_tokens
 * - 输出 = output_tokens
 * 计算期不取整（逐分对齐靠最后 formatMoney，而不是中途 round）。
 *
 * @param atMs 计费时刻。调用方必须传消息的 createdAt（请求发起时刻），
 *   不是完成时刻 —— 跨峰谷边界的长回答按发起时刻结算。
 */
export function computeTurnCost(
  usage: TurnUsageLike | null | undefined,
  model: string | null,
  atMs: number,
  table: PriceTable = FALLBACK_TABLE
): TurnCost | null {
  if (!usage) {
    return null
  }
  const hit = tokenCount(usage.cache_read_input_tokens)
  const write = tokenCount(usage.cache_creation_input_tokens)
  const input = tokenCount(usage.input_tokens)
  const miss = input + write
  const output = tokenCount(usage.output_tokens)
  // 三个桶全空说明这条消息没有可计费用量（例如请求失败 / 还没开始回答），
  // 返回 null 让 UI 不显示金额入口，而不是显示 ¥0.00。
  if (hit + miss + output === 0) {
    return null
  }

  const peak = isPeakHour(atMs)
  const { key, pricing } = modelPricing(table, model)
  const tier = peak ? pricing.peak : pricing.offPeak
  const buckets = {
    cacheHit: bucket(hit, tier.cacheHit),
    cacheMiss: bucket(miss, tier.cacheMiss),
    output: bucket(output, tier.output),
  }
  const total = buckets.cacheHit.amount + buckets.cacheMiss.amount + buckets.output.amount
  // 输入侧总量 = 缓存命中 + 新算输入。write 已经含在 miss 里，这里不再单独加，
  // 否则缓存写入会被算两次（上下文占比会虚高）。
  const promptTokens = hit + miss
  const contextWindow =
    Number.isFinite(pricing.contextWindow) && pricing.contextWindow > 0 ? pricing.contextWindow : 0
  const contextPercent =
    contextWindow > 0 ? Math.min(100, Math.round((promptTokens / contextWindow) * 100)) : 0

  return { peak, modelKey: key, buckets, total, promptTokens, contextPercent }
}

/**
 * 金额显示：最多 8 位小数、裁掉尾零。
 * 8 位是为了让最便宜的一档（缓存命中 0.02 元 / 百万）在小用量下也能显示到「分」以下；
 * 先 toFixed 再裁零，避免 0.005620480000000001 这类浮点尾巴出现在 UI 上。
 */
export function formatMoney(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return safe.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
}

/** token 数：四舍五入 + 千分位（手写分组，不依赖系统 locale）。 */
export function formatTokens(value: number): string {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0
  const sign = rounded < 0 ? '-' : ''
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 单价显示：0.02 / 1 / 4.5。整数不带小数点，非整数最多 6 位且去掉浮点尾巴。 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

// ── 官方 markdown 价目页解析 ─────────────────────────────────────────────

/** 把一行 markdown 表格切成单元格；不是表格行返回 null。 */
const splitRow = (line: string): string[] | null => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) {
    return null
  }
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 表头里的 'deepseek-flash(1)' 去掉脚注后才是模型键。 */
const normalizeModelName = (cell: string): string => cell.replace(/\(\d+\)/g, '').trim()

/** '0.02元' / '1元' / '4.5元' → 数字；任何别的东西 → null。 */
const parsePriceCell = (cell: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)\s*元?$/.exec(cell.trim())
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** '1M' → 1_000_000，'384K' → 384_000（与官方「百万 tokens」同口径的十进制单位）。 */
const parseContextCell = (cell: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)\s*([KkMm])$/.exec(cell.replace(/\s+/g, ''))
  if (!match) {
    return null
  }
  const unit = match[2].toUpperCase() === 'M' ? 1_000_000 : 1_000
  const value = Number(match[1]) * unit
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 第二格：计费项。注意必须先判「未命中」，因为「缓存未命中」也包含「缓存命中」。 */
const priceKind = (cell: string): 'cacheHit' | 'cacheMiss' | 'output' | null => {
  if (cell.includes('缓存未命中')) {
    return 'cacheMiss'
  }
  if (cell.includes('缓存命中')) {
    return 'cacheHit'
  }
  if (cell.includes('输出')) {
    return 'output'
  }
  return null
}

/** 第三格：时段。 */
const pricePeriod = (cell: string): 'offPeak' | 'peak' | null => {
  if (cell.includes('空闲')) {
    return 'offPeak'
  }
  if (cell.includes('高峰')) {
    return 'peak'
  }
  return null
}

const completeTier = (tier: Partial<PriceTier>): PriceTier | null => {
  const { cacheHit, cacheMiss, output } = tier
  if (
    typeof cacheHit !== 'number' ||
    typeof cacheMiss !== 'number' ||
    typeof output !== 'number' ||
    !Number.isFinite(cacheHit) ||
    !Number.isFinite(cacheMiss) ||
    !Number.isFinite(output)
  ) {
    return null
  }
  return { cacheHit, cacheMiss, output }
}

/**
 * 解析官方价目页 markdown。
 *
 * 只认「价格」行里的模型列：表头定位 deepseek-flash / deepseek-v4-pro 的列号，
 * 再按第二格（缓存命中 / 未命中 / 输出）与第三格（空闲 / 高峰）归档。
 * 任何一项缺失或不是数字就返回 null —— **绝不返回半张表**：半张表会让某些消息
 * 静默按 0 元计，比整表不可用更危险（调用方会继续用缓存/内置表）。
 */
export function parsePricingMarkdown(text: string, fetchedAt: number): PriceTable | null {
  if (typeof text !== 'string' || !Number.isFinite(fetchedAt)) {
    return null
  }
  const lines = text.split(/\r?\n/)

  // 1. 表头：找到同时含两个已知模型名的表格行，记下列号。
  const columns: { key: string; index: number }[] = []
  for (const line of lines) {
    const cells = splitRow(line)
    if (!cells) {
      continue
    }
    const matched = cells
      .map((cell, index) => ({ key: normalizeModelName(cell), index }))
      .filter((cell) => MODEL_KEYS.includes(cell.key))
    if (matched.length === MODEL_KEYS.length) {
      columns.push(...matched)
      break
    }
  }
  if (columns.length !== MODEL_KEYS.length) {
    return null
  }

  // 2. 逐行收价格与上下文长度。
  const tiers = new Map<string, { offPeak: Partial<PriceTier>; peak: Partial<PriceTier> }>()
  for (const column of columns) {
    tiers.set(column.key, { offPeak: {}, peak: {} })
  }
  const contextWindows = new Map<string, number>()
  for (const line of lines) {
    const cells = splitRow(line)
    if (!cells) {
      continue
    }
    const label = cells[0] ?? ''
    if (label.startsWith('价格')) {
      const kind = priceKind(cells[1] ?? '')
      const period = pricePeriod(cells[2] ?? '')
      if (!kind || !period) {
        return null
      }
      for (const column of columns) {
        const price = parsePriceCell(cells[column.index] ?? '')
        if (price === null) {
          return null
        }
        const entry = tiers.get(column.key)
        if (!entry) {
          return null
        }
        entry[period][kind] = price
      }
      continue
    }
    if (label.startsWith('上下文长度')) {
      for (const column of columns) {
        const contextWindow = parseContextCell(cells[column.index] ?? '')
        if (contextWindow === null) {
          return null
        }
        contextWindows.set(column.key, contextWindow)
      }
    }
  }

  // 3. 两个模型都必须 6 个价格 + 上下文齐全。
  const models: Record<string, ModelPricing> = {}
  for (const column of columns) {
    const entry = tiers.get(column.key)
    const contextWindow = contextWindows.get(column.key)
    if (!entry || contextWindow === undefined) {
      return null
    }
    const offPeak = completeTier(entry.offPeak)
    const peak = completeTier(entry.peak)
    if (!offPeak || !peak) {
      return null
    }
    models[column.key] = { offPeak, peak, contextWindow }
  }

  return {
    fetchedAt,
    // 页面自己不带抓取日期，用抓取时刻的北京日期（跨时区也不能写成 UTC 日期）。
    updatedOn: beijingDateKey(fetchedAt),
    source: 'official',
    models,
  }
}
