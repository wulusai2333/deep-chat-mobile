/**
 * 构建脚本共用的路径与命令封装。
 *
 * 所有脚本都在 Windows / macOS / Linux 上跑，因此：
 * - 一律用 Node 的 spawn 而不是 shell 内联命令（PowerShell 与 bash 的差异太多）。
 * - 一律用绝对路径，避免 cwd 漂移。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const paths = {
  root: ROOT,
  /** 上游 chat-demo 的 vendored 副本（git clone，钉在 PINNED_COMMIT） */
  web: join(ROOT, 'web'),
  /** 交给 Capacitor 的静态资源目录 */
  dist: join(ROOT, 'dist'),
  android: join(ROOT, 'android'),
  scripts: join(ROOT, 'scripts'),
  patches: join(ROOT, 'patches'),
  webPatches: join(ROOT, 'web-patches'),
  native: join(ROOT, 'native'),
  docs: join(ROOT, 'docs'),
  /** APK 产物落地目录 */
  outApk: join(ROOT, 'dist-apk'),
  pwa: join(ROOT, 'pwa-dist'),
}

/** 上游 chat-demo 的基线提交（v0.1.1）。改动上游前先看 docs/build.md。 */
export const UPSTREAM_REPO = 'https://github.com/deepseek-ai/chat-demo.git'
export const PINNED_COMMIT = '5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c'

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export const pkgVersion = () => readJson(join(ROOT, 'package.json')).version

export const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const mustExist = (file, hint) => {
  if (!existsSync(file)) {
    throw new Error(`缺少 ${file}${hint ? `：${hint}` : ''}`)
  }
  return file
}

/** 每个 step 都会打印一行，方便从零复现时定位卡在哪一步 */
export const step = (message) => {
  process.stdout.write(`\n\u001b[36m▸ ${message}\u001b[0m\n`)
}

export const info = (message) => process.stdout.write(`  ${message}\n`)

export const warn = (message) => process.stdout.write(`  \u001b[33m! ${message}\u001b[0m\n`)

/** 统一的失败出口：给出可执行的下一步，而不是抛一串堆栈 */
export const fail = (message, hint) => {
  process.stderr.write(`\n\u001b[31m✗ ${message}\u001b[0m\n`)
  if (hint) {
    process.stderr.write(`${hint.split('\n').map((line) => `  ${line}`).join('\n')}\n`)
  }
  process.exit(1)
}

/**
 * 在 shell 模式下，Node 会把 argv 用空格拼成一条命令行，再由 cmd.exe 重新解析。
 * 这意味着任何含空格或 cmd 元字符的参数都会被拆开 —— 典型受害者是
 * keytool 的 `-dname "CN=Deep Chat, O=DeepChat"`。
 *
 * 所以 shell 模式下必须自己加引号；非 shell 模式（直接 spawn 可执行文件）不能加，
 * 否则引号会变成参数内容的一部分。
 */
const quoteForShell = (value) => {
  const text = String(value)
  // cmd.exe 里没有安全的单引号，只能用双引号；内部双引号需要转义成 ""
  if (!/[\s"&|<>^()]/.test(text)) {
    return text
  }
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 跑一个子进程并把输出直通到终端。
 * shell: true 是为了在 Windows 上能解析 .cmd（pnpm / gradlew 都是 .cmd）。
 *
 * 注意 command 本身也要引号：Node 在 shell 模式下把 `command args...` 直接拼成
 * 一行交给 cmd.exe，`C:\Program Files\...\chrome.exe` 会在空格处被截断成
 * 「'C:\Program' 不是内部或外部命令」。可执行文件路径含空格是常见情况。
 */
export const run = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const shell = process.platform === 'win32'
    const child = spawn(
      shell ? quoteForShell(command) : command,
      shell ? args.map(quoteForShell) : args,
      {
        cwd: options.cwd ?? ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...options.env },
        shell,
      }
    )
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new Error(`${command} ${args.join(' ')} 退出码 ${code}${options.label ? `（${options.label}）` : ''}`)
      )
    })
  })

/** 需要读输出但不打印时用（例如解析 gradle 产物路径） */
export const capture = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const shell = process.platform === 'win32'
    const chunks = []
    const errors = []
    const child = spawn(
      shell ? quoteForShell(command) : command,
      shell ? args.map(quoteForShell) : args,
      {
        cwd: options.cwd ?? ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
        shell,
      }
    )
    child.stdout.on('data', (data) => chunks.push(data))
    child.stderr.on('data', (data) => errors.push(data))
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8')
      const stderr = Buffer.concat(errors).toString('utf8')
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} 退出码 ${code}\n${stderr || stdout}`))
    })
  })
