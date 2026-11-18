/**
 * 用户自选头像的图片处理 —— web-patches/mobile/common/avatar-image.ts
 *
 * 手机相册里的原图动辄几 MB、几千像素，直接存 data URL 会撑爆 localStorage，
 * 渲染 32px 也浪费。这里统一做：
 *   1. 解码成 Image；
 *   2. 居中裁成正方形（cover，不拉伸变形）；
 *   3. 缩到 256×256，JPEG 0.85（带透明底的 PNG 先铺白底，避免变黑）；
 *   4. 输出 data URL。
 * 256 够 32px 头像在 4x 屏上清晰，文件通常 20–60 KB。
 */

const AVATAR_SIZE = 256
const JPEG_QUALITY = 0.85

/** 读取用户选择的图片文件，返回可直接存 localStorage 的 data URL */
export const fileToAvatarDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('不是图片文件'))
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    const cleanup = () => URL.revokeObjectURL(objectUrl)

    image.onload = () => {
      try {
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight)
        if (!sourceSize) {
          throw new Error('图片尺寸无效')
        }
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE
        canvas.height = AVATAR_SIZE
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('画布不可用')
        }
        // 透明 PNG 转 JPEG 会变黑，先铺一层白底
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
        context.drawImage(
          image,
          Math.floor((image.naturalWidth - sourceSize) / 2),
          Math.floor((image.naturalHeight - sourceSize) / 2),
          sourceSize,
          sourceSize,
          0,
          0,
          AVATAR_SIZE,
          AVATAR_SIZE
        )
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        cleanup()
      }
    }

    image.onerror = () => {
      cleanup()
      reject(new Error('图片解码失败'))
    }

    image.src = objectUrl
  })
