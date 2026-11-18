/**
 * 生成应用图标集 —— scripts/make-icons.mjs
 *
 * 源图：`assets/app-icon.jpeg`（1007×1007）。这个脚本负责把它渲染成
 * Android 各密度图标 + 自适应图标两层 + PWA 图标。
 *
 * 【为什么不用 @capacitor/assets】
 * 那个工具会顺带重写 styles.xml / colors.xml / splash 资源，容易踩到
 * Capacitor 生成的既有配置（我们已经在 build.gradle 里定制过主题）。
 * 这里只做一件事：把一张源图缩成各密度图标，别的一律不碰。
 *
 * 【为什么手写缩图而不用 sharp / canvas】
 * 只做「降采样 + 遮罩」两件事，用 area-average（面积平均）就够了，
 * 而且它是降采样的正确算法 —— 双线性在缩小时会漏掉像素产生锯齿。
 * 省掉一个带原生二进制的依赖，Windows 上少一类装不上的风险。
 * JPEG 解码用纯 JS 的 jpeg-js（无原生依赖）。
 *
 * 【构图：整图铺满】
 * Android 自适应图标的画布是 108dp，但启动器只会露出中间 72dp 的安全区
 * （具体遮罩形状由 OEM 决定：圆形 / 圆角方 / squircle）。
 * 所以前景层按 108dp 满幅铺图 —— 视觉上图标是「填满」的，
 * 代价是四周约 33% 会被遮罩裁掉。这是照片类图标的常规做法。
 *
 * 【monochrome 层为什么不用照片】
 * Android 13+ 的「主题图标」会把 monochrome 层当蒙版染色。
 * 如果把照片塞进去，得到的就是一团灰糊。所以单独画一个纯白的
 * 对话气泡剪影，主题图标才是干净的。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import jpeg from 'jpeg-js'
import { fail, info, paths, step } from './lib/env.mjs'

/** 源图路径（相对项目根） */
const SOURCE = join(paths.root, 'assets', 'app-icon.jpeg')

/** 各密度对应边长（与 Android 规范一致） */
const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]

/** 前景层：自适应图标用，尺寸是各密度的 108dp 基准 */
const FOREGROUND_DENSITIES = [
  ['mdpi', 108],
  ['hdpi', 162],
  ['xhdpi', 216],
  ['xxhdpi', 324],
  ['xxxhdpi', 432],
]

// ── 最小 PNG 编码器 ────────────────────────────────────────────────────────
// 只需要 RGBA8、无隔行，所以手写比引入 pngjs 更轻。zlib 由 node 内置提供。

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** rgba: Uint8Array，长度 = size*size*4 */
const encodePng = (rgba, size) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行前置一个 filter byte（0 = None）
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 图像处理 ──────────────────────────────────────────────────────────────

/** 解码源图，统一成 RGBA 的 Uint8Array */
const loadSource = () => {
  let bytes
  try {
    bytes = readFileSync(SOURCE)
  } catch {
    fail('找不到图标源图', `期望 ${SOURCE}\n把它放在 assets/app-icon.jpeg，或改本脚本里的 SOURCE`)
  }
  const raw = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 })
  if (!raw?.data || !raw.width) {
    fail('图标源图解码失败', `${SOURCE} 不是有效的 JPEG`)
  }
  return { width: raw.width, height: raw.height, data: raw.data }
}

/**
 * 面积平均降采样。
 *
 * 【为什么用 area-average 而不是最近邻 / 双线性】
 * 从 1007 缩到 48 是 21 倍降采样：最近邻会直接丢像素（细节变噪点），
 * 双线性只采样 4 个邻点，同样会把细节混叠成假纹理。
 * 面积平均把目标像素覆盖的整个源矩形做加权平均，是降采样的正确做法，
 * 缩到 48px 也能看清整体构图。
 */
const resize = (src, dw, dh) => {
  const { width: sw, height: sh, data } = src
  const out = new Uint8Array(dw * dh * 4)
  const scaleX = sw / dw
  const scaleY = sh / dh

  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = dy * scaleY
    const y1 = y0 + scaleY
    const iy0 = Math.floor(y0)
    const iy1 = Math.min(sh - 1, Math.ceil(y1) - 1)
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = dx * scaleX
      const x1 = x0 + scaleX
      const ix0 = Math.floor(x0)
      const ix1 = Math.min(sw - 1, Math.ceil(x1) - 1)

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weightSum = 0
      for (let sy = iy0; sy <= iy1; sy += 1) {
        // 该源行落在目标像素纵向区间内的占比
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = ix0; sx <= ix1; sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (wx <= 0) continue
          const w = wx * wy
          const i = (sy * sw + sx) * 4
          r += data[i] * w
          g += data[i + 1] * w
          b += data[i + 2] * w
          a += data[i + 3] * w
          weightSum += w
        }
      }
      const o = (dy * dw + dx) * 4
      if (weightSum > 0) {
        out[o] = Math.round(r / weightSum)
        out[o + 1] = Math.round(g / weightSum)
        out[o + 2] = Math.round(b / weightSum)
        out[o + 3] = Math.round(a / weightSum)
      }
    }
  }
  return out
}

/**
 * 取画面的主品牌色：在饱和度最高的那批像素里做平均。
 *
 * 【为什么不能用四边平均】
 * 源图边框有深色、米白、蓝紫多种颜色，四边平均下来是一个浑浊的灰
 * （实测 #555763）。这个颜色一旦用在 maskable 图标的补边上，
 * 就会看到一圈脏灰色边框。主品牌色应该是画面里那一块蓝紫。
 *
 * 做法：先筛掉低饱和（黑/白/灰）像素，再在剩下的里取平均。
 * 这样「有彩色」的部分说了算，外围的黑白不参与。
 */
const dominantColor = (src) => {
  const { data } = src
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  const buckets = new Map()
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i]
    const G = data[i + 1]
    const B = data[i + 2]
    const max = Math.max(R, G, B)
    const min = Math.min(R, G, B)
    if (max < 60) continue // 太暗，多半是背景
    // 饱和度（HSV 口径）
    const sat = (max - min) / max
    if (sat < 0.25) continue // 黑白灰不算品牌色
    r += R
    g += G
    b += B
    n += 1
    // 同时统计出现最多的色相区间，用于兜底
    const key = `${R >> 4}-${G >> 4}-${B >> 4}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  if (n === 0) {
    return [0x1b, 0x1f, 0x2b] // 源图没有彩色（理论上不会走到），回落到项目深色
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

/**
 * 给图加遮罩。`inside(x, y)` 返回 true 表示该点保留。
 * 用 4×4 超采样算覆盖率，边缘才有抗锯齿。
 */
const applyMask = (rgba, size, inside) => {
  const S = 4
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let cov = 0
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) {
            cov += 1
          }
        }
      }
      const o = (y * size + x) * 4
      if (cov === 0) {
        continue
      }
      const a = cov / (S * S)
      out[o] = rgba[o]
      out[o + 1] = rgba[o + 1]
      out[o + 2] = rgba[o + 2]
      out[o + 3] = Math.round(a * 255)
    }
  }
  return out
}

/** 圆角矩形遮罩（legacy 方形图标用） */
const roundRectMask = (size, radiusRatio = 0.2) => {
  const r = size * radiusRatio
  return (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
}

/** 圆形遮罩（ic_launcher_round 用） */
const circleMask = (size) => {
  const c = size / 2
  const r = size / 2
  return (x, y) => (x - c) ** 2 + (y - c) ** 2 <= r * r
}

/**
 * monochrome 层：纯白对话气泡剪影（Android 13+ 主题图标用）。
 * 画成实心气泡 + 左下角尾巴，形状简单，染色后辨识度高。
 */
const drawMonochrome = (size) => {
  const S = 4
  const out = new Uint8Array(size * size * 4)

  const left = size * 0.18
  const right = size * 0.82
  const top = size * 0.24
  const bottom = size * 0.70
  const radius = size * 0.14

  const inRoundRect = (x, y, l, t, r2, b, rad) => {
    if (x < l || x > r2 || y < t || y > b) return false
    const cx = Math.min(Math.max(x, l + rad), r2 - rad)
    const cy = Math.min(Math.max(y, t + rad), b - rad)
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
  }

  // 尾巴：从气泡左下沿向外下方伸出的三角
  const tailX0 = size * 0.28
  const tailX1 = size * 0.46
  const tailY0 = bottom - size * 0.02
  const tailY1 = size * 0.82
  const inTail = (x, y) => {
    if (y < tailY0 || y > tailY1) return false
    if (x < tailX0) return false
    const t = (y - tailY0) / (tailY1 - tailY0)
    // 越往下越窄，收成尖
    return x <= tailX1 - t * (tailX1 - tailX0)
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let cov = 0
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S
          const py = y + (sy + 0.5) / S
          if (inRoundRect(px, py, left, top, right, bottom, radius) || inTail(px, py)) {
            cov += 1
          }
        }
      }
      if (cov === 0) continue
      const o = (y * size + x) * 4
      out[o] = 0xff
      out[o + 1] = 0xff
      out[o + 2] = 0xff
      out[o + 3] = Math.round((cov / (S * S)) * 255)
    }
  }
  return out
}

const writePng = (filePath, rgba, size) => {
  writeFileSync(filePath, encodePng(rgba, size))
}

/**
 * 自检：确认产出的 PNG 不是空白 / 全透明。
 * 这几行代码的价值在于：如果哪天源图被换成了纯色图、或者解码出问题，
 * 构建立刻失败，而不是发一个全是空白图标的包出去。
 */
const sanityCheck = (rgba, size, label) => {
  let opaque = 0
  let sum = 0
  const buckets = new Set()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 200) {
      opaque += 1
      sum += rgba[i] + rgba[i + 1] + rgba[i + 2]
      // 粗略量化颜色，用来判断是不是单色块
      buckets.add(
        ((rgba[i] >> 5) << 6) | ((rgba[i + 1] >> 5) << 3) | (rgba[i + 2] >> 5)
      )
    }
  }
  const opaqueRatio = opaque / (size * size)
  if (opaque === 0) {
    fail(`图标自检失败：${label} 完全透明`)
  }
  // 照片型图标必然有大量不同颜色；单色块说明源图或解码出了问题
  if (label !== 'monochrome' && buckets.size < 8) {
    fail(
      `图标自检失败：${label} 只有 ${buckets.size} 种颜色，疑似空白图`,
      '检查 assets/app-icon.jpeg 是否是有效照片'
    )
  }
  return { opaqueRatio, colors: buckets.size, mean: Math.round(sum / (opaque * 3)) }
}

const main = () => {
  step('生成图标')

  const src = loadSource()
  info(`源图 ${src.width}×${src.height}`)
  const brand = dominantColor(src)
  const brandHex = `#${brand.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
  info(`主品牌色 ${brandHex}（用作自适应图标背景与 maskable 补边）`)

  const res = join(paths.android, 'app', 'src', 'main', 'res')
  const stats = []
  let count = 0

  // ── 1. legacy 图标（API 24–25 用得到；API 26+ 优先走自适应）──
  for (const [density, size] of DENSITIES) {
    const dir = join(res, `mipmap-${density}`)
    mkdirSync(dir, { recursive: true })
    const scaled = resize(src, size, size)

    // 方形图标：加圆角，避免在某些启动器上露出生硬的直角
    const square = applyMask(scaled, size, roundRectMask(size, 0.2))
    writePng(join(dir, 'ic_launcher.png'), square, size)
    stats.push([`mipmap-${density}/ic_launcher.png`, sanityCheck(square, size, `ic_launcher-${density}`)])

    // 圆形图标：部分启动器会挑这个
    const round = applyMask(scaled, size, circleMask(size))
    writePng(join(dir, 'ic_launcher_round.png'), round, size)
    stats.push([`mipmap-${density}/ic_launcher_round.png`, sanityCheck(round, size, `round-${density}`)])
    count += 2
  }

  // ── 2. 自适应图标前景（108dp 满幅铺图，四周交给系统遮罩裁切）──
  for (const [density, size] of FOREGROUND_DENSITIES) {
    const dir = join(res, `mipmap-${density}`)
    mkdirSync(dir, { recursive: true })
    const foreground = resize(src, size, size) // 满幅，不缩进
    writePng(join(dir, 'ic_launcher_foreground.png'), foreground, size)
    stats.push([
      `mipmap-${density}/ic_launcher_foreground.png`,
      sanityCheck(foreground, size, `foreground-${density}`),
    ])
    count += 1
  }

  // ── 3. monochrome 层（主题图标）──
  for (const [density, size] of FOREGROUND_DENSITIES) {
    const dir = join(res, `mipmap-${density}`)
    const mono = drawMonochrome(size)
    writePng(join(dir, 'ic_launcher_monochrome.png'), mono, size)
    count += 1
  }

  // ── 4. 自适应图标描述 ──
  const anydpi = join(res, 'mipmap-anydpi-v26')
  mkdirSync(anydpi, { recursive: true })
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`
  writeFileSync(join(anydpi, 'ic_launcher.xml'), adaptive)
  writeFileSync(join(anydpi, 'ic_launcher_round.xml'), adaptive)
  count += 2

  // ── 5. 背景色资源（取自源图边框，遮罩边缘不会出现色差）──
  const values = join(res, 'values')
  mkdirSync(values, { recursive: true })
  const colorXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 取自源图边框主色，由 scripts/make-icons.mjs 生成；改图标时同步更新 -->
    <color name="ic_launcher_background">${brandHex}</color>
</resources>
`
  writeFileSync(join(values, 'ic_launcher_background.xml'), colorXml)
  count += 1

  // ── 6. 网页图标（PWA）──
  // 不能写进 dist/：rspack 的 output.clean=true 每次构建都会清空整个 dist，
  // 写在那里下次 build:web 就没了。所以落到项目根的 pwa-icons/ 作为源，
  // 由 scripts/build-pwa.mjs 在组装 PWA 时拷进产物。
  const webIcons = join(paths.root, 'pwa-icons')
  mkdirSync(webIcons, { recursive: true })
  const icon192 = resize(src, 192, 192)
  writePng(join(webIcons, 'icon-192.png'), applyMask(icon192, 192, roundRectMask(192, 0.18)), 192)
  const icon512 = resize(src, 512, 512)
  writePng(join(webIcons, 'icon-512.png'), applyMask(icon512, 512, roundRectMask(512, 0.18)), 512)
  // maskable：按规范内容要落在中心 80% 的安全圆内。这里缩进后四周用背景色补齐，
  // 否则系统裁圆形时会切到图的四个角。
  const maskSafe = 512 * 0.8
  const inner = resize(src, Math.round(maskSafe), Math.round(maskSafe))
  const maskable = new Uint8Array(512 * 512 * 4)
  const offset = Math.round((512 - maskSafe) / 2)
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) {
      const o = (y * 512 + x) * 4
      const ix = x - offset
      const iy = y - offset
      if (ix >= 0 && iy >= 0 && ix < maskSafe && iy < maskSafe) {
        const i = (iy * Math.round(maskSafe) + ix) * 4
        maskable[o] = inner[i]
        maskable[o + 1] = inner[i + 1]
        maskable[o + 2] = inner[i + 2]
        maskable[o + 3] = 255
      } else {
        maskable[o] = brand[0]
        maskable[o + 1] = brand[1]
        maskable[o + 2] = brand[2]
        maskable[o + 3] = 255
      }
    }
  }
  writePng(join(webIcons, 'icon-maskable-512.png'), maskable, 512)
  count += 3

  // ── 7. 本地用户默认头像（与 App 图标同一张源图）──
  // 抽屉底部账户行默认显示 App 图标；用户可换成自己的图片（见 localAvatar.ts）。
  // 内联成 data URL 的原因：上游 rspack 配置没有图片资源规则，加一个 loader 只为了
  // 一张 32px 的头像不值得；而且内联后不需要 cap:sync 额外拷资源。
  const avatarSize = 192
  const avatarRgba = resize(src, avatarSize, avatarSize)
  const avatarJpeg = jpeg.encode(
    {
      data: Buffer.from(avatarRgba.buffer, avatarRgba.byteOffset, avatarRgba.byteLength),
      width: avatarSize,
      height: avatarSize,
    },
    82
  ).data
  const avatarDataUrl = `data:image/jpeg;base64,${avatarJpeg.toString('base64')}`
  const avatarFile = join(paths.root, 'web-patches', 'mobile', 'common', 'app-icon-data.ts')
  const avatarSource = `/**
 * 本地用户默认头像 —— 自动生成，勿手改。
 *
 * 源图：assets/app-icon.jpeg（与 APK 图标同一张），${avatarSize}×${avatarSize} JPEG，内联为 data URL。
 * 由 scripts/make-icons.mjs 生成：换图标后跑 pnpm icons 重新生成。
 *
 * 为什么内联：上游 rspack 没有图片资源规则；头像只有一处 32px 用途，
 * 内联可以避免为一张图新增 loader 或 cap:sync 额外资源。
 * 用户自选头像存在 localStorage（见 localAvatar.ts），不写入本文件。
 */
export const APP_ICON_DATA_URL =
  '${avatarDataUrl}'
`
  let previousAvatar = ''
  try {
    previousAvatar = readFileSync(avatarFile, 'utf8')
  } catch {
    // 首次生成
  }
  if (previousAvatar !== avatarSource) {
    writeFileSync(avatarFile, avatarSource)
    info(`默认头像数据已更新：${avatarFile}`)
  } else {
    info('默认头像数据未变化')
  }

  info(`共生成 ${count} 个资源`)
  info(`Android: ${join(res, 'mipmap-*')}`)
  info(`Web/PWA: ${webIcons}`)
  // 打印几个关键尺寸的自检数据，方便肉眼判断「有没有画上去」
  for (const [name, s] of stats.filter(([n]) => n.includes('144') || n.includes('192.png'))) {
    info(`  ${name}: 不透明 ${(s.opaqueRatio * 100).toFixed(0)}%，${s.colors} 色，均亮 ${s.mean}`)
  }
}

main()
