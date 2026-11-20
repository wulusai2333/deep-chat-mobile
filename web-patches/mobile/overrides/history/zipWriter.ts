// mobile-shell: deflate export —— 本文件是上游 src/services/chat/history/zipWriter.ts 的 fork。
//
// 【为什么改】上游 writeArchive 用 ZipPassThrough，所有条目一律 STORE（不压缩）。
// 用户实测同一份数据：官方导出 31.3 MB，我们导出 52.2 MB —— 差异全在这里：
//   官方：chat_sessions/*.json   33.7 MB → 11.6 MB（deflate）
//         chat_sessions/*_files/ 19.6 MB → 19.6 MB（STORE，图片再压几乎没收益）
//   我们：全部 STORE → 33.7 + 19.6 ≈ 52 MB
// 现在与官方一致：`.json` 走 deflate，图片原件原样 STORE。体积回到约 31 MB，
// 导入前备份也一起变小（备份阶段在真机上要 19.9 s，主要就是上传这份 ZIP）。
//
// 【为什么 level 固定在一个常量】导出与备份走同一个 writeArchive；level 越高体积越小、
// CPU 越贵。官方 33.7→11.6 MB 的压缩比与 zlib 默认 6 吻合，所以默认 6；
// 若真机上导出/备份反而变慢，改这一个常量即可（4 大约快 1.5~2 倍、体积多 5~10%）。
//
// 【兼容性】ZIP 仍是 v3 结构；我们的 zipReader（fork）与桌面 chat-demo 的上游 reader
// 都支持 method 8（deflate）和 data descriptor；旧的 STORE 导出仍可导入。
//
// 由 web-patches/mobile/manifests/history.json 记录上游基线 sha256，上游一动 prepare 就报错。

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'

// ZIP32 字段中的哨兵值表示需要 ZIP64；当前格式不支持 ZIP64。
const ZIP64_SIZE = 0xffffffff
const ZIP64_COUNT = 0xffff

/**
 * deflate 压缩级别（0–9）。6 = zlib 默认，和官方导出体积最接近；
 * 真机 CPU 吃紧时可降到 4（体积略大）。
 */
const DEFLATE_LEVEL = 6

export class ArchiveLimitError extends Error {
  constructor() {
    super('History archive requires unsupported ZIP64 fields')
    this.name = 'ArchiveLimitError'
  }
}

const invalid = (): never => {
  throw new Error('Invalid history archive entry')
}

/** 与读取端保持相同路径规则，成品必须能再次导入。 */
const entryName = (name: string) => {
  const normalized = name.normalize('NFC')
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid()
  }
  const bytes = new TextEncoder().encode(normalized)
  if (bytes.length > 0xffff) {
    throw new ArchiveLimitError()
  }
  // 拒绝孤立代理项，避免编码时替换成 U+FFFD 后改变附件的关联路径。
  if (new TextDecoder().decode(bytes) !== normalized) {
    invalid()
  }
  return { name: normalized, byteLength: bytes.length }
}

/** `.json` 压缩、其余（图片原件）原样写入；成品必须能再次导入。 */
export const writeArchive = async (entries: { name: string; blob: Blob }[]): Promise<Blob> => {
  if (entries.length >= ZIP64_COUNT) {
    throw new ArchiveLimitError()
  }
  const names = new Set<string>()
  let dataSize = 0
  let directorySize = 0
  const prepared = entries.map(({ name, blob }) => {
    const normalized = entryName(name)
    if (names.has(normalized.name)) {
      invalid()
    }
    names.add(normalized.name)
    if (blob.size >= ZIP64_SIZE) {
      throw new ArchiveLimitError()
    }
    dataSize += blob.size + 46 + normalized.byteLength
    directorySize += 46 + normalized.byteLength
    if (dataSize >= ZIP64_SIZE || directorySize >= ZIP64_SIZE) {
      throw new ArchiveLimitError()
    }
    return { name: normalized.name, blob }
  })

  // 上界：deflate 的输出体积事前未知（不可压数据还可能略微膨胀），
  // 所以不再用 STORE 时代的「严格相等」，改为「不超过原始大小 + 每条目余量」。
  const expectedSize = dataSize + directorySize + 22 + prepared.length * 64
  const chunks: Blob[] = []
  let size = 0
  let completed = false
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      throw error
    }
    size += chunk.byteLength
    if (size > expectedSize) {
      invalid()
    }
    chunks.push(new Blob([chunk]))
    completed = final
  })
  try {
    for (const { name, blob } of prepared) {
      // 与官方一致：会话/索引 JSON 压缩，图片原件原样存放。
      const entry = name.endsWith('.json')
        ? new ZipDeflate(name, { level: DEFLATE_LEVEL })
        : new ZipPassThrough(name)
      entry.mtime = new Date(1980, 0, 1)
      zip.add(entry)
      const reader = blob.stream().getReader()
      let written = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          written += value.byteLength
          if (written > blob.size) {
            invalid()
          }
          entry.push(value)
        }
        if (written !== blob.size) {
          invalid()
        }
        entry.push(new Uint8Array(), true)
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    zip.end()
    if (!completed || size > expectedSize) {
      invalid()
    }
    return new Blob(chunks, { type: 'application/zip' })
  } finally {
    zip.terminate()
  }
}
