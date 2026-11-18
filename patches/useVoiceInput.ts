/**
 * 补丁镜像：上游 `src/components/chatInput/useVoiceInput.ts`（2 处锚点）
 *
 * 【要解决的问题】
 * WebView 里 `getUserMedia` 失败时抛的是 `NotAllowedError`，但**网页侧无法区分**
 * 这两种情况：
 *   (a) 用户这次点了「拒绝」——下次还能再问；
 *   (b) 用户勾了「不再询问」——系统再也不会弹框，只有去设置里手动打开才行。
 * 两种都表现为同一个异常。只按上游逻辑弹一句「无法访问麦克风」，用户会反复点、
 * 反复失败，永远不知道要去系统设置。
 *
 * 【做法】
 * 只在 `NotAllowedError` 这一条分支上，问一次原生插件「当前是不是永久拒绝」。
 * 原生持有 `canRequest`（= 有 rationale 或者从未请求过）这个网页侧拿不到的信息。
 *
 * 【为什么不在点击时先 check】
 * `getUserMedia` 必须在用户手势的有效窗口内调用。点击时先串一次异步的原生调用，
 * 很可能把这个窗口用掉，导致本来能成功的录音反而失败。
 * 所以这里坚持「失败之后才问」，正常路径零开销。
 *
 * 【为什么 guideBlockedMic() 返回 false 时要继续走 toast】
 * 非永久拒绝的情况（网络、设备占用、编码不支持、用户这次刚拒绝）仍应沿用上游文案，
 * 那些文案是准确的，不该被我们替换掉。
 */

// ── 锚点 1：import ──
// 原本：
//   import { showToast } from '../base/toastState.js'
// 插入：
//   // mobile-shell: mic guidance import —— 原生壳里「永久拒绝麦克风」时引导去系统设置
//   import { guideBlockedMic } from '../../shell/mic-guide.js'

// ── 锚点 2：catch 分支 ──
// 原本：
//         setStatus('idle')
//         showToast(describeRecordingError(error))
// 现在：
//         setStatus('idle')
//         // mobile-shell: mic guidance —— 如果是「已永久拒绝」，网页侧拿不到这个信息，
//         // 交给原生判断并弹「去设置」引导；其余失败照旧走上游的 toast。
//         const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
//         if (!blocked || !(await guideBlockedMic())) {
//           showToast(describeRecordingError(error))
//         }
//
// 注意：外层函数已经是 async，`await` 不需要改签名。
