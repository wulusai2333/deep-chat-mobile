/**
 * 补丁镜像：ES2023 内置方法替换（2 个文件，各 1 处）
 *
 * 【为什么必须改】
 * 鸿蒙 4.3 的 WebView 内核实测低于 Chrome 105，而 rspack 只做**语法**降级
 * （`targets` 里的 `chrome >= 105` 决定要不要把 `??`、可选链之类的语法改写），
 * **不会**为内置方法注入 polyfill。`Array.prototype.toSorted` / `toReversed`
 * 是 ES2023 新增（Chrome 110 起），老内核上是 `undefined`，调用即 TypeError。
 *
 * 失败现象很有欺骗性：不是白屏，而是「点开某个历史会话」或「发送带附件的消息」
 * 的时候静默失败 —— 因为这两处都不在首屏路径上。
 *
 * 【为什么不用 polyfill】
 * 给一个第三方静态应用塞 core-js 会显著增大包体，而且影响全局原型 ——
 * 对这个「只碰两处调用」的需求来说代价远大于收益。直接改成等价写法最稳。
 */

// ── 1. src/services/chat/history/toLocal.ts:247 ──
//
// 原本：
//   const sorted = file.messages.toSorted((a, b) => a.id - b.id)
// 现在：
//   // mobile-shell: no toSorted —— toSorted 是 ES2023，鸿蒙 4.3 的 WebView 内核支持
//   // 不稳定，且 rspack 只降语法不 polyfill 内置方法。语义等价（都是新数组）。
//   const sorted = file.messages.slice().sort((a, b) => a.id - b.id)
//
// 语义：`toSorted` 返回新数组且不改变原数组；`slice().sort()` 完全等价。
// 这里不能写成 `file.messages.sort(...)` —— 那会原地修改归档对象，
// 后续按原顺序遍历的代码（index 校验）会受影响。

// ── 2. src/services/chat/store.ts:847 ──
//
// 原本：
//   for (const [user] of getContextRounds(request.history).toReversed()) {
// 现在：
//   // mobile-shell: no toReversed —— toReversed 是 ES2023，鸿蒙 4.3 的 WebView 内核
//   // 支持不稳定，且 rspack 只降语法不 polyfill 内置方法。语义等价（都是新数组）。
//   for (const [user] of getContextRounds(request.history).slice().reverse()) {
//
// 语义：同上。这里是「从最新一轮往前找附件」，顺序很重要，不能省掉 reverse。

/**
 * 顺带记一笔：怎么确认内核里还有哪些 ES2023 方法不能用
 *
 * 真机连 adb 后在 chrome://inspect 里开控制台，跑：
 *
 *   ['toSorted','toReversed','toSpliced','with','findLast','findLastIndex',
 *    'groupBy','groupByToMap','structuredClone','at']
 *     .map((k) => [k, typeof [][k]])
 *
 * `groupBy`（Object.groupBy / Map.groupBy）和 `with`（Array.prototype.with）
 * 也是 ES2023/ES2024 的，若真要再用就需要同样处理。
 * `scripts/verify.mjs` 的 D 组会检查这两个 `mobile-shell: no ...` 标记仍在位，
 * 防止有人「顺手优化回去」。
 */
