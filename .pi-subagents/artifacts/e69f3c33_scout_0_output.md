# Code Context — `skill.*` request/response wiring

Repository: `/home/choco/Downloads/remote-agent` (Go daemon + server, React/Vite studio-frontend).

The codebase has **no existing `skill.*` types or UI**; new types must be added to `internal/protocol/protocol.go` and wired through the existing request/response patterns below.

---

## 1. CRUD request flow (Studio UI → server hub → daemon → back to requesting client ONLY)

The cleanest template is `TypeProjectCreate` (UI → HTTP API → server hub → daemon → HTTP response). The same envelope flow is also used for `TypeWorkspaceRead` / `TypeWorkspaceWrite` etc.

### 1a. Envelope & request types — `internal/protocol/protocol.go`

- `Envelope` struct (lines 76–84):
  ```go
  type Envelope struct {
      ID        string          `json:"id"`
      Type      string          `json:"type"`
      Version   int             `json:"version"`
      Timestamp int64           `json:"timestamp"`
      From      string          `json:"from"`
      To        RouteTarget     `json:"to,omitempty"`
      TraceID   string          `json:"trace_id,omitempty"`
      Payload   json.RawMessage `json:"payload,omitempty"`
  }
  type RouteTarget struct { DeviceID string `json:"device_id,omitempty"`; TaskID string `json:"task_id,omitempty"` }
  ```
- Message type constants block (lines 12–58). Existing CRUD-style constants worth copying:
  - `TypeProjectCreate = "project.create"` (line 41)
  - `TypeProjectResult = "project.result"` (line 45) — used as the `request_id`-correlated reply
  - `TypeWorkspaceRead = "workspace.read"` (line 37)
  - `TypeWorkspaceResult = "workspace.result"` (line 39)
  - `TypeTerminalRun = "terminal.run"` / `TypeTerminalResult = "terminal.result"` (lines 47–48)
- Request/result payload structs: `ProjectCreateRequest` (line 198), `ProjectResult` (line 217), `WorkspaceReadRequest` (line 173), `WorkspaceResult` (line 190). All carry `RequestID string \`json:"request_id"\``.
- Helpers: `protocol.NewEnvelope(type, from, payload)` (line 503) and `protocol.DecodePayload[T](env)` (line 515).

### 1b. Server hub entry points — `internal/server/hub.go`

- `Hub.ServeAPI` (lines 877–1259). `POST /api/project/create` (lines 977–997) is the template:
  ```go
  requestID := protocol.NewID("req")
  env, err := h.requestDaemonForDevice(r, req.DeviceID, protocol.TypeProjectCreate,
      req.WorkspacePath, requestID, protocol.ProjectCreateRequest{
          RequestID:     requestID,
          Name:          req.Name,
          DeviceID:      req.DeviceID,
          WorkspacePath: req.WorkspacePath,
      })
  writeProjectResult(w, env, err, true, func(project *Project) { ... })
  ```
  Other examples: `/api/project/delete` (line 999), `/api/project/state` GET (1059) / POST (1090), `/api/project/file/read` (1152), `/api/project/file/write` (1190), `/api/workspace/list|read|write` (1216–1256), `/api/terminal/run` (1258).
- **Pending-request correlation** — `Hub.requestDaemonForDevice` (lines 2697–2761):
  ```go
  response := make(chan protocol.Envelope, 1)
  h.mu.Lock()
  h.pending[scopedKey(userID, requestID)] = response
  h.mu.Unlock()
  defer func() { h.mu.Lock(); delete(h.pending, scopedKey(userID, requestID)); h.mu.Unlock() }()
  env := protocol.NewEnvelope(messageType, "server", payload)
  env.To.DeviceID = deviceID
  dc.enqueue(env)
  select {
  case result := <-response:           // daemon reply arrives via resolvePending
      return result, nil
  case <-r.Context().Done():
      return protocol.Envelope{}, r.Context().Err()
  case <-time.After(30 * time.Second):
      return protocol.Envelope{}, errors.New("daemon request timed out")
  }
  ```
- **Hub inbound dispatch (request_id → pending channel)** — `Hub.handleDaemonMessage` switch (lines 1855, 2142):
  ```go
  case protocol.TypeWorkspaceResult, protocol.TypeTerminalResult,
       protocol.TypeProjectResult, protocol.TypeDeviceAliasSet:
      if h.resolvePending(dc.userID, env) { return }
      forward := env; forward.From = "server"
      h.broadcastToUser(dc.userID, forward)
  case protocol.TypeServerError:
      if h.resolvePending(dc.userID, env) { return }
      forward := env; forward.From = "server"
      h.broadcastToUser(dc.userID, forward)
  ```
  `resolvePending` (lines 2763–2776) reads `request_id` from the payload via `requestIDFromEnvelope` (lines 2778–2786) and writes the envelope to the channel. **If the request_id matches a pending HTTP call, the result goes ONLY to the requester** (it is NOT broadcast). Otherwise it is broadcast to all the user's web sockets.

### 1c. Daemon side — `internal/daemon/daemon.go`

- `Daemon.handleEnvelope` (line 1081). Each CRUD case is wired with the same shape:
  ```go
  case protocol.TypeProjectCreate:
      request, err := protocol.DecodePayload[protocol.ProjectCreateRequest](env)
      if err != nil { d.sendProjectError("", err.Error()); return }
      go d.createProject(request)
  case protocol.TypeProjectStateGet: ...   // line 1189
  case protocol.TypeProjectStateSet: ...   // line 1196
  case protocol.TypeWorkspaceRead:  ...   // line 1154
  case protocol.TypeWorkspaceWrite:  ...   // line 1161
  case protocol.TypeTerminalRun:     ...   // line 1203
  ```
- Handler entry: `createProject` (line 2877), `deleteProject` (line 2908), `readWorkspaceFile` (line 2770), `writeWorkspaceFile` (line 2814), `runTerminalCommand` (line 3059), `getProjectState` (line 2986), `setProjectState` (line 3030), `setDeviceAlias` (line 3133).
- Response helpers (lines 3098–3165):
  ```go
  func (d *Daemon) sendWorkspaceResult(result protocol.WorkspaceResult) {
      d.send <- protocol.NewEnvelope(protocol.TypeWorkspaceResult, "daemon", result)
  }
  func (d *Daemon) sendProjectResult(result protocol.ProjectResult) {
      d.send <- protocol.NewEnvelope(protocol.TypeProjectResult, "daemon", result)
  }
  func (d *Daemon) sendProjectError(requestID, message string) {
      d.sendProjectResult(protocol.ProjectResult{RequestID: requestID, Error: message})
  }
  func (d *Daemon) sendWorkspaceError(requestID, message string) { ... }
  func (d *Daemon) sendTerminalError(requestID, command, message string) { ... }
  func (d *Daemon) emitRequestError(requestID, code, message string) { // TypeServerError
      d.send <- protocol.NewEnvelope(protocol.TypeServerError, "daemon", protocol.ServerError{Code: code, Message: message, RequestID: requestID})
  }
  func requestIDFromEnvelope(env protocol.Envelope) string { // line 3464
      var obj map[string]any
      if err := json.Unmarshal(env.Payload, &obj); err != nil { return "" }
      requestID, _ := obj["request_id"].(string)
      return requestID
  }
  ```
- Daemon read loop dispatches via `d.handleEnvelope(connCtx, env)` (line 449) after `json.Unmarshal` of the websocket text frame.
- HTTP response wrapper helpers in hub.go: `writeAPIEnvelope` (3038), `writeProjectFileReadEnvelope` (3063), `writeProjectResult` (3102), `writeDeviceAliasResult` (3131), `writeProjectStateResult` (3157).

### 1d. Net flow (project.create)

1. UI calls `postJSON("/api/project/create", {...})` (`App.tsx:248`, `studio-dashboard.tsx:485`).
2. Hub `ServeAPI` → `Hub.requestDaemonForDevice` builds envelope, registers `h.pending[userID\x00requestID] = ch`, enqueues to daemon via `dc.enqueue(env)`.
3. Daemon `handleEnvelope` → `createProject` → `sendProjectResult` (TypeProjectResult, "daemon", ProjectResult{RequestID,...}).
4. Hub `readDaemonLoop` → `handleDaemonMessage` → `resolvePending` matches `request_id`, writes envelope to the channel. **No broadcast.**
5. `requestDaemonForDevice` returns the envelope; `writeProjectResult` writes the HTTP JSON response.

---

## 2. Same request flow through `internal/daemon/direct_web.go` (daemon direct websocket)

The daemon opens its own websocket server on `d.cfg.DirectWeb.ListenAddr` so a browser can bypass the hub and talk directly to the daemon (with a per-project token).

- Server bootstrap: `Daemon.startDirectWebServer` (lines 47–67) registers two routes:
  - `/ws/terminal` → `handleDirectTerminalWebSocket` (line 70) — terminal I/O only.
  - `/ws/agent`    → `handleDirectAgentChatWebSocket` (line 153) — **the CRUD-style channel**.
- Auth check (identical in both handlers, lines 76–82 and 159–165):
  ```go
  projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
  ...
  if !protocol.VerifyDirectTerminalToken(d.cfg.DirectWeb.Token, projectID, r.URL.Query().Get("token"), time.Now()) {
      http.Error(w, "unauthorized", http.StatusUnauthorized)
      return
  }
  ```
  Token issuance lives in `Hub.attachDirectEndpointLocked` (hub.go:432) and is embedded in `Project.DirectEndpoint.Token` (5-minute-truncated, 15-minute TTL).
- Per-project daemon lookup: `Daemon.projectForDirectTerminal` (line 252). Per-task command whitelist: `isDirectAgentChatCommandType` (line 421). Per-task envelope guard: `envelopeMatchesDirectTask` (line 437).
- **Dispatch switch for direct agent-chat CRUD**: `Daemon.handleDirectAgentChatEnvelope` (lines 388–419):
  ```go
  case protocol.TypeSessionList:        go d.listDirectACPSessions(...)
  case protocol.TypeSessionCreate:      go d.createSession(...)
  case protocol.TypeTaskDispatch:       go d.startTask(...)
  case protocol.TypeTaskStop:           go d.stopTask(...)
  case protocol.TypeTaskSetModel:       go d.setTaskModel(...)
  case protocol.TypeTaskSetConfigOption:go d.setTaskConfigOption(...)
  case protocol.TypeSessionDelete:      go d.deleteSession(...)
  default: return false
  ```
- **Main read loop & response envelope write** (lines 192–243):
  ```go
  for {
      var env protocol.Envelope
      if err := conn.ReadJSON(&env); err != nil { break }
      if env.From == "" { env.From = "web" }
      if env.Type == "ping" { _ = subscriber.writeEnvelope(protocol.NewEnvelope("pong","daemon",nil)); continue }
      if !isDirectAgentChatCommandType(env.Type) {
          _ = subscriber.writeEnvelope(directServerError("unsupported_type", "unsupported agent chat websocket message type", env.ID))
          continue
      }
      if !envelopeMatchesDirectTask(env, taskID) { ... }
      if env.Type == protocol.TypeTaskHistoryGet { ... }
      if env.To.DeviceID == "" { env.To.DeviceID = d.cfg.Device.ID }
      if !d.handleDirectAgentChatEnvelope(env) {
          _ = subscriber.writeEnvelope(directServerError("bad_payload", "invalid agent chat websocket message payload", env.ID))
      }
  }
  ```
  Responses are written back via `subscriber.writeEnvelope(protocol.NewEnvelope(...))` (line 559). Errors use `directServerError` (line 451). History paging uses `sendDirectTaskHistory` (line 364) + `TypeTaskHistoryReady` envelope.
- All handler functions (`createSession`, `startTask`, `setTaskModel`, etc.) push their result envelopes to `d.send`, which the **server hub also receives** because the same daemon maintains a hub-side websocket for state sync; responses therefore also propagate via the hub broadcast path for subscribed agents. The `directAgentChatSubscribers` map (line 320) keeps per-task direct subscribers so a project can talk to its own daemon without going through the hub.

> Note: the direct_web path currently does NOT route `TypeWorkspaceRead/Write/List`, `TypeProjectCreate/Delete/StateGet/StateSet`, or `TypeTerminalRun`. Adding a `skill.*` request will require either (a) extending `isDirectAgentChatCommandType` and `handleDirectAgentChatEnvelope`, or (b) introducing a new `/ws/...` route pair.

---

## 3. `DaemonHello.Features` population & how the server (and the frontend) consume it

### Daemon → server
- `Daemon.helloEnvelope` (`internal/daemon/daemon.go:3115`):
  ```go
  return protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
      DeviceID: d.cfg.Device.ID, DeviceName: d.cfg.DisplayDeviceName(),
      DaemonVersion: "0.1.0",
      Agent: d.agentName(), AgentLabel: d.agentLabel(),
      Agents: d.agentCapabilities(),
      Workspaces: d.workspacesSnapshot(),
      Features: []string{protocol.FeatureTerminalBinaryV1, protocol.FeatureDirectTerminalV1},
      DirectEndpoint: d.directEndpoint(),
  })
  ```
  Sent at connect time (line 402) and again after every `createProject` / `deleteProject` (via `d.sendHello()` at daemon.go:2906, 2978).
- `protocol.FeatureTerminalBinaryV1 = "terminal.binary.v1"` and `protocol.FeatureDirectTerminalV1 = "terminal.direct.v1"` are the only two advertised features today (`internal/protocol/protocol.go:62–64`).

### Server-side consumption
- `Hub.handleDaemonMessage` for `TypeDaemonHello` (`internal/server/hub.go:1813–1831`):
  ```go
  dc.terminalBinary = hasFeature(hello.Features, protocol.FeatureTerminalBinaryV1)
  dc.directEndpoint = hello.DirectEndpoint
  ```
- `deviceFeatures` (hub.go:2167) re-derives the feature list for `DeviceView.Features` in the server-state push.
- The server greets the daemon back with its own features when terminal binary mode is on: `TypeServerHello` (line 1830) carrying `protocol.ServerHello{Features: []string{FeatureTerminalBinaryV1}}`. The daemon's `TypeServerHello` case (daemon.go:1083) sets `d.terminalBinary` accordingly.

### Frontend gating
- **The frontend currently does not gate UI on `Features` at all.** `studio-frontend/src/lib/types.ts:Device` exposes only `id, name, agent, agent_label, agents, workspaces`. `grep -ri "feature" studio-frontend/src` returns zero hits. The `DeviceView.Features` field is plumbed all the way to the browser (hub.go:2200 → `server.state` envelope → `App.tsx:141–148 setDevices(...)`) but is currently discarded by the `isDevice` predicate (App.tsx:677).
- A new `skill.library.v1` (or similar) feature would have to: (1) be added to `Features: []string{...}` in `helloEnvelope`, (2) be modeled in `Device`/`DeviceView`, and (3) be checked somewhere (e.g. `availableTerminalTypes` in `terminal-panel-view.tsx` is the model for "show this tab type" gating — line 836).

---

## 4. Frontend WS client helper (envelope send + request_id correlation)

### Top-level transport (no request/response correlation — broadcast only)
- `studio-frontend/src/components/studio/web-transport.ts` — `createStudioWebTransport({onEnvelope})` (line 21). Opens `/ws/web`, handles `pong`, reconnects. `StudioEnvelope` (line 3) mirrors `protocol.Envelope` (`id, type, version, timestamp, from, to{device_id,task_id}, trace_id, payload`).
- `App.tsx:62 envelopeHandlerRef`, `:124–162 envelopeHandlerRef.current` — global handler routes `server.state` (devices/projects) and `terminal.stream.alert` (notifications). **This transport does not support request/response correlation**; it is for server-initiated pushes.

### Per-project agent-chat WS — uses request_id correlation directly
- `studio-frontend/src/components/studio/agent-chat/agent-chat-tab.tsx:59–66` declares the `AgentEnvelope` shape; `envelopeTaskId(envelope)` (line 87) extracts the payload `task_id`.
- The two relevant patterns:
  - **Session-list (request → single result)**: `terminal-panel-view.tsx:850–904` — `fetchProviderSessions` opens a one-shot `WebSocket(agentChatWebSocketURL(targetProject, taskId).url)`, builds an envelope with `request_id` and `task_id` (lines 878–887), then matches the reply on `envelope?.type === "session.list.result" && envelope?.payload?.request_id === requestId` (line 892). This is the cleanest "send envelope → await response by request_id" template.
  - **Long-lived session** (`agent-chat-tab.tsx:821`): `sendAgentEnvelope(sessionTaskId, envelope)` queues or directly sends (line 821). Replies are correlated implicitly via `socketTaskIdRef === sessionTaskId` plus event-id sequencing (line 821+), not request_id.
- Helper `websocketURL(path, params?)` (`lib/api.ts:20`) and `directWebsocketURL(endpoint, params, token)` (`lib/api.ts:35`) build the URLs and inject the auth token.
- `agentChatWebSocketURL` lives in `studio-frontend/src/components/studio/agent-chat/direct-websocket.ts` and switches between hub relay (`/ws/agent?task_id=…`) and direct daemon URL when `project.direct_mode` is on.

> **Template to copy for `skill.*`**: `terminal-panel-view.tsx:850–904` — open a socket, send an envelope with `request_id` + `task_id`, resolve the promise when an envelope comes back whose `payload.request_id` matches. For repeating updates, model after `agent-chat-tab.tsx`.

---

## 5. Atomic file write helper — `internal/daemon/atomic_file.go`

Signature (`atomic_file.go:10`):
```go
func writeFileAtomic(path string, data []byte, perm os.FileMode) (retErr error)
```

Behavior summary (lines 12–55):
1. `os.MkdirAll(dir, 0o755)`.
2. `os.CreateTemp(dir, "."+base+".tmp-*")`; on error, `os.Remove` the temp file via deferred cleanup (`committed = false`).
3. `temp.Chmod(perm)`, write loop, `temp.Sync`, `temp.Close`.
4. `os.Rename(tempPath, path)` (atomic replace on POSIX).
5. `directory.Sync()` on the parent dir (best-effort, for platforms that support directory fsync).

Usage example (`internal/daemon/daemon.go:891`):
```go
err = writeFileAtomic(daemonDirectACPSessionsPath(), raw, 0o600)
```
This is the only production caller; tests live in `internal/daemon/atomic_file_test.go` (lines 16–20). For a skill library that persists per-user or per-device, calling `writeFileAtomic(skillsJSONPath, marshalledBytes, 0o600)` is the established pattern.

---

## 6. `startTerminalStream` and where `req.Command` is built for tmux

`internal/daemon/daemon.go:4261` — `startTerminalStream(parent context.Context, req protocol.TerminalStreamStart)`. The command pipeline (lines 4275–4310, in the order executed):

```go
terminalCommand := d.normalizeTerminalCommand(req.Command)                  // 4276
initialTitle   := initialTerminalTitle(terminalCommand, req.InitialTitle)   // 4277
agentName      := agentTerminalCommand(terminalCommand)                     // 4278
agentHooks     := d.prepareTerminalAgentHooks(workspace.Path, req.ProjectID, req.TerminalID, agentName) // 4279
command        := terminalAgentCommandWithHooks(terminalCommand, agentName, agentHooks.env)           // 4280
// ...
useTmux := req.UseTmux == nil || *req.UseTmux                               // 4288
if useTmux && os.Getenv("POCKET_STUDIO_DISABLE_TMUX") != "1" {
    cmd, err = tmuxNewSessionCommand(sessionName, initialTitle, workspace.Path, command, agentHooks.env)  // 4290
    // ...
}
// Fallback (no tmux) at line 4302:
if req.Command != "" {
    cmd = exec.Command(userShell(), "-lc", req.Command)
} else {
    cmd = exec.Command(userShell(), "-l")
}
```

Supporting helpers:
- `normalizeTerminalCommand` — wherever the Daemon sanitises the user-supplied command (search the file; not in the line window above).
- `initialTerminalTitle(command, fallback)` (daemon.go:4911).
- `agentTerminalCommand(command)` (daemon.go:5847) — returns canonical agent name (`claude`, `codex`, `opencode`, `kilo`, `pi`, `dsh`, …) by inspecting the first token.
- `terminalAgentCommandWithHooks(command, agent, env)` (daemon.go:5822) — appends `--extension <path>` for the `pi` agent so the terminal-hook extension is loaded. Uses `shellQuote(extensionPath)`.
- `tmuxNewSessionCommand(sessionName, initialTitle, workspacePath, command, env)` (daemon.go:4718) — builds the `tmux new-session` exec.Cmd; `command` is what gets passed to tmux as the spawned shell.

The PTY start, watcher goroutine, and exit envelope are at daemon.go:4312–4380.

> The `req.Command` field originates from `protocol.TerminalStreamStart.Command` (protocol.go:362). Inbound it comes either via the hub (`/api/...` flows) or `direct_web.go:124` (query string `command=`).

---

## 7. Frontend settings / panel component for a future "Skill Library" tab

There is **no Skill Library UI today**. The settings surface lives entirely in `studio-frontend/src/components/studio/`:

### Existing settings-equivalent components
- `studio-settings.tsx` — currently only exports `ShortcutSettingsContent` (line 18). Renders the shortcut-recorder UI; consumed by `studio-dashboard.tsx:494–506` inside a `Dialog`.
- `studio-dashboard.tsx:109–111` — state hooks `settingsOpen` (server URL/access-token dialog) and `shortcutSettingsOpen` (shortcuts dialog). The "settings" buttons (Settings / Keyboard icons) at `studio-dashboard.tsx` header area open these dialogs.
  - `Dialog` for server URL: lines 508–617 (`handleSaveSettings` at line 172).
  - `Dialog` for shortcuts: lines 494–506.

### Tab-kind extension model
- `StudioTabKind` is a closed union in `studio-frontend/src/components/studio/studio-layout.ts:11`:
  ```ts
  export type StudioTabKind = "terminal" | "file_explorer" | "file_viewer" | "agent_chat";
  ```
- `StudioTab` (line 13) — fields like `kind`, `title`, `termType`, `filePath`, `agentSessionId`, etc.
- Render dispatch in `terminal-panel-view.tsx:712–760` (the `<AddTabContent>`-style nested ternary) maps `tab.kind` → component. A new `skill_library` kind would slot in here and call `<SkillLibraryTab ... />`.
- Tab-add menu: `terminal-panel-view.tsx:205–220` (`tabLabel` / `tabIcon` helpers) and `terminal-panel-view.tsx` "panel-add-menu" block.
- `studio-layout-ops.ts:56` `addTabToPanel` and `:227` `updateTabPropertiesInTree` are the mutation helpers.
- Persistence: `studio-workspace.tsx` round-trips layout through `projectState.get/set` (`/api/project/state`) and `protocol.TypeProjectStateSet` (handled by daemon.go:3030 and the hub at hub.go:1090).

### Closest "settings-like panel" hosts for a Skill Library
1. A new `Dialog` opened from `studio-dashboard.tsx` (mirror the `shortcutSettingsOpen` pattern, lines 494–506). Best for a modal page (e.g. one-shot import, browse).
2. A new `StudioTabKind` value plus a `<SkillLibraryTab>` rendered via the `terminal-panel-view.tsx` ternary (lines 712–760). Best if skills should be browsable per-project inside the workspace. The tab would persist via `protocol.TypeProjectStateSet` like every other tab.

Both surfaces are reachable from the project switcher / dashboard — no nav overhaul required.

---

## Key file/line index

| Concern | File | Lines |
|---|---|---|
| Envelope + type constants | `internal/protocol/protocol.go` | 12–58, 76–84, 198–227 |
| `protocol.NewEnvelope` / `DecodePayload` | `internal/protocol/protocol.go` | 503–519 |
| Hub HTTP entry / project CRUD | `internal/server/hub.go` | 877–1259 |
| `requestDaemonForDevice` (correlation) | `internal/server/hub.go` | 2697–2761 |
| `handleDaemonMessage` (resolvePending) | `internal/server/hub.go` | 1759, 2142–2156, 2167 |
| Response writers (writeAPIEnvelope, writeProjectResult) | `internal/server/hub.go` | 3038–3168 |
| `daemonConn.enqueue` | `internal/server/hub.go` | 169–181 |
| Daemon read loop / handleEnvelope | `internal/daemon/daemon.go` | 416–460, 1081–1207 |
| Daemon CRUD handlers | `internal/daemon/daemon.go` | 2770, 2814, 2877, 2908, 2986, 3030, 3059, 3133 |
| Daemon result/error senders | `internal/daemon/daemon.go` | 3098–3165, 3464 |
| `Daemon.helloEnvelope` (Features) | `internal/daemon/daemon.go` | 3115–3125 |
| `startTerminalStream` tmux command | `internal/daemon/daemon.go` | 4261–4310 |
| Terminal helpers (normalize, agent hooks, tmux) | `internal/daemon/daemon.go` | 4718, 4911, 5822, 5847 |
| `internal/daemon/atomic_file.go` | `writeFileAtomic` | 10–55 |
| `internal/daemon/direct_web.go` (server + dispatch) | 47, 70, 153, 192–243, 388, 421, 437, 451, 559 |
| Frontend WS transport | `studio-frontend/src/components/studio/web-transport.ts` | 3, 21 |
| Frontend request_id template | `studio-frontend/src/components/studio/terminal-panel-view.tsx` | 850–904 |
| Frontend long-lived envelope send | `studio-frontend/src/components/studio/agent-chat/agent-chat-tab.tsx` | 59–87, 821, 1037–1057 |
| Frontend URL helpers | `studio-frontend/src/lib/api.ts` | 20, 35 |
| Frontend tab-kind union | `studio-frontend/src/components/studio/studio-layout.ts` | 11–32 |
| Tab render dispatch | `studio-frontend/src/components/studio/terminal-panel-view.tsx` | 712–760 |
| Tab mutation ops | `studio-frontend/src/components/studio/studio-layout-ops.ts` | 56, 227 |
| Existing settings dialogs | `studio-frontend/src/components/studio/studio-dashboard.tsx` | 109–111, 494–617 |
| Shortcut settings content | `studio-frontend/src/components/studio/studio-settings.tsx` | 18 |

## Start here for the new `skill.*` work
1. Add `TypeSkill*` constants and request/result payload structs to `internal/protocol/protocol.go` (mirror `ProjectCreateRequest` / `ProjectResult` at lines 198 / 217).
2. Add daemon handlers in `internal/daemon/daemon.go:handleEnvelope` switch (around line 1203) and a `d.sendSkill*Result` helper modeled on `sendProjectResult` (line 3104). Use `writeFileAtomic` (atomic_file.go:10) for any on-disk persistence.
3. Add a `POST /api/skill/...` route in `internal/server/hub.go:ServeAPI` (after line 1257) and call `h.requestDaemonForDevice` (line 2697) — this gives free request_id correlation through `h.pending`.
4. (Optional, for direct-mode projects) Extend `isDirectAgentChatCommandType` and `handleDirectAgentChatEnvelope` in `internal/daemon/direct_web.go:421/388`, and add the new `TypeSkill*` to `direct_web.go`'s dispatch. Add a new feature flag (e.g. `protocol.FeatureSkillLibraryV1 = "skill.library.v1"`) and append it to `Daemon.helloEnvelope` (daemon.go:3124). The server already propagates `Features` to the `DeviceView` payload — only the frontend needs to start reading it (extend `Device` in `studio-frontend/src/lib/types.ts` and the `isDevice` guard at `App.tsx:677`).
5. Frontend: model the request/response on `terminal-panel-view.tsx:850–904` for one-shot calls, or `agent-chat-tab.tsx:821` for long-lived sessions. Host the UI either in a new `Dialog` in `studio-dashboard.tsx` (template lines 494–506) or as a new `StudioTabKind` in `studio-layout.ts:11` with a render branch in `terminal-panel-view.tsx:712–760`.