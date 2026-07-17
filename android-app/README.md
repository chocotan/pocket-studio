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

开发环境允许 HTTP Server，正式发布时建议使用 HTTPS，并移除 Manifest 中的 `usesCleartextTraffic`。
