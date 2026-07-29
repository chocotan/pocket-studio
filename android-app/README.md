# Pocket Studio Android

原生 Android ACP 客户端。它直接复用 Pocket Studio Server 当前提供的 HTTP 和 WebSocket 协议，不需要额外的服务端接口。

## 功能

- Server 地址和 Token 登录
- 在线机器与项目选择
- 从 `/api/state.tasks` 读取项目对话
- 创建、恢复和停止 Direct ACP 对话
- WebSocket 历史回放、事件去重和基本工具调用展示
- Android Keystore 加密保存连接信息

## 构建

使用 Android Studio 打开 `android-app`，安装 Android SDK 35 后运行 `app`。命令行环境配置好 `ANDROID_HOME` 后也可以执行：

```bash
./gradlew :app:assembleDebug
```

## GitHub Actions 打包

推送 tag，或在 GitHub Actions 中手动运行 `Release Packages`，会构建并上传 Android 产物到对应 GitHub Release：

- 未配置签名：生成可直接安装的 `pocket-studio-android-universal-<tag>-debug.apk`。
- 配置签名：额外生成正式签名 APK 和供应用商店使用的 AAB。

debug APK 的 runner 签名不保证跨 workflow 保持一致，覆盖安装失败时需要先卸载旧 debug 版本；稳定升级和正式分发应配置 release 签名。

正式签名需要在仓库 Actions secrets 中配置以下四项：

- `ANDROID_KEYSTORE_BASE64`：keystore 文件的 Base64 内容。
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码。
- `ANDROID_KEY_ALIAS`：签名 key alias。
- `ANDROID_KEY_PASSWORD`：签名 key 密码。

Linux 上可以使用下面的命令生成 `ANDROID_KEYSTORE_BASE64`：

```bash
base64 -w 0 pocket-studio-release.keystore
```

四项 secrets 必须同时配置。只配置一部分时 workflow 会直接失败，避免误把 debug 包当作正式发布包。CI 会用 release tag 作为 `versionName`，并用 workflow run number 作为递增的 `versionCode`。

开发环境允许 HTTP Server，正式发布时建议使用 HTTPS，并移除 Manifest 中的 `usesCleartextTraffic`。
