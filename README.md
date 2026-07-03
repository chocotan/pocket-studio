# Pocket Studio

[![Go Version](https://img.shields.io/badge/Go-1.26.3-00ADD8?logo=go)](https://go.dev)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#)

Pocket Studio 是一个专为开发者打造的**远程 AI 编程工作台**。它将运行于浏览器或桌面端的 Studio UI、部署于中继站的 Server，以及运行在真实开发机上的 Daemon（守护进程）有机连接。旨在让你通过统一而精致的界面，轻松管理分布在多台机器上的多个项目目录，并调用本地已安装的高性能 AI 编程工具与命令行 Agent。

核心思路很简单：
- **Server**：提供 Web UI、多用户认证与 WebSocket 消息分发，连接前端与各台开发机。
- **Daemon**：静默运行在真实的本地或远程开发机上，负责访问本地项目目录、启动终端会话以及与 AI Agent 交互。
- **Studio UI**：提供极富现代感与互动性（支持平铺网格与自由悬浮窗口双模式）的单页面 Web 工作台。
- **Agent**：保留在您自己机器上的执行体（如 Claude Code、Codex、OpenCode、Kilo 或 antigravity 等 CLI），保护项目源码不泄漏至第三方闭源平台。

---

## 适合什么场景

- **跨设备统一开发**：在任意浏览器中统一操控家里、公司、云端服务器等不同环境下的多个项目。
- **本地源码与终端隐私安全**：让 AI Agent 在本机的安全隔离环境和终端中运行，无需上传项目源码到第三方云端工作区。
- **多模式办公与协作**：
  - **自用模式**：使用固定 Token 快速单机或局域网部署。
  - **多人共享模式**：开启注册、登录和用户 Token 隔离，多用户共用一个 Server 调度各自的 Daemon。

---

## 架构设计

```mermaid
flowchart TD
  user[浏览器 / 桌面端 (Studio UI)]
  server[Pocket Studio Server<br/>Web UI / Auth / WebSocket Hub]
  daemon[Pocket Studio Daemon<br/>开发机守护进程]
  project[项目目录]
  agent[本地 AI Agent / 终端<br/>Claude Code / Codex / OpenCode / Kilo / acpx]

  user <-->|HTTP / WebSocket 中转| server
  user <-->|WebSocket 直连 (低延迟)| daemon
  daemon <-->|WebSocket 连接| server
  daemon -->|控制 & 状态监听| project
  daemon -->|进程生命周期管理| agent
  agent -->|本地读写与执行| project
```

> [!NOTE]
> **直连终端模式 (Direct Terminal Mode)** 允许 Studio UI 绕过 Server 直接连接 Daemon 开放的 WebSocket 终端服务。在同一个局域网或有内网穿透的情况下，这能大幅降低终端输入与渲染的延迟，带来近乎本机的极速响应体验。

---

## 核心特性与最新功能

1. **直连终端模式 (Direct Terminal)**
   - Daemon 内置高性能直连 WebSocket 服务（默认 `:18082` 端口）。
   - 自动生成符合 `v1` 协议规范的 HMAC-SHA256 临时直连令牌，防止未授权访问。
2. **多订阅者终端广播 (Subscription & Broadcast Model)**
   - 终端通道被重构为广播/订阅架构，允许多个 Studio UI 客户端同时连接并观察同一个终端会话的输出。
   - 支持稳定的协作通知与连接抢占/踢出机制。
3. **强大的终端 AI Hook & 任务通知**
   - 自动检测并深度适配主流 AI Agent 框架（如 Claude Code, Antigravity SDK, Codex, OpenCode, Kilo, Pi 等）。
   - 在 AI 执行任务（如 Tool Call 或运行完毕）时，自动向 Daemon 触发 Hook 并向 Studio UI 发送实时通知徽章（Alert）以及声音/视觉提示，不再需要持续盯着终端等待。
4. **两类 ACP (Agent Communication Protocol) 支持**
   - **ACPX CLI 模式**：通过调用外部 `acpx` 命令行会话包来操作 AI Agent。
   - **Direct ACP 模式**：Daemon 自身作为标准 ACP 客户端，直接使用 stdin/stdout JSON-RPC 协议与 `codex`、`opencode`、`kilo` 等执行体交互，支持流畅的 Chat 面板渲染以及 Tool Calls 执行过程展示。
5. **高度可定制的 Studio 布局系统**
   - **平铺网格模式 (Grid)**：传统的窗口分栏平铺，同一开发机下的多个项目可共享分屏状态。
   - **悬浮窗口模式 (Floating)**：支持每个面板（文件树、终端、编辑器）作为可自由拖拽、缩放、层级置顶（z-index 提升）以及最小化/最大化的独立窗口。
   - **Dock & 分组自动优化**：底部 Dock 栏终端按照机器和目录自动分组，支持 Dock 自动隐藏，最大化利用屏幕空间。
   - 跨项目选项卡支持 `device:initials` 风格的紧凑标志，并将详细信息置于悬停提示中。
6. **全新收藏品与项目创建流**
   - 引入「我的收藏 (My Favorites)」列表，以便快速跳转到重要项目。
   - 优化了项目创建面板，支持目标设备下拉选择、路径实时同步、自动目录联想与快捷路径、文件/目录检索过滤。
7. **通知中心 (Notification Center)**
   - 内置统一的通知管理模块，聚合展示各终端的任务状态、Agent 完成情况与系统警报。

---

## 组件分布

| 组件 | 对应源码目录 | 说明 |
| --- | --- | --- |
| Server | [cmd/server](file:///home/choco/Downloads/remote-agent/cmd/server/main.go) | HTTP 服务、用户注册与登录、Token 认证、WebSocket Hub、SPA 静态资源托管 |
| Daemon | [cmd/daemon](file:///home/choco/Downloads/remote-agent/cmd/daemon/main.go) | 连接 Server，启动 Direct Terminal 与 Hook 监听，执行 ACP/ACPX/Claude Code 进程，管理文件系统 |
| Studio 前端 | [studio-frontend](file:///home/choco/Downloads/remote-agent/studio-frontend) | 基于 React + TS + Vite 的主工作台 UI，包含 Electron 桌面端外壳 |
| 用户前端 | [user-frontend](file:///home/choco/Downloads/remote-agent/user-frontend) | 基于 React 的登录、注册和 API 令牌（Tokens）管理后台 |
| 协议定义 | [internal/protocol](file:///home/choco/Downloads/remote-agent/internal/protocol) | 统一的消息结构、Envelope 定义以及直连 Token 签名算法 |

---

## 快速开始

### 方式 A：单机桌面模式（零配置）

下载编译好的对应系统桌面发布包（如 Linux AppImage、macOS .app 或 Windows .exe）后直接运行。
在桌面端中，Pocket Studio 可以一键在后台为您拉起 Server 和本地 Daemon，也可以作为独立的 UI 客户端连接远程的自建 Server。

---

### 方式 B：自用直连模式（单用户）

适合给自己使用，Server 不需要繁琐的用户注册，仅开启单 Token 验证。

1. **启动 Server**
   ```bash
   go run ./cmd/server -server.addr :18080 -server.admin-token my_secret_token
   ```
2. **启动 Daemon**
   ```bash
   go run ./cmd/daemon \
     -daemon.server.url ws://localhost:18080/ws/daemon \
     -daemon.server.token my_secret_token \
     -daemon.workspace "~/Agent"
   ```
3. **访问 Studio**
   打开浏览器，访问 `http://localhost:18080/studio/`。

---

### 方式 C：多人共享模式（用户隔离）

适合团队或多台机器租户共享同一个控制中心。

1. **启动 Server**（启用 SQLite 认证数据库并允许注册）
   ```bash
   go run ./cmd/server \
     -server.addr :18080 \
     -server.auth.enabled \
     -server.auth.allow-register=true \
     -server.auth.db ~/.config/pocket-studio/server-auth.sqlite
   ```
2. **生成用户 Token**
   访问用户管理首页 `http://localhost:18080/`，注册账号并登录，在 API Token 页面创建一个新的 Token（格式通常为 `ps_user_xxxxx`）。
3. **使用用户 Token 启动 Daemon**
   ```bash
   go run ./cmd/daemon \
     -daemon.server.url ws://localhost:18080/ws/daemon \
     -daemon.server.token ps_user_xxxxx \
     -daemon.workspace "my-project:Project-A:~/projects/project-a"
   ```

---

## 从源码开发与构建

### 1. 环境准备
- **Go**: 1.26.3+ (详见 [go.mod](file:///home/choco/Downloads/remote-agent/go.mod))
- **Node.js**: 24+ & **npm**
- 开发机上已全局安装需要调用的 Agent CLI（如 `claude`、`acpx` 或相关的 npm 模块）

### 2. 初始化依赖
```bash
npm ci --prefix studio-frontend
npm ci --prefix user-frontend
```

### 3. 本地开发调试
- **终端 1**：启动中继 Server
  ```bash
  go run ./cmd/server -server.addr :18080 -server.admin-token dev_token
  ```
- **终端 2**：启动本地 Daemon 守护进程
  ```bash
  go run ./cmd/daemon \
    -daemon.server.url ws://localhost:18080/ws/daemon \
    -daemon.server.token dev_token \
    -daemon.workspace ~/Agent
  ```
- **终端 3**：启动前端 Vite 开发服务器（支持热重载）
  ```bash
  npm run dev --prefix studio-frontend
  ```

### 4. 编译与打包
要构建包含完整内嵌前端资源的二进制文件，请按照以下步骤操作：

```bash
# 1. 编译前端静态资源
npm run build --prefix studio-frontend
npm run build --prefix user-frontend

# 2. 将编译产物同步到 Server 的内嵌目录（嵌入式静态打包）
mkdir -p cmd/server/embedded/studio cmd/server/embedded/user
cp -a studio-frontend/dist/. cmd/server/embedded/studio/
cp -a user-frontend/dist/. cmd/server/embedded/user/

# 3. 编译 Go 二进制程序
go build -trimpath -ldflags="-s -w" -o ./server ./cmd/server
go build -trimpath -ldflags="-s -w" -o ./daemon ./cmd/daemon
```

> [!TIP]
> 您也可以使用 [scripts/build-packages.sh](file:///home/choco/Downloads/remote-agent/scripts/build-packages.sh) 自动化脚本快速打包特定平台（如 `linux`、`mac`、`win`）的发布介质：
> ```bash
> bash scripts/build-packages.sh linux
> ```

---

## 详细参数配置参考

### Server 参数

| 参数命令行 Flag | 环境变量默认覆盖 | 说明 |
| --- | --- | --- |
| `-server.addr` | - | HTTP 服务监听地址（默认 `:8080`） |
| `-server.admin-token` | - | 管理员 Token；自用模式下的固定访问 Token |
| `-server.auth.enabled` | - | 是否启用注册、登录和用户多 Token 认证（默认 `false`） |
| `-server.auth.db` | `POCKET_STUDIO_AUTH_DIR` | 认证 SQLite 数据库的保存路径，默认在用户配置目录的 `pocket-studio/server-auth.sqlite` |
| `-server.auth.allow-register` | - | 开启认证后，是否允许新用户注册账号（默认 `true`） |

### Daemon 参数

详细配置结构及类型定义可以参考 [internal/daemon/config.go](file:///home/choco/Downloads/remote-agent/internal/daemon/config.go)。

| 参数命令行 Flag | 默认值 / 机制 | 说明 |
| --- | --- | --- |
| `-daemon.device.id` | 随机生成（保存在 `device.json` 中） | 唯一设备 ID，向 Server 和 Studio 标识当前主机 |
| `-daemon.device.name` | 当前系统主机名 | 展现在 Studio 工作台上的设备易读名称 |
| `-daemon.server.url` | **必填** | Server 的 Daemon WebSocket 中继地址，例如 `ws://127.0.0.1:18080/ws/daemon` |
| `-daemon.server.token` | **必填** (与 Server Token 匹配) | 接入控制中心的 Token |
| `-daemon.workspace` | 默认 `~/Agent`（可多次指定） | 工作区目录。支持直接路径，或格式为 `id:display_name:absolute_path` 的定制串 |
| `-daemon.acpx.enabled` | `true` | 是否启用 acpx Agent 工具包 |
| `-daemon.acpx.command` | `acpx` | 本地 `acpx` CLI 执行路径 |
| `-daemon.acpx.agent` | `claude` | `acpx` 默认调用的底层 Agent 模型 |
| `-daemon.acpx.session-name` | `agentbridge` | `acpx` 默认会话标识 |
| `-daemon.acpx.ttl-seconds` | `300` | `acpx` 会话的生存时间 (TTL)，单位秒 |
| `-daemon.acpx.command-timeout-seconds` | `1800` | 守护进程等待 acpx 会话/提示返回的最大超时时长；`0` 表示不设置超时限制 |
| `-daemon.acpx.args` | 见 `acpx` 默认参数 | 逗号分隔的 acpx 全局运行参数 |
| `-daemon.claude.command` | `claude` | Claude Code 命令路径 |
| `-daemon.claude.args` | `--output-format,stream-json,--verbose` | 逗号分隔的 Claude 运行参数 |
| `-daemon.direct-web.enabled` | `true` | 是否启用 Daemon 本地直连端口（用于 Studio 终端跳过 Server 中继） |
| `-daemon.direct-web.listen` | `:18082` | Daemon 直连服务的 HTTP/WebSocket 监听地址 |
| `-daemon.direct-web.public-host` | 自动获取（首个非 Docker IPv4 地址） | 广播给 Studio UI 的 Daemon 直连物理 IP/主机名 |
| `-daemon.direct-web.token` | 随机生成并自动同步至 Server | 直连所需的安全验证凭据 |

---

## 配置文件示例 `agentbridge.daemon.json`

除了在启动命令行传入参数外，您也可以在 [internal/daemon/daemon.go](file:///home/choco/Downloads/remote-agent/internal/daemon/daemon.go) 的配置目录下创建并维护 JSON 配置文件（默认路径在 `~/.config/pocket-studio/`，支持通过 `POCKET_STUDIO_DAEMON_CONFIG_DIR` 环境变量自定义）。

以下是包含所有高级特性配置字段的完整示例（参考本地的 [agentbridge.daemon.json](file:///home/choco/Downloads/remote-agent/agentbridge.daemon.json)）：

```json
{
  "device": {
    "id": "dev_my_macbook",
    "name": "My Dev Macbook"
  },
  "server": {
    "url": "ws://192.168.1.100:18080/ws/daemon",
    "token": "ps_user_abcdef123456"
  },
  "direct_web": {
    "enabled": true,
    "listen_addr": ":18082",
    "public_host": "192.168.1.5",
    "token": "custom-secure-direct-token-optional"
  },
  "claude": {
    "command": "claude",
    "args": [
      "--output-format",
      "stream-json",
      "--verbose"
    ]
  },
  "acpx": {
    "enabled": true,
    "command": "acpx",
    "agent": "claude",
    "session_name": "agentbridge",
    "ttl_seconds": 300,
    "command_timeout_seconds": 1800,
    "args": [
      "--format",
      "json",
      "--approve-all"
    ]
  },
  "direct_acp": {
    "enabled": true,
    "agents": {
      "codex": {
        "command": "npx",
        "args": ["@zed-industries/codex-acp@latest"]
      },
      "opencode": {
        "command": "opencode",
        "args": ["acp"]
      },
      "kilo": {
        "command": "kilo",
        "args": ["acp"]
      }
    }
  },
  "workspaces": [
    {
      "id": "project-web",
      "name": "Main Web App",
      "path": "/Users/me/projects/web-app"
    },
    {
      "id": "project-server",
      "name": "Backend Service",
      "path": "/Users/me/projects/backend"
    }
  ]
}
```

---

## 进阶工作原理

### 1. 直连终端 (Direct Terminal Mode) 认证流程
1. **握手与上报**：Daemon 启动后，向 Server 上报自己的直连配置（包含 `PublicHost` 和 `ListenAddr`，以及生成的 Direct Token）。
2. **分发**：当 Studio UI 选择连接此设备的项目时，从 Server 获取项目详情，并在详情中获取该直连端点（Direct Endpoint）的地址与临时 Token。
3. **连接验证**：Studio UI 开启 WebSocket 直连此端点。Daemon 在 `/ws/terminal` 握手阶段，提取 URL 查询参数中的 `token`，通过 [VerifyDirectTerminalToken](file:///home/choco/Downloads/remote-agent/internal/protocol/direct_token.go#L29) 进行校验。
4. **安全特性**：直连 Token 基于 HMAC-SHA256 签名，且包含 Unix 时间戳过期机制（基于安全密钥与当前时间动态校验），即使在局域网内广播也无须担心 Token 泄漏被滥用。

### 2. 终端 Agent 自动化 Hook (Hook Server)
1. **自动插件植入**：当您在 Studio 终端中为某个项目拉起特定 Agent（如 `claude`）时，Daemon 会在用户配置目录下生成特定的代理脚本（如 `claude-stop.js`），并根据该 Agent 的配置规范（如修改 `~/.config/claude-code/settings.json` 中的 `Stop` 钩子）将该脚本注册为 AI 运行结束时的终止 Hook。
2. **事件上报**：Agent 在终端中运行完毕（如成功执行指令或由于等待人工确认而挂起）时，底层的 Hook 机制会访问 Daemon 在 `127.0.0.1` 动态启动的本地事件网关（`/terminal-event`）。
3. **前台提醒**：Daemon 验证 `hookToken` 后，向中继 Server 及 Studio UI 发送一个 `TypeTerminalStreamAlert` 消息包，在 Studio UI 选项卡、页面标题上点亮闪烁的任务完成指示徽章，极大提升多窗口挂机效率。

### 3. 悬浮窗布局数据持久化 (Workspace Layout Sync)
Pocket Studio 允许同一台机器上的多个项目共享同一套视窗布局设置。当您开启悬浮窗口模式，拖动并摆放好各个模块的相对位置后，这些位置参数会以 JSON 结构（包括 `layoutMode`、`floatingPanels` z-index 层级和 minimized/maximized 状态等）通过 WebSocket 实时的保存在 Daemon 的 `project-states.json` 中。即便刷新浏览器或更换浏览器标签页，工作台也能原样恢复您最得心应手的悬浮窗口布局。

---

## 测试和校验

```bash
# 运行后端测试用例（包括协议、直连 Token 签名和 Daemon 状态校验）
go test ./...

# 编译前台静态资源以验证类型和语法无误
npm run build --prefix studio-frontend
npm run build --prefix user-frontend

# 运行前端代码静态检查
npm run lint --prefix studio-frontend
```

根据改动范围选择最小必要校验。后端协议、认证、Daemon 行为相关改动应至少运行 `go test ./...`；前端 UI 改动应至少运行对应前端的 `build` 或 `lint`。

---

## 常见问题 (FAQ)

### Q: Server 页面为空或提示缺少前端文件？
A: 必须先构建前端，并将构建出来的 `dist` 产物放置到 Server 的嵌入式目录。建议直接使用打包脚本自动化完成这一过程：
```bash
npm ci --prefix studio-frontend
npm ci --prefix user-frontend
bash scripts/build-packages.sh linux
```

### Q: Daemon 连不上 Server？
A: 请依次排查以下三项：
1. 确认 `-daemon.server.url` 使用的是 Daemon 连接的 WebSocket 专用地址（例如 `ws://localhost:18080/ws/daemon`），而不是一般 HTTP 地址。
2. 确认 `-daemon.server.token` 填写的 Token 是否与 Server 端的 `admin-token` 或者是注册用户所生成的 API 令牌相对应。
3. 检查 Server 的监听地址、安全防火墙或反向代理（如 Nginx）是否正确配置并放行了 WebSocket 流量。

### Q: 如何给开发机/设备重命名？
A: 您可以在启动 Daemon 时通过命令行参数传入名字：
```bash
go run ./cmd/daemon \
  -daemon.device.name "My-Powerful-Workstation" \
  -daemon.server.url ws://localhost:18080/ws/daemon \
  -daemon.server.token dev_token \
  -daemon.workspace ~/Agent
```
也可以直接在 Daemon 的 `device.json` 文件或配置 JSON 的 `device.name` 字段中进行修改。

### Q: 工作区路径支持什么格式？
A: 
- 最简格式：直接传入路径，系统会自动获取目录名作为 ID 和显示名称：
  ```bash
  -daemon.workspace ~/Agent
  ```
- 完整格式：当需要自定义 ID 和展示名称时，使用 `id:name:path` 格式：
  ```bash
  -daemon.workspace "pocket-studio-dev:Pocket Studio Code:/home/me/projects/pocket-studio"
  ```
