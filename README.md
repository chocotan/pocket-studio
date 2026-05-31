# Pocket Studio

Pocket Studio 是一个远程开发控制台，由三部分组成：

- `server`：托管用户注册登录、token 管理、Studio 页面，并转发浏览器和 daemon 的消息。
- `daemon`：运行在开发机器上，连接 server，上报本机工作区并执行任务。
- `studio-frontend`：浏览器或 AppImage 中使用的 Studio 工作台。

配置方式统一为命令行参数。server 参数全部使用 `-server.*`，daemon 参数全部使用 `-daemon.*`。项目不再读取 `server.json`、`daemon.json`、`client.json`。

## 1. 本机使用

本机使用适合单机开发验证。AppImage 默认会同时启动 UI、server、daemon，server 不开启用户认证，daemon 不需要 token。

构建 AppImage：

```bash
bash scripts/build-packages.sh
```

运行：

```bash
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage
```

等同于：

```bash
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage ui server daemon
```

常用本机参数：

```bash
# 指定本机 server 监听地址
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage ui server daemon --server.addr=127.0.0.1:18080

# 只打开 UI，连接已有 server
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage ui --ui.server.url=http://127.0.0.1:18080

# 只启动 daemon，连接已有 server
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage daemon --daemon.server.url=ws://127.0.0.1:18080/ws/daemon
```

本机 server 默认开放访问：

```bash
go run ./cmd/server -server.addr :18080
```

本机 daemon 默认连接 `ws://localhost:8080/ws/daemon`。如果 server 不是默认端口，需要显式指定：

```bash
go run ./cmd/daemon \
  -daemon.server.url ws://127.0.0.1:18080/ws/daemon \
  -daemon.workspace /home/choco/Downloads/pocket-studio
```

## 2. 如何部署服务端使用

服务端模式适合多用户或多机器使用。server 开启注册登录后，用户在首页注册登录并创建 token；daemon 和 Studio 都使用这个 token 连接 server。server 根据 token 找到所属用户，只返回这个用户的开发设备和项目。

服务端首页：

```text
http://<server>:18080/
```

Studio 页面：

```text
http://<server>:18080/studio/
```

### 2.1 部署服务端

构建前端和 server：

```bash
cd studio-frontend && npm run build
cd ../user-frontend && npm run build
cd ..
go build -trimpath -ldflags="-s -w" -o dist/pocket-studio-server-bin ./cmd/server
```

在服务端机器准备目录：

```bash
mkdir -p ~/pocket-studio-server/bin
mkdir -p ~/pocket-studio-server/ui
mkdir -p ~/pocket-studio-server/user-ui
mkdir -p ~/.config/pocket-studio
```

复制文件到服务端机器：

```bash
scp dist/pocket-studio-server-bin <user>@<server>:~/pocket-studio-server/bin/pocket-studio-server
scp -r studio-frontend/dist <user>@<server>:~/pocket-studio-server/ui/
scp -r user-frontend/dist <user>@<server>:~/pocket-studio-server/user-ui/
```

启动开启注册登录的 server：

```bash
cd ~/pocket-studio-server
./bin/pocket-studio-server \
  -server.addr :18080 \
  -server.auth.enabled \
  -server.auth.db ~/.config/pocket-studio/server-auth.sqlite \
  -server.auth.allow-register=true
```

可选：指定管理员 token。这个 token 可以直接给 daemon 和 Studio 使用，属于内置管理员身份。

```bash
./bin/pocket-studio-server \
  -server.addr :18080 \
  -server.auth.enabled \
  -server.admin-token ps_admin_xxxxx \
  -server.auth.db ~/.config/pocket-studio/server-auth.sqlite
```

systemd 用户服务示例：

```ini
[Unit]
Description=Pocket Studio Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/choco/pocket-studio-server
ExecStart=/home/choco/pocket-studio-server/bin/pocket-studio-server -server.addr :18080 -server.auth.enabled -server.auth.db /home/choco/.config/pocket-studio/server-auth.sqlite -server.auth.allow-register=true
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

保存到：

```text
~/.config/systemd/user/pocket-studio-server.service
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pocket-studio-server.service
```

常用运维命令：

```bash
systemctl --user status pocket-studio-server.service --no-pager -l
journalctl --user -u pocket-studio-server.service -f
systemctl --user restart pocket-studio-server.service
```

部署完成后打开 `http://<server>:18080/`，注册用户，登录后创建 token。

### 2.2 启动 daemon

daemon 运行在开发机器上。它只关心 server 地址和 token，不需要知道用户是谁。

启动示例：

```bash
go run ./cmd/daemon \
  -daemon.server.url ws://nas.local.javaer101.com:18080/ws/daemon \
  -daemon.server.token ps_xxxxx \
  -daemon.workspace /home/choco/Downloads/pocket-studio
```

可选参数：

```bash
go run ./cmd/daemon \
  -daemon.device.id dev_local \
  -daemon.device.name "Dev Machine" \
  -daemon.server.url ws://nas.local.javaer101.com:18080/ws/daemon \
  -daemon.server.token ps_xxxxx \
  -daemon.workspace pocket-studio:pocket-studio:/home/choco/Downloads/pocket-studio \
  -daemon.acpx.enabled=true \
  -daemon.acpx.command acpx \
  -daemon.acpx.agent claude \
  -daemon.acpx.session-name agentbridge \
  -daemon.acpx.ttl-seconds 300 \
  -daemon.acpx.args --format,json,--approve-all \
  -daemon.claude.command claude \
  -daemon.claude.args --output-format,stream-json,--verbose
```

多个工作区可以重复传 `-daemon.workspace`：

```bash
go run ./cmd/daemon \
  -daemon.server.url ws://nas.local.javaer101.com:18080/ws/daemon \
  -daemon.server.token ps_xxxxx \
  -daemon.workspace pocket-studio:pocket-studio:/home/choco/Downloads/pocket-studio \
  -daemon.workspace agent:Agent:/home/choco/Agent
```

daemon 成功连接后，Studio 中会看到开发设备。

### 2.3 使用浏览器的 Studio 或 AppImage 修改服务器和 token

浏览器方式：

```text
http://<server>:18080/
```

登录后创建 token。token 下方的“前往 Studio”会打开：

```text
http://<server>:18080/studio/?server_url=http://<server>:18080&token=ps_xxxxx
```

Studio 的配置读取顺序：

1. 先从 URL 参数读取 `server_url` 和 `token`。
2. URL 没有时，从浏览器 `localStorage` 读取。
3. 在 Studio 设置里保存的 `server_url` 和 token 会写入 `localStorage`。
4. 保存后页面会跳转到带 `server_url` 和 `token` 的 `/studio/` URL。

使用 AppImage 连接远程 server：

```bash
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage ui --ui.server.url=http://nas.local.javaer101.com:18080
```

打开 UI 后进入设置，填写：

```text
Server URL: http://nas.local.javaer101.com:18080
Access Token: ps_xxxxx
```

也可以直接启动远程 daemon：

```bash
./dist/electron/PocketStudio-0.0.0-x86_64.AppImage daemon \
  --daemon.server.url=ws://nas.local.javaer101.com:18080/ws/daemon \
  --daemon.server.token=ps_xxxxx
```

保存后 Studio 会使用该 token 查询对应用户的开发设备和项目。
