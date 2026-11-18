/**
 * localStorage 的小工具 —— web-patches/storage-utils.ts
 *
 * 上游 settings.ts 里有一套 read/write，但它是模块私有的。
 * 壳层需要"安全地"清掉某个键（比如把历史遗留的明文 Key 抹掉），
 * 直接调 localStorage 可能在隐私模式 / 存储被禁用时抛异常，所以集中在这里做一次 try/catch。
 */

export const readLocalStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writeLocalStorage = (key: string, value: string | null): void => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只影响浏览器路径；原生壳的 Key 走加密存储，不受影响
  }
}
