/**
 * 移动端 fork 辅助命令 —— scripts/mobile-forks.mjs
 *
 * 三个动作：
 *   hash <上游相对路径>         打印该文件在 pin 住的上游提交里的 sha256（写进 manifest 用）
 *   new <上游相对路径> <fork相对路径>
 *                              从上游原文生成一份 fork 骨架（LF），并打印可直接粘贴的 manifest 片段
 *   check                      校验全部 manifest：fork 文件在不在、基线 hash 对不对
 *
 * 用法示例：
 *   node scripts/mobile-forks.mjs new src/components/session/Welcome.tsx overrides/session/Welcome.tsx
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PINNED_COMMIT, fail, info, paths, step } from './lib/env.mjs'
import {
  MOBILE_PATCHES,
  loadManifests,
  normalizeText,
  readUpstreamText,
  sha256Text,
} from './lib/mobile-overrides.mjs'

const args = process.argv.slice(2)
const command = args[0]

const hashOnly = (text) => createHash('sha256').update(normalizeText(text), 'utf8').digest('hex')

const printHash = async (to) => {
  const text = await readUpstreamText(to)
  process.stdout.write(`${hashOnly(text)}  ${to}\n`)
}

const scaffold = async (to, from) => {
  const upstream = await readUpstreamText(to)
  const full = join(MOBILE_PATCHES, from)
  if (existsSync(full)) {
    fail(`fork 已存在：web-patches/mobile/${from}`, '要重建先删掉它，避免覆盖手写内容。')
  }
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, normalizeText(upstream))
  info(`已生成 fork：web-patches/mobile/${from}`)
  process.stdout.write(`\n把这段加进对应 area 的 manifest：\n`)
  process.stdout.write(
    JSON.stringify(
      { overrides: [{ to, from, upstreamSha256: hashOnly(upstream) }] },
      null,
      2
    ).replace(/\n/g, '\n  ') + '\n'
  )
}

const check = async () => {
  step('校验移动端 fork')
  const manifests = loadManifests()
  if (manifests.length === 0) {
    info('没有 manifest，跳过')
    return
  }
  let failures = 0
  for (const { name, overrides } of manifests) {
    for (const entry of overrides) {
      const fork = join(MOBILE_PATCHES, entry.from)
      if (!existsSync(fork)) {
        process.stderr.write(`✗ ${name}: 缺少 fork 文件 web-patches/mobile/${entry.from}\n`)
        failures += 1
        continue
      }
      const upstream = await readUpstreamText(entry.to)
      const actual = hashOnly(upstream)
      if (actual !== entry.upstreamSha256) {
        process.stderr.write(
          `✗ ${name}: ${entry.to} 基线不符\n    记录 ${entry.upstreamSha256}\n    实际 ${actual}\n`
        )
        failures += 1
        continue
      }
      info(`✓ ${entry.to}`)
    }
  }
  if (failures > 0) {
    fail(`${failures} 个 fork 校验失败`, `上游 pin 在 ${PINNED_COMMIT.slice(0, 8)}，改动上游时要逐个人工确认。`)
  }
  info('全部通过')
}

const main = async () => {
  if (command === 'hash') {
    if (!args[1]) fail('用法：node scripts/mobile-forks.mjs hash <上游相对路径>')
    await printHash(args[1])
    return
  }
  if (command === 'new') {
    if (!args[1] || !args[2]) {
      fail('用法：node scripts/mobile-forks.mjs new <上游相对路径> <fork相对路径>')
    }
    await scaffold(args[1], args[2])
    return
  }
  if (command === 'check') {
    await check()
    return
  }
  fail('用法：node scripts/mobile-forks.mjs <hash|new|check> ...')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
