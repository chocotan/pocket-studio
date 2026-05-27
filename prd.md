# PocketStudio 产品与系统设计

## 1. 产品定位

PocketStudio 是一个面向开发者的远程 Coding Agent 控制台。它让用户可以在 Web 端选择自己的本地机器和代码仓库，向本地已安装的 Claude Code 下发任务，并实时查看 Agent 的对话、工具调用、终端输出、文件变更和资源消耗。

产品采用“重本地，轻云端”的架构：

- 本地负责执行：代码仓库、CLI 凭证、文件读写、Shell 命令都留在用户自己的机器上。
- 服务端只负责连接和转发：Web Server 维护 Web 与本地 Daemon 的长连接，不直接接触代码仓库，也不执行 Agent 任务。
- Agent 适配基于 JSON 流：MVP 阶段只接入 Claude Code 的 `stream-json` 输出；后续再抽象适配 OpenHands 等其他 Coding CLI。

## 2. 目标与非目标

### 2.1 产品目标

- 远程发起 Coding Agent 任务：用户可以从浏览器向本地指定工作区下发 Prompt。
- 实时可视化执行过程：以聊天流、工具调用、终端日志、文件变更等形式展示 Agent 运行状态。
- 可控的本地执行：本地 Daemon 校验工作区、管理进程生命周期，并支持强制终止任务。
- 多设备管理：用户可以接入多台本地机器，并在 Web 端查看在线状态和可用工作区。
- 为后续多 Agent 引擎预留适配层，但 MVP 只支持 Claude Code。

### 2.2 非目标

- 不在云端托管用户代码。
- 不在云端执行 Shell、Git 或文件修改。
- MVP 不做多人协作编辑器。
- MVP 不做完整 IDE，只做远程任务编排、执行观察和基础控制。
- MVP 不做多 CLI 兼容，只围绕 Claude Code 打通端到端体验。

## 3. 用户场景

### 3.1 远程触发代码任务

用户在外出时通过 Web 打开 PocketStudio，选择“家里台式机”和 `~/Projects/my-app`，输入“帮我重构登录逻辑并补充测试”并发送。任务通过本地 Claude Code 运行，用户在 Web 端查看实时执行过程。

### 3.2 观察 Agent 执行细节

Agent 执行过程中，Web 端按时间线展示：

- 用户输入的需求。
- Agent 的思考摘要或状态事件。
- Shell 命令执行记录。
- 文件读取、修改和新增。
- Token、耗时、费用等指标。

### 3.3 失控时远程中断

如果 Agent 执行了危险命令、长时间卡住，或持续修改不相关文件，用户可以点击“停止任务”。云端将停止指令转发到本地 Daemon，由 Daemon 终止对应进程组。

## 4. 总体架构

```text
+-------------------+        WSS         +----------------------+        WSS         +----------------------+
| Web Console       | <----------------> | Web Server           | <----------------> | Local Daemon         |
|                   |                    |                      |                    |                      |
| - 设备选择         |                    | - 连接路由             |                    | - CLI 进程管理        |
| - Prompt 输入      |                    | - 心跳保活             |                    | - 工作区校验          |
| - 事件流展示       |                    | - 消息透传             |                    | - JSON 流转发         |
| - Stop Task       |                    | - 设备在线状态          |                    | - Stop/Kill          |
+-------------------+                    +----------------------+                    +----------+-----------+
                                                                                              |
                                                                                              | spawn
                                                                                              v
                                                                                  +----------------------+
                                                                                  | Coding Agent CLI     |
                                                                                  | claude               |
                                                                                  | stdout JSON Lines    |
                                                                                  +----------------------+
```

### 4.1 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| Web Console | 用户交互、任务创建、事件展示、设备/工作区选择、停止任务 | 直接执行命令、直接访问本地文件 |
| Web Server | 托管前端页面、Web 与 Daemon 的鉴权、WebSocket 连接维护、消息路由、心跳、在线状态 | 运行 Agent、保存代码、直接访问本地文件 |
| Local Daemon | 本地鉴权、工作区发现和校验、CLI 适配、进程组管理、事件流上报 | Web UI、服务端状态管理、复杂协作逻辑 |
| Agent Adapter | 将统一任务请求转换为具体 CLI 命令，将 CLI JSON 流转换为标准事件 | 直接承担网络连接和 UI 展示 |

> 说明：本文里的 “Router” 不是一个必须单独部署的服务，而是 Web Server 内部的 WebSocket 消息路由模块。MVP 可以只有一个服务端进程，同时提供前端页面、HTTP API 和 WebSocket 接入。

## 5. 核心概念

### 5.1 Device

一台运行 Local Daemon 的本地机器。

关键字段：

- `device_id`：设备唯一 ID，本地生成并注册。
- `name`：用户可读名称，例如“家里台式机”。
- `status`：`online` / `offline` / `busy`。
- `capabilities`：支持的引擎、操作系统、Daemon 版本。
- `last_seen_at`：最后心跳时间。

### 5.2 Workspace

Daemon 允许远程操作的本地目录。

关键字段：

- `workspace_id`：工作区 ID。
- `device_id`：所属设备。
- `name`：显示名称。
- `path`：本地绝对路径。
- `git_branch`：当前分支，可选。
- `allowed`：是否在白名单内。

### 5.3 Task

一次 Agent 执行任务。

关键字段：

- `task_id`：任务 ID。
- `device_id`：目标设备。
- `workspace_id`：目标工作区。
- `agent`：目标引擎，MVP 固定为 `claude_code`。
- `prompt`：用户输入。
- `status`：`queued` / `running` / `stopping` / `succeeded` / `failed` / `killed`。
- `created_at` / `started_at` / `finished_at`。
- `metrics`：耗时、token、费用等。

### 5.4 Event

Agent 运行中的标准化事件。

常见类型：

- `task.started`
- `assistant.message`
- `tool.call`
- `tool.output`
- `file.changed`
- `metric.updated`
- `task.completed`
- `task.failed`
- `task.killed`

## 6. 消息协议设计

Web Server 的 WebSocket 路由模块只识别标准信封字段，用于鉴权、路由和连接管理。业务内容放在 `payload` 内。

### 6.1 通用信封

```json
{
  "id": "msg_01JABCDEF",
  "type": "task.dispatch",
  "version": 1,
  "timestamp": 1716707707,
  "from": "web",
  "to": {
    "device_id": "dev_home_mac"
  },
  "trace_id": "tr_01JABCDEF",
  "payload": {}
}
```

字段说明：

- `id`：消息唯一 ID，方便去重和排查。
- `type`：消息类型。
- `version`：协议版本。
- `timestamp`：Unix 时间戳。
- `from`：`web` / `daemon` / `server`。
- `to`：目标路由信息。
- `trace_id`：贯穿一次任务的链路 ID。
- `payload`：业务载荷。

### 6.2 任务下发

```json
{
  "type": "task.dispatch",
  "payload": {
    "task_id": "tsk_12345",
    "workspace_path": "/Users/app/my-app",
    "agent": "claude_code",
    "prompt": "重构登录逻辑并补充测试",
    "options": {
      "auto_shell": false,
      "allowed_tools": ["file", "bash"],
      "timeout_seconds": 3600
    }
  }
}
```

Daemon 收到后必须执行：

- 校验 `workspace_path` 是否在本地白名单内。
- 校验目标 `agent` 是否已安装、可执行且版本符合要求。
- 为任务创建独立进程组。
- 将任务状态切换为 `running` 并上报。

### 6.3 事件回传

```json
{
  "type": "task.event",
  "payload": {
    "task_id": "tsk_12345",
    "event_id": "evt_001",
    "event_type": "tool.call",
    "source": "claude_code",
    "sequence": 12,
    "data": {
      "name": "bash",
      "input": "npm test"
    },
    "raw": {
      "type": "tool_use",
      "name": "bash",
      "input": "npm test"
    }
  }
}
```

设计原则：

- `data` 是 PocketStudio 标准化后的结构，供 UI 渲染。
- `raw` 保留 CLI 原始 JSON，便于调试和未来兼容。
- `sequence` 由 Daemon 递增生成，Web 端按任务内序号排序。

### 6.4 停止任务

```json
{
  "type": "task.stop",
  "payload": {
    "task_id": "tsk_12345",
    "reason": "user_requested"
  }
}
```

Daemon 收到后：

- 标记任务为 `stopping`。
- 先向进程组发送 `SIGTERM`。
- 等待宽限时间，例如 5 秒。
- 如仍未退出，发送 `SIGKILL`。
- 上报 `task.killed` 或 `task.failed`。

### 6.5 心跳与在线状态

```json
{
  "type": "daemon.heartbeat",
  "payload": {
    "device_id": "dev_home_mac",
    "status": "online",
    "running_task_ids": ["tsk_12345"],
    "daemon_version": "0.1.0"
  }
}
```

## 7. Local Daemon 设计

### 7.1 技术选择

推荐优先使用 Go 或 Rust：

- 易于分发为单一二进制。
- 跨平台支持较好。
- 适合长连接、进程管理和流式 IO。

MVP 可以优先选择 Go：

- 标准库对 `os/exec`、信号、WebSocket 生态和跨平台构建支持成熟。
- 开发速度较快，便于先打通端到端链路。

### 7.2 本地配置

示例配置：

```yaml
device:
  name: "Home Mac"
router:
  url: "wss://agentbridge.example.com/ws/daemon"
auth:
  token: "local_device_token"
workspaces:
  - name: "my-app"
    path: "/Users/app/Projects/my-app"
agents:
  claude_code:
    command: "claude"
    default_args:
      - "--output-format"
      - "stream-json"
```

### 7.3 CLI 适配层

统一接口：

```text
AgentAdapter
- Name() string
- Detect() AgentCapability
- BuildCommand(task) CommandSpec
- ParseLine(line) AgentEvent
```

Claude Code 示例命令：

```bash
claude -p "重构登录逻辑" --output-format stream-json --allowedTools "bash,file"
```

适配层需要处理：

- 不同 CLI 的参数差异。
- 不同 JSON 事件格式。
- stdout 与 stderr 的拆分。
- 非 JSON 行的降级上报。
- CLI 退出码与失败原因。

### 7.4 进程管理

Daemon 必须按任务维护进程信息：

- `task_id`
- `pid`
- `process_group_id`
- `started_at`
- `workspace_path`
- `agent`
- `status`

终止任务时必须终止整个进程组，避免 Shell 子进程遗留。

### 7.5 工作区安全

MVP 必须采用白名单策略：

- 只能操作配置文件里声明的工作区。
- 禁止通过 `..`、符号链接绕过白名单。
- 任务执行前解析真实路径并校验前缀。
- 不接受 Web 端任意绝对路径，Web 端只能选择 Daemon 上报的 workspace。

## 8. Web Server 设计

### 8.1 职责边界

Web Server 同时承载前端页面、HTTP API 和 WebSocket 接入。内部的 Router 模块是轻量中转层，只做：

- WebSocket 连接维护。
- 用户、Web 会话和 Daemon 鉴权。
- 设备在线状态维护。
- 消息路由。
- 心跳检测。
- 当前内存任务状态维护。

Router 模块不做：

- 不解析代码仓库。
- 不运行 Agent。
- 不直接处理文件读写。
- 不修改 CLI 输出内容。

### 8.2 连接映射

核心映射表：

```text
user_id -> web_connection_ids[]
device_id -> daemon_connection_id
task_id -> device_id
```

路由规则：

- `task.dispatch`：Web -> Server -> 指定 Daemon。
- `task.event`：Daemon -> Server -> 发起任务的 Web 会话；也可广播到同用户其他打开页面。
- `task.stop`：Web -> Server -> 指定 Daemon。
- `daemon.heartbeat`：Daemon -> Server，更新在线状态。

### 8.3 离线与重连

- Daemon 断开：Server 将设备标记为 `offline`，通知 Web。
- Web 断开：任务不自动停止，Daemon 继续执行。
- Web 重连：MVP 阶段只能恢复当前内存中的任务状态；服务端重启后历史事件丢失。
- Daemon 重连：上报当前运行任务，Server 修复 `task_id -> device_id` 映射。

## 9. Web Console 设计

### 9.1 信息架构

采用三栏布局：

```text
+-----------------+-------------------------------------------------+-----------------+
| 左侧边栏         | 中间主工作区                                     | 右侧检查器       |
| Sidebar         | Chat & Execution Flow                           | Inspector       |
|-----------------+-------------------------------------------------+-----------------|
| 用户/账户        | 当前设备 / 工作区 / Claude Code                   | 当前任务指标      |
| 设备列表         | 对话与执行时间线                                  | 变更文件列表      |
| 工作区列表       | 工具调用、终端日志、文件修改                       | 运行状态          |
| 当前会话任务      | Prompt 输入框与发送按钮                           | Stop Task        |
+-----------------+-------------------------------------------------+-----------------+
```

### 9.2 左侧边栏

功能：

- 显示用户账户。
- 展示设备状态：在线、离线、忙碌。
- 展示当前设备的工作区列表。
- 展示当前会话内任务入口。

### 9.3 中间主工作区

功能：

- 顶部显示当前设备、工作区和 Claude Code 状态。
- 主体显示任务时间线：
  - 用户 Prompt。
  - Assistant 消息。
  - Tool Call 折叠块。
  - Shell 输出。
  - 文件修改摘要。
  - 错误与中断状态。
- 底部输入区：
  - 多行 Prompt。
  - 自动 Shell 开关。
  - 发送按钮。

### 9.4 右侧检查器

功能：

- 当前任务状态。
- 运行耗时。
- Token 和费用估算。
- 修改文件列表。
- 最近执行命令。
- Stop Task。

### 9.5 UI 事件渲染规则

| Event Type | UI 呈现 |
| --- | --- |
| `assistant.message` | 聊天气泡 |
| `tool.call` | 可折叠工具调用块 |
| `tool.output` | 等宽终端日志 |
| `file.changed` | 文件变更列表与 diff 摘要 |
| `metric.updated` | 右侧指标刷新 |
| `task.failed` | 错误状态卡片 |
| `task.killed` | 中断状态提示 |

### 9.6 移动端适配

Web Console 从 MVP 开始支持移动端浏览器。移动端不强行保留三栏同屏布局，而采用分屏与抽屉式结构：

- 默认显示中间任务流和底部输入框。
- 设备、工作区和当前会话任务放入左侧抽屉。
- 当前任务指标、变更文件和 Stop Task 放入右侧抽屉或底部详情面板。
- 输入框、发送按钮和 Stop Task 必须适配触屏操作。
- 长日志和工具输出默认折叠，避免移动端滚动失控。

## 10. 安全设计

### 10.1 鉴权

- 用户登录 Web Console 后获得 Web 会话。
- Daemon 通过设备 Token 连接 Web Server。
- 设备首次绑定建议使用一次性 pairing code。
- Web Server 校验设备归属关系，禁止跨用户路由。

### 10.2 权限控制

- 工作区必须由本地配置显式声明。
- Web 端不能传入未授权路径。
- `auto_shell` 默认关闭。
- 高风险工具或命令需要本地策略限制。
- 后续版本可增加命令审批、敏感路径保护和只读模式。

### 10.3 数据边界

云端可能接触：

- 用户 Prompt。
- Agent 输出事件。
- 命令文本。
- 文件路径和 diff 摘要。

云端不应该接触：

- 完整代码仓库。
- 本地 CLI API Key。
- 本地环境变量。
- 未经用户授权的文件内容。

需要在产品文案和配置中明确这个边界。

## 11. 状态与持久化设计

MVP 阶段任务可以先不做持久化。服务端只维护内存状态：

- 当前在线设备。
- 当前 WebSocket 连接。
- 当前运行任务。
- 当前任务的事件缓冲区。

需要接受的 MVP 限制：

- 服务端重启后任务历史丢失。
- Web 刷新后只能恢复服务端内存中还保留的当前任务事件。
- 已结束任务不保证可回看。
- 任务历史入口可以先隐藏或只显示当前会话内历史。

后续生产化再补充数据库持久化，建议表包括 `users`、`devices`、`workspaces`、`tasks`、`task_events`、`device_sessions`。

## 12. 端到端业务流

### 12.1 设备绑定

1. 用户在 Web 创建新设备，获得一次性 pairing code。
2. 用户在本地执行 Daemon 初始化命令，输入 pairing code。
3. Daemon 向 Web Server 注册设备并拿到长期设备 Token。
4. Daemon 保存本地配置并建立 WSS 连接。
5. Web 显示设备在线。

### 12.2 任务执行

1. Web 选择设备、工作区和 Agent。
2. 用户输入 Prompt 并发送。
3. Web Server 创建内存任务，路由 `task.dispatch` 到 Daemon。
4. Daemon 校验工作区和 Agent。
5. Daemon spawn CLI 子进程。
6. Daemon 逐行读取 stdout/stderr。
7. Daemon 将 CLI 输出转换为标准事件并上报。
8. Web 实时渲染事件流。
9. CLI 退出后，Daemon 上报最终状态。

### 12.3 任务停止

1. 用户点击 Stop Task。
2. Web 发送 `task.stop`。
3. Web Server 转发给 Daemon。
4. Daemon 终止任务进程组。
5. Daemon 上报 `task.killed`。
6. Web 锁定输入状态并展示中断结果。

## 13. MVP 范围

### 13.1 必须完成

- 单用户登录或本地开发模式。
- 设备 Daemon 连接 Web Server。
- Web 显示设备在线状态。
- 本地工作区白名单配置。
- Web 下发 Prompt 到指定工作区。
- Daemon 调用 Claude Code JSON 流模式。
- Web 实时显示原始事件和基础聊天流。
- Stop Task。
- 当前会话内任务状态。

### 13.2 可以延后

- 多用户组织与权限。
- 多 Agent 支持。
- 文件 diff 的富展示。
- Prompt 模板库。
- 任务计划与定时执行。
- 任务持久化和历史回看。
- 本地命令审批工作流。

## 14. 技术路线建议

### 14.1 前端

- MVP 前端先由 Go Web Server 直接托管一个轻量响应式页面，减少工程复杂度。
- 后续 UI 复杂度上来后，可以再迁移到 React / Next.js。
- WebSocket 客户端维护实时事件。
- 日志和事件流需要虚拟滚动，避免长任务卡顿。
- 响应式布局需要覆盖桌面三栏、平板双栏、手机单栏加抽屉。

### 14.2 Web Server

- MVP 使用 Go 开发。
- 单进程同时提供 Web 页面、HTTP API 和 WebSocket。
- 任务、设备连接和事件缓冲区先放内存。
- 后续需要生产化时再加入数据库、登录态和设备绑定。

### 14.3 Daemon

- MVP 使用 Go 开发，分发为单二进制。
- 使用本地配置文件管理设备、Web Server、工作区和 Claude Code。
- 每个任务独立进程组。
- stdout/stderr 分别流式读取。

### 14.4 当前原型代码结构

```text
cmd/server      Go Web Server 入口
cmd/daemon      Go Local Daemon 入口
internal/server WebSocket 路由和内置 Web UI
internal/daemon 配置、Claude Code 进程管理、事件转发
internal/protocol 通用消息协议
```

## 15. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| CLI JSON 格式变化 | UI 解析失败 | 保留 `raw`，适配层版本化，非 JSON 降级为日志事件 |
| Agent 误操作代码 | 破坏本地仓库 | 工作区白名单、Stop Task、默认关闭自动 Shell、后续加入审批 |
| Web 断线 | 用户看不到进度 | 任务继续执行，Web 重连后从内存事件缓冲区补拉 |
| Daemon 断线 | 任务状态不确定 | Daemon 重连上报运行任务，Server 标记状态为 unknown/running |
| 子进程遗留 | 资源泄露或继续修改文件 | 使用进程组，SIGTERM 后 SIGKILL |
| 服务端泄露敏感输出 | 安全风险 | MVP 尽量减少保留，后续加入敏感字段过滤和用户可配置事件保留周期 |

## 16. 迭代计划

### Phase 0：技术验证

- 本地 Daemon 调起 Claude Code。
- 读取 stream-json 输出。
- WebSocket 将事件推到一个简单 Web 页面。
- 支持 Stop Task。
- Web 页面和 WebSocket 放在同一个服务端项目内。

### Phase 1：MVP

- 设备绑定。
- 工作区白名单。
- 桌面三栏 Web 控制台。
- 移动端单栏加抽屉布局。
- 当前会话任务列表。
- 基础事件标准化。
- 基础鉴权。

### Phase 2：可用性增强

- 文件变更 diff 展示。
- 多 Agent 支持。
- 命令审批。
- 事件搜索。
- 长任务重连恢复。
- 任务持久化和历史回看。

### Phase 3：团队与生产化

- 多用户、多组织。
- RBAC。
- 审计日志。
- 部署监控。
- 企业安全策略。

## 17. 待确认问题

- Claude Code 的具体启动参数和权限策略。
- 移动端首屏的默认信息密度和 Stop Task 入口位置。
- 内存事件缓冲区大小，例如每个任务最多保留多少条事件。
- 是否允许云端保存 Prompt 和 Agent 输出，或者提供本地-only 模式。
- Stop Task 是否需要二次确认。
