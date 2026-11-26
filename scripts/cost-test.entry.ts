/**
 * 峰谷计价的单元测试入口（在浏览器里跑，由 scripts/test-cost.mjs 打包注入）。
 *
 * 【为什么不写 Node 单测】
 * 这个项目的既有测试走的是「rspack 打包 TS → 无头 Chrome 执行」：能直接测到
 * 真实 WebView 会用的那份代码与同一套 Date / Number 行为。这里沿用同一套路，
 * 但被测算的 pricing.ts 本身是纯函数，所以同一份 bundle 在无浏览器时也能退回 Node 执行。
 *
 * 断言风格照抄 import-test.entry.ts：自己维护 results 数组并打 PASS/FAIL，
 * 外层脚本按日志判定退出码；汇总写到 __TEST_RESULT__ 供 CDP 轮询。
 */

import {
  FALLBACK_TABLE,
  beijingDateKey,
  computeTurnCost,
  formatMoney,
  formatPrice,
  formatTokens,
  isPeakHour,
  modelPricing,
  parsePricingMarkdown,
} from '../web-patches/mobile/cost/pricing.js'
import type { TurnCost } from '../web-patches/mobile/cost/pricing.js'

const log = (message: string) => console.log(`[test] ${message}`)

const results: { ok: boolean; label: string }[] = []
const check = (ok: boolean, label: string, extra?: unknown) => {
  results.push({ ok, label })
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`)
}

// ── 真实官方价目页片段（2026-11-27 快照，长单元格做了等价截短）────────────
//
// 解析器只依赖表头、价格行与上下文长度行；其余行保留是为了验证「非价格行
// 不会把解析带偏」，也避免测试夹具退化成只对正则友好的假数据。
const PRICING_FIXTURE = `
| 模型                      | 模型                                                                                   | 模型                                                                                   | deepseek-flash(1)                                                                          | deepseek-v4-pro                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| BASE URL (OpenAI 格式)    | BASE URL (OpenAI 格式)                                                                 | BASE URL (OpenAI 格式)                                                                 | <https://api.deepseek.com>                                                                 | <https://api.deepseek.com>                                                                 |
| BASE URL (Anthropic 格式) | BASE URL (Anthropic 格式)                                                              | BASE URL (Anthropic 格式)                                                              | <https://api.deepseek.com/anthropic>                                                       | <https://api.deepseek.com/anthropic>                                                       |
| 模型版本                    | 模型版本                                                                                 | 模型版本                                                                                 | DeepSeek-V4.1-Flash-1017                                                                   | DeepSeek-V4-Pro-0813                                                                       |
| 思考模式                    | 思考模式                                                                                 | 思考模式                                                                                 | 支持非思考与思考模式（默认）                                                                         | 支持非思考与思考模式（默认）                                                                         |
| 上下文长度                   | 上下文长度                                                                                | 上下文长度                                                                                | 1M                                                                                         | 1M                                                                                         |
| 输出长度                    | 输出长度                                                                                 | 输出长度                                                                                 | 最大 384K                                                                                    | 最大 384K                                                                                    |
| 功能                      | Json Output                                                                          | Json Output                                                                          | 支持                                                                                         | 支持                                                                                         |
| 功能                      | Tool Calls                                                                           | Tool Calls                                                                           | 支持                                                                                         | 支持                                                                                         |
| 功能                      | Responses API                                                                        | Responses API                                                                        | 支持                                                                                         | 支持                                                                                         |
| 功能                      | Anthropic API                                                                        | Anthropic API                                                                        | 支持                                                                                         | 支持                                                                                         |
| 功能                      | 图像理解                                                                                 | 图像理解                                                                                 | 支持                                                                                         | 不支持                                                                                        |
| 价格(2)                   | 百万tokens输入 / （缓存命中）                                                                  | 空闲时段                                                                                 | 0.02元                                                                                      | 0.15元                                                                                      |
| 价格(2)                   | 百万tokens输入 / （缓存命中）                                                                  | 高峰时段                                                                                 | 0.04元                                                                                      | 0.30元                                                                                      |
| 价格(2)                   | 百万tokens输入 / （缓存未命中）                                                                | 空闲时段                                                                                 | 1元                                                                                         | 4.5元                                                                                       |
| 价格(2)                   | 百万tokens输入 / （缓存未命中）                                                                | 高峰时段                                                                                 | 2元                                                                                         | 9.0元                                                                                       |
| 价格(2)                   | 百万tokens输出                                                                           | 空闲时段                                                                                 | 4元                                                                                         | 13.5元                                                                                      |
| 价格(2)                   | 百万tokens输出                                                                           | 高峰时段                                                                                 | 8元                                                                                         | 27.0元                                                                                      |
| 并发限制(3)                 | 并发限制(3)                                                                              | 并发限制(3)                                                                              | 2500                                                                                       | 500                                                                                        |
`

// ── 1. 官方 App 截图那组：谷时 §0.00562048 ─────────────────────────────

const SCREENSHOT_USAGE = {
  input_tokens: 3568,
  cache_read_input_tokens: 1024,
  cache_creation_input_tokens: 0,
  output_tokens: 508,
}

// 2026-11-27 是周五；12:00Z = 北京 20:00，谷时。
const SCREENSHOT_AT = Date.parse('2026-11-27T12:00:00Z')
const screenshot = computeTurnCost(SCREENSHOT_USAGE, 'deepseek-flash', SCREENSHOT_AT)

check(screenshot !== null, '截图用例：用量非空可计算')
check(screenshot !== null && screenshot.peak === false, '截图用例：20:00 北京判定为谷时')
check(
  screenshot !== null && screenshot.buckets.cacheHit.amount === 0.00002048,
  '截图用例：缓存命中桶 1024 × 0.02 / 1M = 0.00002048'
)
check(
  screenshot !== null && screenshot.buckets.cacheMiss.amount === 0.003568,
  '截图用例：未命中桶 3568 × 1 / 1M = 0.003568'
)
check(
  screenshot !== null && screenshot.buckets.output.amount === 0.002032,
  '截图用例：输出桶 508 × 4 / 1M = 0.002032'
)
check(
  screenshot !== null && screenshot.total === 0.00562048,
  '截图用例：三桶合计 0.00562048'
)
check(
  screenshot !== null && formatMoney(screenshot.total) === '0.00562048',
  '截图用例：formatMoney 输出 0.00562048'
)
check(screenshot !== null && screenshot.promptTokens === 4592, '截图用例：promptTokens=4592')

// ── 2. 峰谷边界 + 周末 + 法定假日 ─────────────────────────────────────

const boundaryCases: [string, boolean][] = [
  ['2026-11-27T08:59:00+08:00', false],
  ['2026-11-27T09:00:00+08:00', true],
  ['2026-11-27T11:59:00+08:00', true],
  ['2026-11-27T12:00:00+08:00', false],
  ['2026-11-27T13:59:00+08:00', false],
  ['2026-11-27T14:00:00+08:00', true],
  ['2026-11-27T17:59:00+08:00', true],
  ['2026-11-27T18:00:00+08:00', false],
]
for (const [iso, expected] of boundaryCases) {
  check(isPeakHour(Date.parse(iso)) === expected, `峰谷边界 ${iso} → ${expected ? '峰' : '谷'}`)
}
check(isPeakHour(Date.parse('2026-11-28T09:30:00+08:00')) === false, '周六 09:30 全谷')
check(isPeakHour(Date.parse('2026-11-29T15:00:00+08:00')) === false, '周日 15:00 全谷')
check(isPeakHour(Date.parse('2026-09-25T10:00:00+08:00')) === false, '法定假日（周五）10:00 全谷')
// 2026 年春节 / 清明 / 劳动 / 端午：都在工作日、且有峰时段，必须逐条判为谷。
// 这组用例守的是「节假日表漏一天就把谷价按峰价多算一倍」这个已知坑。
check(isPeakHour(Date.parse('2026-02-17T10:00:00+08:00')) === false, '春节（周二）10:00 全谷')
check(isPeakHour(Date.parse('2026-04-06T15:00:00+08:00')) === false, '清明（周一）15:00 全谷')
check(isPeakHour(Date.parse('2026-05-04T10:00:00+08:00')) === false, '劳动节（周一）10:00 全谷')
check(isPeakHour(Date.parse('2026-06-19T10:00:00+08:00')) === false, '端午（周五）10:00 全谷')
check(isPeakHour(Date.parse('2026-02-24T10:00:00+08:00')) === true, '春节后上班（周二）10:00 恢复峰价')
check(isPeakHour(Number.NaN) === false, 'isPeakHour(NaN) 按谷处理')

// 北京时间日界：UTC 15:59 仍是当天 23:59，UTC 16:00 已经是次日 00:00。
check(beijingDateKey(Date.parse('2026-11-27T15:59:00Z')) === '2026-11-27', '北京日界 23:59')
check(beijingDateKey(Date.parse('2026-11-27T16:00:00Z')) === '2026-11-28', '北京日界次日 00:00')

// ── 3. 官方 markdown 解析 ───────────────────────────────────────────

const parsed = parsePricingMarkdown(PRICING_FIXTURE, Date.parse('2026-11-27T03:00:00Z'))
check(parsed !== null, '解析真实价目页片段：非空')
check(parsed !== null && parsed.source === 'official', '解析结果 source=official')
check(parsed !== null && parsed.updatedOn === '2026-11-27', '解析结果 updatedOn=北京抓取日')

const flash = parsed?.models['deepseek-flash']
const pro = parsed?.models['deepseek-v4-pro']
check(
  flash !== undefined &&
    flash.offPeak.cacheHit === 0.02 &&
    flash.offPeak.cacheMiss === 1 &&
    flash.offPeak.output === 4,
  '解析 flash 谷价 0.02 / 1 / 4',
  flash?.offPeak
)
check(
  flash !== undefined &&
    flash.peak.cacheHit === 0.04 &&
    flash.peak.cacheMiss === 2 &&
    flash.peak.output === 8,
  '解析 flash 峰价 0.04 / 2 / 8',
  flash?.peak
)
check(
  pro !== undefined &&
    pro.offPeak.cacheHit === 0.15 &&
    pro.offPeak.cacheMiss === 4.5 &&
    pro.offPeak.output === 13.5,
  '解析 pro 谷价 0.15 / 4.5 / 13.5',
  pro?.offPeak
)
check(
  pro !== undefined &&
    pro.peak.cacheHit === 0.3 &&
    pro.peak.cacheMiss === 9 &&
    pro.peak.output === 27,
  '解析 pro 峰价 0.3 / 9 / 27',
  pro?.peak
)
check(flash?.contextWindow === 1_000_000, '解析 flash 上下文 1M')
check(pro?.contextWindow === 1_000_000, '解析 pro 上下文 1M')

// 删掉全部「价格」行 → 不能返回半张表。
const withoutPrices = PRICING_FIXTURE.split('\n')
  .filter((line) => !line.trim().startsWith('| 价格'))
  .join('\n')
check(parsePricingMarkdown(withoutPrices, Date.now()) === null, '缺少价格行 → 返回 null')

// 某一个价格不是数字（例如页面写「一元」）→ 整表作废，而不是按 0 计。
const brokenPrice = PRICING_FIXTURE.replace('| 1元', '| 一元')
check(parsePricingMarkdown(brokenPrice, Date.now()) === null, '价格非数字 → 返回 null')

// ── 4. 格式化 ──────────────────────────────────────────────────────

check(formatMoney(0.0056) === '0.0056', 'formatMoney(0.0056)')
check(formatMoney(0.00002048) === '0.00002048', 'formatMoney(0.00002048)')
check(formatMoney(0.1) === '0.1', 'formatMoney(0.1)')
check(formatMoney(0) === '0', 'formatMoney(0)')
check(formatTokens(1024) === '1,024', "formatTokens(1024) = '1,024'")
check(formatTokens(1_000_000) === '1,000,000', "formatTokens(1e6) = '1,000,000'")
check(formatPrice(4.5) === '4.5', "formatPrice(4.5) = '4.5'")
check(formatPrice(1) === '1', "formatPrice(1) = '1'")
check(formatPrice(0.02) === '0.02', "formatPrice(0.02) = '0.02'")

// ── 5. 上下文占比 ───────────────────────────────────────────────────

const smallContext = computeTurnCost(
  { input_tokens: 3568, cache_read_input_tokens: 1024 },
  'deepseek-flash',
  SCREENSHOT_AT
)
check(smallContext !== null && smallContext.contextPercent === 0, '4592 tokens 占比 0%')
const halfContext = computeTurnCost({ input_tokens: 500_000 }, 'deepseek-flash', SCREENSHOT_AT)
check(halfContext !== null && halfContext.contextPercent === 50, '500000 tokens 占比 50%')
const overContext = computeTurnCost({ input_tokens: 1_500_000 }, 'deepseek-flash', SCREENSHOT_AT)
check(overContext !== null && overContext.contextPercent === 100, '超上下文封顶 100%')

// ── 6. 缺字段 / 全零 ────────────────────────────────────────────────

const outputOnly = computeTurnCost({ output_tokens: 1000 }, 'deepseek-flash', SCREENSHOT_AT)
check(
  outputOnly !== null && outputOnly.total === 0.004,
  '仅 output_tokens：其余按 0，1000 × 4 / 1M = 0.004'
)
check(
  outputOnly !== null &&
    outputOnly.buckets.cacheHit.tokens === 0 &&
    outputOnly.buckets.cacheMiss.tokens === 0 &&
    outputOnly.buckets.output.tokens === 1000,
  '仅 output_tokens：三桶 token 正确'
)
check(
  outputOnly !== null && outputOnly.promptTokens === 0 && outputOnly.contextPercent === 0,
  '仅 output_tokens：promptTokens 0 / 占比 0%'
)
check(
  computeTurnCost({ input_tokens: 0, output_tokens: 0 }, 'deepseek-flash', SCREENSHOT_AT) === null,
  'usage 全 0 → null'
)
check(computeTurnCost(null, 'deepseek-flash', SCREENSHOT_AT) === null, 'usage 为 null → null')
check(computeTurnCost(undefined, 'deepseek-flash', SCREENSHOT_AT) === null, 'usage 为 undefined → null')

// ── 7. 模型键与内置表兜底 ───────────────────────────────────────────

check(modelPricing(FALLBACK_TABLE, null).key === 'deepseek-flash', 'model 为 null 按 Flash 档')
check(
  modelPricing(FALLBACK_TABLE, 'deepseek-v4-pro').key === 'deepseek-v4-pro',
  'model 精确命中 pro 档'
)
check(FALLBACK_TABLE.source === 'bundled', '内置表 source=bundled')
check(FALLBACK_TABLE.updatedOn === '2026-11-27', '内置表 updatedOn=2026-11-27')

// ── 汇总 ───────────────────────────────────────────────────────────

const failed = results.filter((result) => !result.ok)
log(`SUMMARY ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`)
if (failed.length > 0) {
  log(`FAILED: ${failed.map((result) => result.label).join(' | ')}`)
}

// 浏览器里 window 就是 globalThis；Node 退化路径下没有 window，写回 globalThis。
const scope = (typeof window === 'undefined' ? globalThis : window) as unknown as {
  __TEST_RESULT__?: { total: number; failed: number; results: typeof results }
}
scope.__TEST_RESULT__ = { total: results.length, failed: failed.length, results }
