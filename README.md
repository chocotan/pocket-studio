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

## AppImage 运行形态

Pocket Studio 只打包一个 Electron AppImage，里面包含 UI、server、daemon。启动时通过模块参数控制运行哪些部分：

```bash
pocket-studio ui
pocket-studio server
pocket-studio daemon
pocket-studio ui server daemon
```

不传模块参数时，默认等同于：

```bash
pocket-studio ui server daemon
```

统一配置仍然保存在 `~/.config/pocket-studio/client.json`。本机 standalone 模式会为本地 server 选择随机端口，并把实际地址写回配置：

```json
{
  "server_url": "http://127.0.0.1:<random-port>",
  "local_mode": true
}
```

常用启动方式：

```bash
# 本机 standalone：启动 UI + 随机端口 server + daemon
pocket-studio ui server daemon

# 只打开 UI，并连接已有 server
pocket-studio ui --ui.server.addr=http://localhost:10080

# 只启动 server
pocket-studio server --server.port=18080

# 只启动 daemon，并连接已有 server
pocket-studio daemon --daemon.server.addr=http://localhost:10080
```

如果 `ui server daemon` 同时存在，且没有显式指定 `--ui.server.addr` 或 `--daemon.server.addr`，UI 和 daemon 会自动连接本次启动的本地 server。

构建 AppImage：

```bash
bash scripts/build-packages.sh
```

产物：

- `dist/electron/PocketStudio-0.0.0-x86_64.AppImage`

运行：

```bash
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage ui server daemon
```

## 当前限制

- MVP 只支持 Claude Code。
- 没有登录和设备绑定，适合本地开发验证。
- 没有任务持久化。
- WebSocket 当前未做 Token 鉴权。
- Claude Code 的 JSON 事件只做基础分类，原始事件会保留在 `raw` 字段。
