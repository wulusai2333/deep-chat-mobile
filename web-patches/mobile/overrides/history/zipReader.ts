// mobile-shell: fast zip reader —— 本文件是上游 src/services/chat/history/zipReader.ts 的 fork。
//
// 【为什么 fork】
// 0.2.4 及之前用 prepare-web 的三段小补丁给上游加「缓存中央目录 / 统计条目数」。
// 真机反馈导入很慢，测量发现大头之一是**小块异步读太多**：
//   • 中央目录：677 个条目 × 每条目 3~4 次 file.slice().arrayBuffer()，共 2000+ 次；
//   • 每条目本地头：先读 30 字节，再读文件名，再读 extra（0 字节也要一次 await）。
// Android WebView 里每次 slice().arrayBuffer() 都要过一次浏览器进程，单次开销远大于桌面。
//
// 现在改成：
//   • 中央目录**一次读完**（EOCD 里本来就有 offset/size），在内存里同步解析；
//   • 每条目本地头 + 文件名**一次读完**，只有 extra 非空时才再读一次；
//   • 新增 readEntryBytes()：会话 JSON 直接拿字节解码，不再为 8 KB 一块造一个 Blob；
//   • ArchiveEntry 额外暴露 crc：导入方可以拿 (id, crc, size) 做「已导入过」的快速跳过。
// 语义、校验规则、错误类型（ArchiveError）与上游保持一致；上游 importArchive 仍可用
// readEntry() 拿到 Blob，不需要改任何上游代码。
//
// 这个 fork 由 web-patches/mobile/manifests/history.json 记录上游基线 sha256；
// 上游升级导致基线变化时 prepare-web / verify 会直接报错，不会静默覆盖。

import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024
// 中央目录上限：真实归档（677 条目）约 60 KB；8 MB 已经远超合理范围，防构造攻击。
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

/** ZIP64、分卷与加密文件不属于导出格式，一律拒绝。 */
const checkExtra = (bytes: Uint8Array) => {
  const view = viewOf(bytes)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || view.getUint16(offset, true) === 1) {
      invalid()
    }
    offset += 4 + view.getUint16(offset + 2, true)
    if (offset > bytes.length) {
      invalid()
    }
  }
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
  /** 中央目录里的 extra 长度；本地头可能不同，读取时以本地头为准 */
  extraLength: number
}

// mobile-shell: one-shot directory —— 中央目录只读一次、只解析一次。
// checkArchiveFormat / countZipEntries / readArchive 共用同一份结果（WeakMap 按 File 缓存；
// File 是不可变 Blob，不会读到过期内容，条目随 File 回收）。
const directoryCache = new WeakMap<File, Promise<{ entries: Entry[]; offset: number }>>()
export const readDirectoryCached = (file: File): Promise<{ entries: Entry[]; offset: number }> => {
  let pending = directoryCache.get(file)
  if (!pending) {
    pending = readDirectory(file)
    directoryCache.set(file, pending)
    void pending.catch(() => {
      directoryCache.delete(file)
    })
  }
  return pending
}

const readDirectory = async (file: File): Promise<{ entries: Entry[]; offset: number }> => {
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0 ||
    tailView.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== tailStart + end ||
    size > MAX_DIRECTORY_BYTES
  ) {
    invalid()
  }
  // mobile-shell: one slice —— 整份中央目录一次读完，之后全部同步解析。
  const directory = await readBytes(file, offset, size)
  const view = viewOf(directory)
  const entries: Entry[] = []
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const entrySize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(cursor + 32, true)
    const entryOffset = view.getUint32(cursor + 42, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      view.getUint16(cursor + 34, true) !== 0 ||
      ((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength)
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    checkExtra(directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(cursor + 16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
      extraLength,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  // mobile-shell: one slice —— 本地头 + 文件名一次读完；extra 只在非空时再读一次。
  const headerLength = 30 + entry.name.length
  if (entry.offset + headerLength > boundary) {
    invalid()
  }
  const header = await readBytes(file, entry.offset, headerLength)
  const view = viewOf(header)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  for (const [position, expected] of [
    [14, entry.crc],
    [18, entry.compressedSize],
    [22, entry.size],
  ]) {
    const actual = view.getUint32(position, true)
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  for (let index = 0; index < nameLength; index++) {
    if (entry.name[index] !== header[30 + index]) {
      invalid()
    }
  }
  if (extraLength > 0) {
    checkExtra(await readBytes(file, entry.offset + 30 + nameLength, extraLength))
  }
  if (entry.flags & 8) {
    if (end + 12 > boundary) {
      invalid()
    }
    const descriptor = viewOf(await readBytes(file, end, Math.min(16, boundary - end)))
    const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
    if (
      shift + 12 > descriptor.byteLength ||
      descriptor.getUint32(shift, true) !== entry.crc ||
      descriptor.getUint32(shift + 4, true) !== entry.compressedSize ||
      descriptor.getUint32(shift + 8, true) !== entry.size
    ) {
      invalid()
    }
  }
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  /** 中央目录里的 CRC-32；导入方用于「同一份内容已导入过」的快速判定 */
  crc: number
  stream: AsyncIterable<Uint8Array>
  /**
   * 跳过整个条目：只按压缩后长度读掉原始字节，不解压、不校验 CRC。
   * 只给「账本已确认导入过、且本次不会使用其数据」的条目用 —— 省掉一遍 inflate。
   * 头部/descriptor 与中央目录的一致性已由 readEntryOffset 校验过。
   */
  discard(): Promise<void>
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  // mobile-shell: cached directory —— 与 checkArchiveFormat / countZipEntries 共用
  const directory = await readDirectoryCached(file)
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    const start = await readEntryOffset(file, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    let completed = false
    let discarded = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        for (const byte of chunk) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
        const chunk = await readBytes(
          file,
          start + offset,
          Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield {
      path: entry.path,
      size: entry.size,
      crc: entry.crc,
      stream: stream(),
      // mobile-shell: discard —— 只读掉压缩字节，不解压。仅用于已确认导入过的条目。
      discard: async () => {
        for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
          await readBytes(
            file,
            start + offset,
            Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
          )
        }
        discarded = true
      },
    }
    if (!completed && !discarded) {
      invalid()
    }
  }
}

/**
 * mobile-shell: count zip entries —— 只读中央目录，返回可读条目数（不含目录项）。
 *
 * 供导入进度计算百分比用。只解析目录、不解压任何条目，
 * 因此在 30 MB 级别的归档上也只是读末尾几十 KB。
 */
export const countZipEntries = async (file: File): Promise<number> => {
  const directory = await readDirectoryCached(file)
  return directory.entries.filter((entry) => !entry.path.endsWith('/')).length
}

/**
 * mobile-shell: read entry bytes —— 读出整个条目到连续字节。
 *
 * 会话 JSON 直接 TextDecoder 解码即可，避免旧实现「每 8 KB 造一个 Blob、再拼合、再 .text()」
 * 在 Android WebView 里的大量 Blob/IPC 往返。
 * 不按 entry.size 预分配：那是归档声明的解压后大小，构造的压缩炸弹可以谎报成 4 GB。
 */
export const readEntryBytes = async (entry: ArchiveEntry): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of entry.stream) {
    chunks.push(chunk)
    total += chunk.length
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/** 读出整个条目：会话 JSON 需要完整解析，图片需要识别类型后整张保存。 */
export const readEntry = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Blob[] = []
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
  }
  return new Blob(parts)
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
