/**
 * 测试用 rspack 配置 —— 把一个 TS 入口打成可在浏览器里跑的 IIFE。
 *
 * 独立成文件（而不是由 test-import.mjs 生成字符串）的原因很实际：
 * 生成式写法要把正则转义两层，几乎必然写错（第一版就因为
 * `/\.(j|t)sx?$/` 被转成了 `/\\\\./` 导致 loader 完全不匹配，
 * 报的却是 "You may need an appropriate loader"，方向全错）。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = process.env.CHATDEMO_TEST_DIR ?? path.join(root, '.tmp', 'import-test')

/*
 * 注意：这里**不能** `import { rspack } from '@rspack/core'` ——
 * 本文件位于项目根的 scripts/，而 @rspack/core 只装在 web/node_modules 里，
 * 从 scripts/ 解析不到（jiti 会报 MODULE_NOT_FOUND，指向的还是这个配置文件）。
 *
 * 上游源码需要的编译期常量 __API_ORIGIN__ 改为在测试页的 HTML 里用
 * `var` 声明到全局（见 test-import.mjs 的 writeHtml），等价效果且零依赖。
 */

export default {
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(root, 'scripts', 'import-test.entry.ts'),
  output: {
    path: outDir,
    filename: 'bundle.js',
    clean: false,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    rules: [
      {
        test: /\.(j|t)sx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic' } },
            externalHelpers: true,
          },
          env: { targets: ['chrome >= 105'] },
        },
        type: 'javascript/auto',
      },
    ],
  },
  optimization: { minimize: false },
}
