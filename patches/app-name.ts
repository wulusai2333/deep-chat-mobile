# 品牌文案：`product name zh` / `product name en` / `page title`

上游 `deepseek-ai/chat-demo` 是 DeepSeek 官方放出来的**API 演示程序**，
界面里明写着「API 使用 demo」，页面标题也是同一句。

本壳不是演示：它是一个可以日常使用的 DeepSeek 客户端。
所以这三处文案改成产品名 **Deep Chat**。

## 改了什么

| 文件 | 原文 | 改成 |
| --- | --- | --- |
| `src/i18n/zh.ts` | `appName: 'API 使用 demo',` | `appName: 'Deep Chat',` |
| `src/i18n/en.ts` | `appName: 'API usage demo',` | `appName: 'Deep Chat',` |
| `src/index.html` | `<title>API 使用 demo</title>` | `<title>Deep Chat</title>` |

`appName` 是唯一在界面上显示产品名的 key —— `Sider.tsx` 用它渲染侧边栏顶部：

```tsx
<div className={styles.appName}>{t('appName')}</div>
```

页面标题决定任务切换器（鸿蒙的最近任务卡片）和浏览器标签上显示什么。

## 为什么只改这三处

规格第一条要求「界面与桌面浏览器完全一致」，所以改动范围必须封闭。
产品名是唯一的例外 —— 它不是布局、不是交互、不是配色，而是一个必须正确的
标识：用户在手机的任务切换器里看到「API 使用 demo」，会以为装错了东西。

反过来，界面里的其它文字（欢迎语、按钮、设置项）**一律不动**。
那些是上游的产品语言，改了既超出规格授权，也会让以后对比上游 diff 变难。

## 为什么中文和英文都改成 `Deep Chat`

品牌名不翻译。中文界面里写「深聊」、英文界面写「Deep Chat」会让同一个人
在两台设备上看到两个名字，也给客服和文档带来两套叫法。
产品名保持拉丁字母，中英文两处一致。

## 为什么标记必须在替换文本里

`replaceOnce` 判断「这个补丁打过了吗」靠的是**在文件里搜标记**。
如果替换文本里漏掉标记，第二次运行 `pnpm web:prepare` 就找不到原文
（因为已经被替换掉了）而直接报错退出。

这个坑踩过一次：页面标题那条最初写成 `<title>Deep Chat</title>` 没带标记，
第一次跑成功，第二次就跑挂了。`verify.mjs` 的 D 组现在会检查这三个标记，
所以漏标记会立刻被自检抓出来。

## 顺带改到的其它地方

产品名不只出现在 `web/` 里，改的时候要一起对齐，否则会出现
「图标下面写着 Deep Chat，进来侧边栏写着 API 使用 demo」这种自相矛盾：

| 位置 | 内容 |
| --- | --- |
| `capacitor.config.ts` | `appName: 'Deep Chat'`、`appendUserAgent: 'DeepChatMobile/<ver>'` |
| `android/app/src/main/res/values/strings.xml` | `app_name` / `title_activity_main` = Deep Chat |
| `web-patches/onboarding.ts` | 引导页标题「欢迎使用 Deep Chat」 |
| `web-patches/mic-guide.ts` | 权限引导里的「设置 → 应用 → Deep Chat → 权限」 |
| `scripts/build-pwa.mjs` | PWA manifest 的 `name` / `short_name` |

## 打包后怎么确认没漏

```bash
pnpm build:web && pnpm cap:sync && pnpm verify
```

`verify.mjs` 里三条相关断言：

- A 组：`dist/index.html` 的标题是 Deep Chat，且不残留 demo 字样
- A 组：main bundle 里含 `Deep Chat`，且不残留 `API 使用 demo`
- B 组：`aapt2 dump badging` 的 `application-label` 是 `Deep Chat`

再加 `pnpm accept` 的 A4：引导层标题必须含产品名且不含 demo 字样。
