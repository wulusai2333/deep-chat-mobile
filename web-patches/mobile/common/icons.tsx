/**
 * 移动端图标 —— web-patches/mobile/common/icons.tsx
 *
 * 官方 App 的图标风格：**1.8–2px 圆头描边、无填充**（个别实心：…、发送箭头、停止方块）。
 * 上游 icons.tsx 里的图标是 14/16px 的细描边，直接放大会变细、比例也不对，
 * 所以移动端这套单独画（viewBox 统一 24，stroke=currentColor）。
 *
 * 不要在这里放业务图标（例如文件类型图标），那些沿用上游 components/base/icons.tsx。
 */

type IconProps = {
  size?: number
  /** 线宽，默认按 24 viewBox 里的视觉重量取 2 */
  strokeWidth?: number
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** 汉堡：官方是两根线（上线长、下线短），不是三条 */
export const MIconMenu = ({ size = 24, strokeWidth = 2 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M3 8h18" />
    <path d="M3 16h10" />
  </svg>
)

/** 圆圈加号：新建对话 */
export const MIconPlusCircle = ({ size = 24, strokeWidth = 1.9 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 6.6v10.8M6.6 12h10.8" />
  </svg>
)

/**
 * 喇叭：朗读当前回答。
 * 官方图标是一个「高瘦的喇叭 + 一条弧」，墨迹约 18.8×17.9（24 框内），
 * 所以喇叭口要画得比常见的 volume 图标大，弧也要单独一条（不是两条）。
 */
export const MIconSpeaker = ({ size = 24, strokeWidth = 2 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M12.6 4 7.2 8.2H3v7.6h4.2L12.6 20V4Z" />
    <path d="M16.2 8.6c2.6 2 2.6 4.8 0 6.8" />
  </svg>
)

/**
 * 语音输入：官方输入框右侧是「一个点 + 两道声波弧」，不是常见的麦克风胶囊。
 * （点实心、弧线描边；整体墨迹约 13×12，在 24 框内偏左。）
 */
export const MIconMic = ({ size = 22, strokeWidth = 1.9 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <circle cx="6.6" cy="12" r="1.9" fill="currentColor" stroke="none" />
    <path d="M10.8 8.9a4.6 4.6 0 0 1 0 6.2" />
    <path d="M14.4 6.4a8 8 0 0 1 0 11.2" />
  </svg>
)

/** 关闭：附件面板 / 语音模式 */
export const MIconClose = ({ size = 22, strokeWidth = 1.9 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />
  </svg>
)

/** 键盘：从语音模式切回文字输入 */
export const MIconKeyboard = ({ size = 22, strokeWidth = 1.9 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <rect x="3" y="6.4" width="18" height="11.2" rx="3" />
    <path d="M7 10h.01M10.4 10h.01M13.8 10h.01M17.2 10h.01M7 13.4h.01M10.4 13.4h.01M13.8 13.4h.01M17.2 13.4h.01" />
    <path d="M8.6 16.4h6.8" />
  </svg>
)

/** 拍照 */
export const MIconCamera = ({ size = 26, strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M8.4 6.4 9.8 4h4.4l1.4 2.4" />
    <rect x="3" y="6.4" width="18" height="13.2" rx="3.4" />
    <circle cx="12" cy="12.8" r="3.4" />
  </svg>
)

/** 相册 */
export const MIconPhoto = ({ size = 26, strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <rect x="3" y="4.6" width="18" height="14.8" rx="3" />
    <circle cx="8.6" cy="9.8" r="1.5" />
    <path d="m4.4 17.4 5-5 4.2 4.2 2.6-2.4 3.4 3.2" />
  </svg>
)

/** 文件：回形针 */
export const MIconPaperclip = ({ size = 26, strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M20 11.6 12.4 19a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-7.9 7.9a1.55 1.55 0 0 1-2.2-2.2l7.2-7.2" />
  </svg>
)

/** 搜索 */
export const MIconSearch = ({ size = 18, strokeWidth = 2 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <circle cx="10.6" cy="10.6" r="6.6" />
    <path d="m15.6 15.6 4.2 4.2" />
  </svg>
)

/** 勾选：图片选择态 */
export const MIconCheck = ({ size = 14, strokeWidth = 2.4 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="m5 12.6 4.6 4.6L19 6.8" />
  </svg>
)

/** 发送：向上箭头 */
export const MIconArrowUp = ({ size = 18, strokeWidth = 2.1 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <path d="M12 19V5M6.4 10.6 12 5l5.6 5.6" />
  </svg>
)

/** 停止生成：实心方块 */
export const MIconStop = ({ size = 14 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="5" y="5" width="14" height="14" rx="3.4" fill="currentColor" />
  </svg>
)

/** 账户占位头像 */
export const MIconUser = ({ size = 18, strokeWidth = 1.9 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <circle cx="12" cy="8.4" r="3.9" />
    <path d="M4.8 20.2a7.4 7.4 0 0 1 14.4 0" />
  </svg>
)

/** 更多：三个实心点 */
export const MIconEllipsis = ({ size = 20 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <circle cx="5.4" cy="12" r="1.8" fill="currentColor" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    <circle cx="18.6" cy="12" r="1.8" fill="currentColor" />
  </svg>
)

/**
 * 数据库（堆叠圆柱）：回答动作栏里的「本轮消耗额度」入口，面板标题左侧同款。
 *
 * 【为什么用 1.6 的线宽】入口按钮只有 16px，本套图标默认 2 是按 24px 显示定的；
 * 缩到 16px 后 2 会显得糊成一团，官方截图里这个图标也明显比旁边的喇叭细，
 * 所以单独取 1.6。圆柱用「顶部椭圆 + 两条侧壁弧」画，是为了在 16px 下仍能看出分层，
 * 只画三条横线会变成「菜单」而不是「数据库」。
 */
export const MIconDatabase16 = ({ size = 16, strokeWidth = 1.6 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...stroke} strokeWidth={strokeWidth}>
    <ellipse cx="12" cy="6" rx="7.4" ry="3.1" />
    <path d="M4.6 6v6.2c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6" />
    <path d="M4.6 12.2v6.2c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1v-6.2" />
  </svg>
)

