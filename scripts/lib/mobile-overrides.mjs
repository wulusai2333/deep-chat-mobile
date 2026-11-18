/**
 * 移动端覆盖层（web-patches/mobile）的注入与 fork 校验。
 *
 * 【为什么要有这一层】
 * `web/` 是上游 chat-demo 的 vendored clone，每次 `prepare-web` 都可能被重建。
 * 这次移动端要按官方 App 改 UI，改动量远超「锚点 + 小段插入」能维护的范围：
 * 有的上游组件需要整文件重写。整文件重写如果直接写进 `web/src/`，下次重建就丢了；
 * 如果只写个 `replaceOnce` 把整文件内容塞进脚本，脚本会变成几千行且无法对比 diff。
 *
 * 所以引入第三种补丁形态：fork。
 * - fork 源文件保存在 `web-patches/mobile/overrides/<上游路径>`，可正常 diff / review；
 * - manifest 记录「基于上游哪个内容（sha256）」；
 * - 应用时三方比对：已是 fork → 跳过；仍是上游原文 → 换成 fork；都不是 → 报错。
 *
 * 【为什么要记 upstreamSha256】
 * fork 说到底是「这份上游文件我改了」。上游哪怕只是升级了 PINNED_COMMIT，
 * 我们的 fork 也可能悄悄覆盖掉上游的修复。记下基线 hash 后，上游一动就明确报错，
 * 而不是静默生效。这是本项目一贯的原则：静默失败比报警更危险。
 *
 * 行尾统一按 LF 归一化后再算 hash：Windows 检出是 CRLF，git show 是 LF，
 * 不归一化会得到两个「不同」的同一份文件。
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { PINNED_COMMIT, capture, fail, info, paths } from './env.mjs'

/** 我们的移动端补丁根目录（源码真源） */
export const MOBILE_PATCHES = join(paths.webPatches, 'mobile')
/** 每次 prepare 重建的注入目标 */
export const MOBILE_TARGET = join(paths.web, 'src', 'mobile')
const MANIFEST_DIR = join(MOBILE_PATCHES, 'manifests')

const IGNORED_DIRS = new Set(['manifests', 'overrides'])

export const normalizeText = (text) => text.replace(/\r\n/g, '\n')

export const sha256Text = (text) =>
  createHash('sha256').update(normalizeText(text), 'utf8').digest('hex')

/** 读上游 pin 住的那个版本的文件内容（LF） */
export const readUpstreamText = async (to) => {
  try {
    const { stdout } = await capture('git', ['-C', paths.web, 'show', `${PINNED_COMMIT}:${to}`])
    return stdout
  } catch {
    fail(`读不到上游文件：${to}`, '确认路径相对 web/，且它在上游 pin 的提交里存在。')
    return ''
  }
}

/** 读取全部 area manifest，按文件名排序保证重放顺序稳定 */
export const loadManifests = () => {
  if (!existsSync(MANIFEST_DIR)) {
    return []
  }
  return readdirSync(MANIFEST_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(MANIFEST_DIR, name), 'utf8')
      let data
      try {
        data = JSON.parse(raw)
      } catch (error) {
        fail(`mobile manifest 解析失败：${name}`, String(error))
      }
      if (!data || !Array.isArray(data.overrides)) {
        fail(`mobile manifest 格式不对：${name}`, '需要 { "overrides": [...] }，参考 docs/mobile-ui-spec.md §1.2。')
      }
      return { name, overrides: data.overrides }
    })
}

/** 把 web-patches/mobile 下除 manifests/overrides 之外的所有文件注入 web/src/mobile/ */
export const injectMobileSources = () => {
  if (!existsSync(MOBILE_PATCHES)) {
    info('没有 web-patches/mobile，跳过移动端覆盖层')
    return
  }
  rmSync(MOBILE_TARGET, { recursive: true, force: true })
  mkdirSync(MOBILE_TARGET, { recursive: true })

  let count = 0
  const copyTree = (source, target) => {
    for (const entry of readdirSync(source)) {
      if (source === MOBILE_PATCHES && IGNORED_DIRS.has(entry)) {
        continue
      }
      const from = join(source, entry)
      const to = join(target, entry)
      if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true })
        copyTree(from, to)
        continue
      }
      cpSync(from, to)
      count += 1
    }
  }
  copyTree(MOBILE_PATCHES, MOBILE_TARGET)
  info(`注入 ${count} 个移动端文件 → web/src/mobile/`)
}

/**
 * 应用 fork 覆盖。返回统计，便于 prepare 里打印。
 * 幂等：已应用过的再跑一次不会重复写。
 */
export const applyMobileOverrides = async () => {
  const manifests = loadManifests()
  let applied = 0
  let skipped = 0
  for (const { name, overrides } of manifests) {
    for (const entry of overrides) {
      if (!entry.to || !entry.from) {
        fail(`${name}: override 缺少 to / from`, '参考 docs/mobile-ui-spec.md §1.2。')
      }
      const target = join(paths.web, entry.to)
      const fork = join(MOBILE_PATCHES, entry.from)
      if (!existsSync(fork)) {
        fail(`${name}: fork 源不存在`, `缺少 web-patches/mobile/${entry.from}`)
      }
      const forkText = readFileSync(fork, 'utf8')
      const forkHash = sha256Text(forkText)
      const upstreamText = await readUpstreamText(entry.to)
      const upstreamHash = sha256Text(upstreamText)
      if (entry.upstreamSha256 !== upstreamHash) {
        fail(`${name}: ${entry.to} 的上游基线已变化，fork 不能盲目套用`, [
          `manifest 记录：${entry.upstreamSha256 ?? '(缺失)'}`,
          `上游当前：  ${upstreamHash}（${PINNED_COMMIT.slice(0, 8)}）`,
          '上游升了版本或记录写错。人工确认 fork 是否仍适用后更新 manifest（node scripts/mobile-forks.mjs hash <路径>）。',
        ].join('\n'))
      }
      const currentText = existsSync(target) ? readFileSync(target, 'utf8') : null
      if (currentText !== null && sha256Text(currentText) === forkHash) {
        skipped += 1
        continue
      }
      // 【为什么直接覆盖而不是报错】
      // 并行开发时 fork 会连续改几版：web/src 里留着上一版 fork，既不是上游原文也不是
      // 最新 fork。以前这里直接报错，导致别人构建时必须手工 `git checkout` 才能继续。
      // 但 web/ 是生成物（docs/build.md 已明确「不要手改，会被覆盖」），覆盖是正确语义；
      // 上游漂移已经由上面的 upstreamSha256 校验拦住，这里不需要再保守。
      if (currentText !== null && sha256Text(currentText) !== upstreamHash) {
        info(`${entry.to}: 旧的 fork / 手工改动被最新 fork 覆盖（web/ 是生成物）`)
      }
      writeFileSync(target, forkText)
      applied += 1
    }
  }
  info(`移动端 fork：应用 ${applied} 个，已是最新 ${skipped} 个（${manifests.length} 个 area）`)
}
