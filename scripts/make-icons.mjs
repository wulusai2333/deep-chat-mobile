/**
 * 生成应用图标集 —— scripts/make-icons.mjs
 *
 * 【为什么手写而不装 @capacitor/assets】
 * 那个工具会顺带重写 styles.xml / colors.xml / splash 资源，容易踩到
 * Capacitor 生成的既有配置（我们已经在 build.gradle 里定制过主题）。
 * 这里只做一件事：把一张源图缩成各密度图标，别的一律不碰。
 *
 * 【为什么是纯 JS 生成而不是读现成 PNG】
 * 项目不想额外提交二进制素材，也不想依赖 ImageMagick（Windows 上不一定有）。
 * 所以直接按像素画：一个圆角方块 + 中间对话框形状。
 * 好处是完全可复现、无外部依赖；坏处是不支持复杂图形 —— 对这个项目够用。
 *
 * 【Android 自适应图标】
 * API 26+ 用 mipmap-anydpi-v26/ic_launcher.xml 描述前景/背景两层。
 * 前景要留安全边距（系统会裁成各种形状），所以内容只占中间约 60%。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { info, paths, step } from './lib/env.mjs'

/** 品牌色：与 App 内主色一致（深蓝底 + 白图形） */
const BRAND_BG = [0x1b, 0x1f, 0x2b]
const BRAND_FG = [0xff, 0xff, 0xff]

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

// ── 图形绘制 ──────────────────────────────────────────────────────────────

/**
 * 画图标。`inset` > 0 时表示自适应图标的前景层：背景透明，图形缩小。
 *
 * 图形是一个圆角方块 + 中间一个对话框轮廓（圆角矩形 + 小三角尾巴），
 * 表达「对话」。不用文字，避免不同尺寸下像素糊成一团。
 */
const drawIcon = (size, { inset = 0, background = true } = {}) => {
  const rgba = new Uint8Array(size * size * 4)
  const radius = size * 0.22
  const margin = inset

  // 圆角方块的覆盖率：用 4x4 超采样做抗锯齿（不依赖 canvas）
  const S = 4
  const inRoundRect = (x, y, left, top, right, bottom, r) => {
    if (x < left || x > right || y < top || y > bottom) {
      return false
    }
    // 四个角做圆检测
    const corners = [
      [left + r, top + r, x < left + r && y < top + r],
      [right - r, top + r, x > right - r && y < top + r],
      [left + r, bottom - r, x < left + r && y > bottom - r],
      [right - r, bottom - r, x > right - r && y > bottom - r],
    ]
    for (const [cx, cy, active] of corners) {
      if (active && (x - cx) ** 2 + (y - cy) ** 2 > r * r) {
        return false
      }
    }
    return true
  }

  const paint = (index, color, alpha) => {
    if (alpha <= 0) {
      return
    }
    const a = Math.min(1, alpha)
    const dstA = rgba[index + 3] / 255
    const outA = a + dstA * (1 - a)
    if (outA <= 0) {
      return
    }
    for (let c = 0; c < 3; c += 1) {
      rgba[index + c] = Math.round(
        (color[c] * a + rgba[index + c] * dstA * (1 - a)) / outA
      )
    }
    rgba[index + 3] = Math.round(outA * 255)
  }

  // 对话气泡的几何（相对尺寸，随 inset 缩放）
  const bodyLeft = margin + size * 0.20
  const bodyRight = size - margin - size * 0.20
  const bodyTop = margin + size * 0.24
  const bodyBottom = size - margin - size * 0.30
  const bodyRadius = size * 0.10

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4

      // 背景：整块圆角方
      if (background) {
        let cov = 0
        for (let sy = 0; sy < S; sy += 1) {
          for (let sx = 0; sx < S; sx += 1) {
            const px = x + (sx + 0.5) / S
            const py = y + (sy + 0.5) / S
            if (inRoundRect(px, py, 0, 0, size, size, radius)) {
              cov += 1
            }
          }
        }
        paint(index, BRAND_BG, cov / (S * S))
      }

      // 前景：气泡轮廓（用内部镂空 + 尾巴，做出「实心气泡里挖空」的观感）
      let cov = 0
      const stroke = Math.max(1, size * 0.055)
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S
          const py = y + (sy + 0.5) / S
          const outer = inRoundRect(px, py, bodyLeft, bodyTop, bodyRight, bodyBottom, bodyRadius)
          const inner = inRoundRect(
            px,
            py,
            bodyLeft + stroke,
            bodyTop + stroke,
            bodyRight - stroke,
            bodyBottom - stroke,
            Math.max(0, bodyRadius - stroke)
          )
          // 尾巴：气泡左下角一个小三角，指向外侧
          const tailTop = bodyBottom - stroke
          const tail = px > bodyLeft + size * 0.06 && px < bodyLeft + size * 0.24 &&
            py > tailTop && py < tailTop + size * 0.16 &&
            (px - bodyLeft - size * 0.06) / (size * 0.18) > (py - tailTop) / (size * 0.16)
          if ((outer && !inner) || tail) {
            cov += 1
          }
        }
      }
      paint(index, BRAND_FG, cov / (S * S))
    }
  }

  return rgba
}

const writePng = (filePath, size, options) => {
  writeFileSync(filePath, encodePng(drawIcon(size, options), size))
  return size
}

const main = () => {
  step('生成图标')

  const res = join(paths.android, 'app', 'src', 'main', 'res')

  let count = 0
  for (const [density, size] of DENSITIES) {
    const dir = join(res, `mipmap-${density}`)
    mkdirSync(dir, { recursive: true })
    // 传统方形图标（API < 26 用）
    writePng(join(dir, 'ic_launcher.png'), size, { background: true })
    // 圆形图标（部分启动器会挑这个）
    writePng(join(dir, 'ic_launcher_round.png'), size, { background: true })
    count += 2
  }

  for (const [density, size] of FOREGROUND_DENSITIES) {
    const dir = join(res, `mipmap-${density}`)
    mkdirSync(dir, { recursive: true })
    // 自适应图标前景：透明底，图形集中在中间安全区
    writePng(join(dir, 'ic_launcher_foreground.png'), size, {
      background: false,
      inset: size * 0.18,
    })
    count += 1
  }

  // 自适应图标描述：背景用纯色，前景用上面的 PNG
  const anydpi = join(res, 'mipmap-anydpi-v26')
  mkdirSync(anydpi, { recursive: true })
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`
  writeFileSync(join(anydpi, 'ic_launcher.xml'), adaptive)
  writeFileSync(join(anydpi, 'ic_launcher_round.xml'), adaptive)
  count += 2

  // 背景色资源（adaptive-icon 的 @color 引用）
  const values = join(res, 'values')
  mkdirSync(values, { recursive: true })
  const colorXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 图标底色，与 native/ 里写死的品牌色保持一致 -->
    <color name="ic_launcher_background">#1B1F2B</color>
</resources>
`
  writeFileSync(join(values, 'ic_launcher_background.xml'), colorXml)
  count += 1

  // 网页图标（PWA 用）。
  // 注意不能写进 dist/：rspack 的 output.clean=true 每次构建都会清空整个 dist，
  // 写在那里下次 build:web 就没了。所以落到项目根的 pwa-icons/ 作为源，
  // 由 scripts/build-pwa.mjs 在组装 PWA 时拷进产物。
  const webIcons = join(paths.root, 'pwa-icons')
  mkdirSync(webIcons, { recursive: true })
  writePng(join(webIcons, 'icon-192.png'), 192, { background: true })
  writePng(join(webIcons, 'icon-512.png'), 512, { background: true })
  // maskable 版本：内容缩进 10%，避免被系统裁成圆形/Squircle 时切掉边缘
  writePng(join(webIcons, 'icon-maskable-512.png'), 512, {
    background: true,
    inset: 512 * 0.1,
  })
  count += 3

  info(`共生成 ${count} 个资源`)
  info(`Android: ${join(res, 'mipmap-*')}`)
  info(`Web/PWA: ${webIcons}`)
}

main()
