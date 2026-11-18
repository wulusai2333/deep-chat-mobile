/**
 * 真实 ZIP 探针的 rspack 配置 —— 与 import-test.rspack.config.mjs 同理，
 * 独立成文件以免生成式转义出错。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = process.env.DEEPCHAT_PROBE_DIR ?? path.join(root, '.tmp', 'real-zip')

export default {
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(root, 'scripts', 'probe.entry.ts'),
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
