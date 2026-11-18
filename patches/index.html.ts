/**
 * 补丁镜像：上游 `src/index.html`（1 处锚点）
 *
 * 【改动只有一行 viewport】
 *
 * 原本：
 *   <meta name="viewport" content="width=device-width,initial-scale=1" />
 * 现在：
 *   <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
 *
 * 【为什么必须加 viewport-fit=cover】
 * 不加这一项，`env(safe-area-inset-*)` 在 WebView 里恒为 0，
 * 刘海和底部手势条就会压住界面：顶部标题被状态栏吃掉、输入框被手势条挡住。
 * 加了之后才会拿到真实数值。
 *
 * 【这条决定了安全区的 A 档还是 B 档】
 * Capacitor 8 的 SystemBars 按两个条件分流：
 *   A 档：WebView < 140 **或** 没有 viewport-fit=cover
 *         → 原生直接给 decorView 加 padding，CSS 变量被设成 "0px"
 *   B 档：WebView ≥ 140 **且** 有 viewport-fit=cover
 *         → 不干预布局，CSS 变量给出真实 dp 值
 *
 * 我们无法预知用户手机的 WebView 版本，所以两种档位都必须正确。
 * `web-patches/safe-area.css` 用 `--shell-inset-*` 包了一层，
 * A 档拿到 "0px" 时 padding 为 0（原生已经补过，不能重复补），
 * B 档拿到真实值时才真正生效 —— 这就是为什么不能无条件 padding。
 *
 * 【语义上是否改变了桌面浏览器】
 * `viewport-fit=cover` 在桌面浏览器上无副作用（桌面无需关心安全区）。
 * 但仍把它算作「允许的差异」之一：规格允许安全区相关的改动。
 */

// 锚点：src/index.html 的 <meta name="viewport">
//
// 原本：
//   <meta name="viewport" content="width=device-width,initial-scale=1" />
// 现在：
//   <!-- mobile-shell: viewport-fit=cover 让 env(safe-area-inset-*) 生效，
//        配合 web-patches/safe-area.css 避让刘海与手势条。上游无此行。 -->
//   <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
