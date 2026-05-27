# PocketStudio MVP

Go + React 版远程 Claude Code 控制台原型。

## 运行服务端

```bash
go run ./cmd/server -addr :18080
```

打开：

```text
http://localhost:18080
```

服务端同时提供：

- React Web 页面：`/`
- Web 控制台 WebSocket：`/ws/web`
- Daemon WebSocket：`/ws/daemon`

服务端会优先托管 `web/dist`。如果还没构建前端，则回退到 Go 内置 HTML。

## 前端开发

```bash
cd web
npm install
npm run dev
```

Vite 开发服务会把 `/ws` 代理到 `localhost:18080`。

构建前端：

```bash
cd web
npm run build
```

任务和事件目前保存在内存里，daemon 进程重启后会丢失。

## 运行 Daemon

生成配置：

```bash
go run ./cmd/daemon -init-config -config agentbridge.daemon.json
```

编辑 `agentbridge.daemon.json`，把 `workspaces[0].path` 改成允许远程操作的本地项目目录。

启动 Daemon：

```bash
go run ./cmd/daemon -config agentbridge.daemon.json
```

Daemon 会连接 `ws://localhost:18080/ws/daemon`，并在收到任务后执行：

```bash
claude --output-format stream-json --verbose -p "<prompt>" --allowedTools file,bash
```

## 构建

```bash
cd web && npm run build
go build ./cmd/server
go build ./cmd/daemon
```

## 当前限制

- MVP 只支持 Claude Code。
- 没有登录和设备绑定，适合本地开发验证。
- 没有任务持久化。
- WebSocket 当前未做 Token 鉴权。
- Claude Code 的 JSON 事件只做基础分类，原始事件会保留在 `raw` 字段。
