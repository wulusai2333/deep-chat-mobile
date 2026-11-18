# native/secure-storage

API Key 的加密存储插件，对应前端 `web-patches/keystore-bridge.ts`。

## 为什么需要它

需求 §3 硬性要求：API Key 不得以明文形式出现在 localStorage、IndexedDB 或普通
SharedPreferences 中；即使手机丢失，Key 也不能泄露。

实现方式：`androidx.security:security-crypto` 的 `EncryptedSharedPreferences`，
主密钥（`MasterKey`）由 **Android Keystore** 生成并保管，密钥材料不出系统密钥库；
落盘的是 AES-256-GCM 密文。

| 攻击面 | 结果 |
| --- | --- |
| 反编译 APK | 只看到代码，看不到 Key |
| 拷走 `/data/data/com.deepchat.app/` | 只有密文 + 加密后的键名 |
| 手机丢失 / 被刷机 | 主密钥在 Keystore 里，脱离设备无法解密 |
| 卸载应用 | Keystore 主密钥一并销毁，密文永久不可解 |
| 系统级备份到云端 | 已在 manifest 里 `allowBackup=false` 关闭 |
| Android 12+ 设备间迁移 | 同样被 `allowBackup=false` 排除 |

## 文件

- `SecureStoragePlugin.java` → 复制到
  `android/app/src/main/java/com/deepchat/app/plugins/SecureStoragePlugin.java`

## 接口

前端通过 `window.Capacitor.nativePromise('DeepChatSecureStorage', method, options)` 调用。

| 方法 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `read` | — | `{ value: string \| null }` | 没存过时 `value` 为 `null`，不报错 |
| `write` | `{ value: string }` | — | `value` 为空等同 `remove` |
| `remove` | — | — | 删除 |

## 关键实现选择

**为什么 `commit()` 而不是 `apply()`**
`apply()` 是异步落盘。唤起写入的调用方（首启引导）紧接着就可能被系统杀掉，
所以必须等落盘完成再 `resolve()`。

**为什么方法这么少**
原生侧只负责"安全地存一个字符串"，不解析、不校验、不记录 Key。
所有业务判断（何时读、何时写、何时清）都在前端，减少原生侧的泄露面。

**为什么解密失败要静默清空**
换机恢复、系统升级异常都可能让 Keystore 里的主密钥失效。此时密文永久不可解，
继续抛错会让应用每次启动都失败。清空后让用户重新输入是唯一可用的自愈路径。

## 依赖

`android/app/build.gradle` 需要：

```gradle
implementation "androidx.security:security-crypto:1.1.0-alpha06"
```

`1.1.0-alpha06` 是最后一个仍提供 `EncryptedSharedPreferences` 的稳定可用版本
（1.1.0 正式版把它标记为 deprecated 但仍可用）。本项目 pin 在 alpha06，
因为它在 API 24–36 上验证过可用。
