# 导出体积对齐官方：JSON 压缩、图片不压缩（0.2.7）

## 现象

同一份数据（官方 App 导出的历史归档），两个导出方给出的 ZIP 体积差了一大截：

| 来源 | 会话数 | ZIP 体积 |
| --- | --- | --- |
| 官方 App 导出（用户在设置里「导出所有历史对话」拿到的那份） | 593 | **31.3 MB** |
| 本壳导出（0.2.6） | 593 | **52.2 MB** |

解包对比后差异很干净 —— 内容完全一致，只是压缩方式不同：

| 条目类型 | 原始字节 | 官方 App 写入方式 | 本壳 0.2.6 写入方式 |
| --- | --- | --- | --- |
| `chat_sessions/*.json`（593 条） | 33.7 MB | deflate → 11.6 MB | STORE（不压缩）33.7 MB |
| `chat_sessions/*_files/*`（81 张图） | 19.6 MB | STORE 19.6 MB | STORE 19.6 MB |

也就是说：**官方对 JSON 做 deflate，对图片原样存**；本壳此前两种都原样存。
会话 JSON 里全是重复的字段名和中文正文，压缩比接近 3:1，于是平白多了 20 MB。

这不只是「文件大一点」：备份/导出要多写 20 MB 到 Documents，导出后的用户再导入时
也要多读 20 MB；而且和官方导出体积不一致，用户第一眼就会觉得「你的导出是不是有问题」。

## 原因

上游 `src/services/chat/history/zipWriter.ts` 的 `writeArchive()` 用 fflate 的
`ZipPassThrough` 处理每一个条目 —— 它只分块、不压缩，产出的是全 STORE 归档。
上游面向浏览器下载，体积不在它的关注点里；而官方 App 的导出实现选择了「JSON 压缩」，
于是两边在同一份数据上差了 40%。

## 改动

`src/services/chat/history/zipWriter.ts` 改为整文件 fork
（`web-patches/mobile/overrides/history/zipWriter.ts`，manifest 基线见
`web-patches/mobile/manifests/history.json`），只改条目类的选择：

```ts
// 会话/索引/user.json 这些文本条目走 deflate；图片等二进制条目保持 STORE
const entry =
  name.endsWith('.json')
    ? new ZipDeflate(name, { level: DEFLATE_LEVEL })
    : new ZipPassThrough(name)
```

三个刻意的取舍：

1. **只压缩 `.json`，不压缩图片**。JPEG/PNG 已经是压缩格式，deflate 再压一遍大概率
   只能省 1~2%，却要多花一遍 CPU（81 张图 19.6 MB）。官方导出对图片也是 STORE，
   保持同样的策略才能让体积和官方对齐。
2. **level 6，不用 9**。fflate 的 9 级在这个数据上只比 6 级小 1% 左右，慢 2 倍以上；
   导出是在手机上跑，用户还要在前台盯着进度条，6 级是体积/耗时的拐点。
3. **保持 `Zip` + 流式写入的结构**。没有改成「先 `strToU8` 再一次性压缩」：
   593 条会话每条约 57 KB，一次性构造完整字节会多一份等体量的中间副本；
   `Zip` 的 `ondata` 分块回调仍按 64 KB 往下游吐，峰值内存不变。

同时把「写完校验」的期望大小一起改掉，否则 deflate 后字节数变小，原本
`size > expectedSize` 的兜底会误判：

```ts
// 每个条目最多产生一个 64 KB 的 ondata 分块（deflate 下实际远小于此）
const expectedSize = dataSize + directorySize + 22 + prepared.length * 64
```

## 实测

桌面无头 Chrome（真实 32.8 MB 归档，隔离 profile，同一份代码路径）：

| 指标 | 0.2.6（全 STORE） | 0.2.7（JSON deflate） |
| --- | --- | --- |
| 导出 ZIP | 52.2 MB | **30.9 MB**（-41%） |
| 导出耗时 | 4947 ms | 5275 ms（+6.6%） |
| 峰值 JS heap | 88.4 MB | 88.4 MB |

Android 模拟器（MuMu，API 32，0.2.7 debug 包，843 条会话 —— 官方 593 条 + 之前测试留下的 250 条）：

| 场景 | 结果 |
| --- | --- |
| 导出（843 条 / 926 条目） | **31.08 MB**（结果页写「文件大小 31.08 MB」）；点击后 3 s 时进度 60%，10 s 内完成 |
| 条目分布 | 843 个 `chat_sessions/*.json`：83.3 MB → 11.3 MB；81 张图：19.6 MB → 19.6 MB（STORE） |
| 再把自家导出导入回来 | 843 条全部「已导入过，未重新解析」，共 3.1 s（读取 135 ms + 校验 48 ms + 解析 2.9 s + 写入 190 ms） |

最后一行是这次改动最需要的一种验证：**我们写出的 deflate 归档，我们自己的读取路径
（以及打开它的官方客户端）都还能读**。

## 兼容性

- 读取侧不需要改：上游 `zipReader` 基于 fflate 的 `unzip`，本来就支持 STORE / deflate /
  数据描述符；官方导出的归档一直是 deflate 的，0.2.5 起我们的读取路径就是按它调的。
- 桌面端 `chat-demo` 用同一套 fflate 读取，0.2.7 导出的 ZIP 在桌面上覆盖式导入正常
  （`pnpm test:import` 的场景 1/7 与 `accept` 的 F2x 覆盖这条路）。
- 格式版本仍是 v3，字段没变，只是 ZIP 条目的 `method` 从 0 变成 8 —— 这不是格式变更，
  不需要升版本号，也不影响 0.2.6 及更早版本读取**新**归档。

## 边界

- 导出仍是「整份归档在内存里建成 Blob」（见
  [`../docs/import-performance.md`](../docs/import-performance.md) §8 第 3 条）：
  会话特别多时峰值仍随数据量涨。deflate 让结果小 41%，但峰值内存不会因此变小，
  因为压缩前的 JSON 字节仍要过一遍。
- 没有做「图片也压缩」：对 JPEG/PNG 是负收益，见上。
- 没有改 `manifest.json` / `chat_session_index.json` 之外的任何字段，也没有用
  `CompressionStream`（WebView 105+ 有，但 fflate 在 Worker 之外的同步路径更可控，
  且 CRC 与数据描述符的写法要和读取侧完全一致才不出错）。
