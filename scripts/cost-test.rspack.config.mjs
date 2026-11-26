/**
 * 峰谷计价测试的 rspack 配置 —— 把 scripts/cost-test.entry.ts 打成浏览器可跑的 IIFE。
 *
 * 与 import-test.rspack.config.mjs 同构（同一套 swc-loader 与扩展名别名），
 * 单独成文件的理由也一样：Loader 正则写错时的报错（"You may need an appropriate loader"）
 * 指向的是配置表达方式，而不是真正的类型/语法问题，放在配置文件里更容易 diff。
 *
 * 被测算的 pricing.ts 不依赖 DOM，所以同一份 bundle 也能在无浏览器时用 Node 执行。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = process.env.DEEPCHAT_TEST_DIR ?? path.join(root, '.tmp', 'cost-test')

/*
 * 注意：这里不能 `import { rspack } from '@rspack/core'` —— 本文件在项目根的
 * scripts/ 下，而 @rspack/core 只装在 web/node_modules 里，从 scripts/ 解析不到。
 * 打包由 test-cost.mjs 调用 web 下的 rspack CLI 完成，本文件只描述配置。
 */

export default {
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(root, 'scripts', 'cost-test.entry.ts'),
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
