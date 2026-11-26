# 本轮消耗面板（0.2.8 未发布）

> 对应 `web-patches/mobile/cost/` 与 `scripts/prepare-web.mjs` 里
> `mobile-ui: turn cost entry import` / `mobile-ui: turn cost entry jsx` 两处插入。

## 为什么做

DeepSeek 官方 App 在最后一条回答的下方放了一个数据库图标，点开显示本轮
三类 token（缓存命中输入 / 缓存未命中输入 / 输出）的单价、用量、金额与合计。
本壳走的是真实 API，每一轮都在扣钱，用户看不到这笔钱花在哪、花多少，
只能事后去开放平台查余额。

官方从 2026-08 起把价格拆成**高峰 / 空闲**两档（北京时间周一至周五
9:00–12:00、14:00–18:00 为高峰，其余含周末与法定节假日为谷时，谷价是峰价的一半），
所以「多少钱」还取决于这一轮**什么时候发出**——只显示 token 数是不够的。

## 怎么算

- 计费时刻用消息的 `createdAt`（请求发起时刻），不是完成时刻。
  跨峰谷边界的长回答按发起时刻结算，与 DSH 的 `cost-meter` 口径一致。
- 三个桶来自 Anthropic 兼容 Messages 协议的 `usage`：
  `cache_read_input_tokens` → 缓存命中；`input_tokens + cache_creation_input_tokens`
  → 缓存未命中；`output_tokens` → 输出。DeepSeek 的 `cache_creation` 恒为 0，
  若某天不为 0 则并入未命中（缓存写入本质是一次未命中，不能按 0 元算）。
- 金额 = Σ(该桶 token × 该桶单价) / 1_000_000。计算期不取整，显示时最多 8 位小数、
  裁尾零（`0.00562048`）；这是为了最便宜那档（0.02 元 / 百万）在小用量下也能显示出差异。
- 上下文占比 = (命中 + 未命中) / 模型的上下文长度，取整后封顶 100%。
  注意**不能**把 `input_tokens` 与 `cache_creation_input_tokens` 重复相加，
  也不能把 `cache_creation` 再加一次到分子里，否则占比虚高。

## 价格从哪来

- 官方价目页：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md`。
  取 `.md` 而不是 HTML 页：HTML 表格有合并单元格，转文本后列错位；
  `.md` 是同一份数据的纯文本镜像，解析只需要认「价格」行 + 表头模型列。
- **每天最多抓一次**：成功抓取后把整张价格表写进
  `localStorage['deep-chat:cost:pricing:v1']`（24h TTL），失败保留旧表。
  抓价失败、页面改版、首次冷启动都回退到代码里的内置快照，
  面板照常显示，只在页脚标注「价格更新于 YYYY-MM-DD」。
- **为什么不用 `fetch`**：`api-docs.deepseek.com` 不返回 `Access-Control-Allow-Origin`，
  WebView 里跨域 `fetch` 必然被拦（`api.deepseek.com` 才有 ACAO）。
  因此原生壳走 Capacitor 内置的 `CapacitorHttp.request`（`@capacitor/android`
  的 `Bridge.java` 无条件注册该插件，不需要新增原生代码、也不需要开
  `CapacitorHttp.enabled` 的 fetch 补丁——那个补丁会接管全局 fetch，
  把聊天流式请求也一起改成原生，风险远大于收益）。
  浏览器 / PWA 没有桥，退化为普通 `fetch`（会被 CORS 拦）→ 用内置表。
  **禁止**为了绕 CORS 挂任何第三方代理：价目数据不值得把用户流量交出去。

## 已知取舍

1. **法定节假日表是硬编码的**（`pricing.ts` 的 `CN_HOLIDAYS`）。
   官方规则排除法定节假日，但页面只写规则、不列日期，只能按国务院安排维护。
   2026 年整表已按《国务院办公厅关于 2026 年部分节假日安排的通知》
   （国办发明电〔2025〕7 号）逐条列出，假期里含的周末也照样写进表里，方便和通知对照；
   2027 年的安排公布后再补。漏列一天会把谷价按峰价多算一倍。
   调休上班的周末仍按谷价——官方规则是「周末全天谷」，与 DSH 一致。
2. **「免费」徽标没有还原**：官方 App 的会话不单独计费，所以显示「免费」；
   本壳每轮真扣费，标「免费」是错误信息。这个位置改成显示模型名。
3. **面板只挂在最后一条回答上**：更早的轮次没有再入口，与官方一致。
   导出的历史归档里没有金额字段，导入后旧消息仍能按当时的 usage 重算
   （`usage` 已随消息落库），但不会参与导出迁移。
4. **会话累计是新加的一行**：官方面板只有本轮。用户需要「这个会话一共花了多少」，
   所以在页脚多一行小字，不影响上面三块的官方布局。
