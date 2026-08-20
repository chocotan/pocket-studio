# Code Context — Pocket Studio notification system

Repo: `/home/choco/Downloads/remote-agent` (Go daemon + Go server + 2 React frontends + Electron wrapper + Android client).

The notification system is **in-app only** (a React "Notification Center" panel + a ticker). It does **not** call `notify-send` / `osascript` / Electron `Notification` / `Notification` browser API / Android `NotificationManager` anywhere. The bug to fix is that the Go server's broadcast is **per-user, not per-workspace**, so alerts from any project show up in every open workspace and on the dashboard.

---

## 1. Where alerts are generated (Go daemon, not OS-level)

All "desktop" notifications are constructed in the Go daemon as a typed envelope `TypeTerminalStreamAlert = "terminal.stream.alert"`. The server forwards it; the React frontend shows it.

### 1a. `internal/daemon/daemon.go` — agent-completion alert

- `recordTaskEvent` (line ~3755) records a task event and calls `d.maybeSendAgentCompletionAlert(record, event)` (line 3778).
- `maybeSendAgentCompletionAlert` (lines 3779–3796) — triggers only for `task.completed | task.failed | task.killed` AND for records where `isAgentChatRecord(record)` is true (`AgentRuntime == "direct_acp"`).
  ```go
  func (d *Daemon) maybeSendAgentCompletionAlert(record protocol.TaskRecord, event protocol.TaskEvent) {
      if !isAgentCompletionEvent(event.EventType) { return }
      if !isAgentChatRecord(record) { return }
      projectID := d.projectIDForWorkspacePath(record.WorkspacePath)
      if projectID == "" { return }
      target := d.agentNotificationTarget(projectID, record)
      message := agentCompletionMessage(event.EventType)
      alert := d.agentCompletionAlert(projectID, target.hostProjectID, target.panelID, target.tabID,
                                      record.Agent, record.AgentRuntime, message)
      if alert == nil { return }
      d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamAlert, "daemon", *alert)
  }
  ```
  Key point: `projectID := d.projectIDForWorkspacePath(record.WorkspacePath)` resolves project from `record.WorkspacePath`. But the daemon's `agentNotificationTarget` then walks **all** project states and may pick a different host project (see §2a).

- `agentCompletionAlert` (lines ~4003–4048) builds `protocol.TerminalStreamAlert{ProjectID, HostProjectID, PanelID, TerminalID, Reason:"agent_done", Message, Agent, Title}`. `Title = "对话 (" + agent + ")"` from `agentNotificationTitle` (line 4051).
- `agentNotificationTitle(agent, runtime)` (line 4051) — `agent` only, runtime unused.

### 1b. `internal/daemon/daemon.go` — terminal/agent stop-hook alert

- `startTerminalHookServer` (line ~4370) starts an internal HTTP `POST /terminal-event` listener on `127.0.0.1:random`. Daemon URL+token are injected into spawned shells via env: `POCKET_STUDIO_HOOK_URL`, `POCKET_STUDIO_HOOK_TOKEN`, `POCKET_STUDIO_PROJECT_ID`, `POCKET_STUDIO_TERMINAL_ID`, `POCKET_STUDIO_AGENT` (set in `prepareTerminalAgentHooks`, line 4902).
- `handleTerminalHookEvent` (line ~4390) accepts `{token, project_id, terminal_id, agent, event, message}`. Only `event == "done" | "idle"` is forwarded; everything else returns 204.
- `terminalHookAlert` (line ~4416) builds a `TerminalStreamAlert{ProjectID: event.ProjectID, HostProjectID: target.hostProjectID, TerminalID: target.tabID, Reason:"agent_done", ...}` and pushes it into `d.send`.

Triggering agents: `claude/codex/opencode/kilo/pi/agy/antigravity` (see `supportsPluginTerminalAgent`, line ~5613). For each, the daemon writes a JS hook script via `pocketStudioTerminalNotifyScript` (line 5460). For Codex the script also wraps the existing `notify` command and stores the previous command in `codex-notify-previous.json` (`writeCodexNotifyIntegration` line 5066). For Pi a TypeScript extension is written to `~/.pi/agent/extensions/pocket-studio.ts` that calls `postPocketStudio()` on `agent_end`. For Antigravity, the `Stop` hook is added to `~/.gemini/antigravity-cli/settings.json` (line ~4985). For Claude, the `Stop` hook is added to `~/.claude/settings.json` (line ~4950).

### 1c. Protocol shape

`internal/protocol/protocol.go`
- `TypeTerminalStreamAlert = "terminal.stream.alert"` (line 46)
- `TerminalStreamAlert` struct (line 491):
  ```go
  type TerminalStreamAlert struct {
      ProjectID     string `json:"project_id"`
      HostProjectID string `json:"host_project_id,omitempty"`
      PanelID       string `json:"panel_id,omitempty"`
      TerminalID    string `json:"terminal_id"`
      Title         string `json:"title,omitempty"`
      Reason        string `json:"reason,omitempty"`
      Message       string `json:"message,omitempty"`
      Agent         string `json:"agent,omitempty"`
  }
  ```
  There is **no** `workspace_id` field. The closest is `ProjectID` (= the workspace-path-derived project id).

### 1d. Where alerts are NOT generated

- No `notify-send`, `osascript`, `terminal-notifier`, `growl`, `beep`, etc. in the Go code.
- No `electron.Notification` in `studio-frontend/electron/main.cjs` or `preload.cjs`.
- No `new Notification(` / `Notification.requestPermission` in any TS file under `studio-frontend/src` or `user-frontend/src`.
- `android-app` does not consume `terminal.stream.alert` (no notification code).

---

## 2. Workspace scoping — the bug

The "workspace" in this app is the `Project` object: `{id, name, device_id, workspace_path}` derived from a daemon's `protocol.Workspace{ID,Name,Path}` (`internal/server/hub.go:483–510`). It is identified by `ProjectID` everywhere in the alert path.

### 2a. Daemon-side: target resolution is global, not strict

`internal/daemon/daemon.go`
- `projectIDForWorkspacePath(workspacePath) -> projectID` (resolve the alert's project from a workspace path).
- `projectStateSnapshot` (line 3843) returns **all** projects' `StudioState` for the daemon.
- `orderedProjectStateIDs(states, preferred)` (line 3870) returns preferred id first, then every other id sorted.
- `agentNotificationTarget` (line 3818) and `terminalNotificationTarget` (line 3832) iterate **all** `hostProjectID`s and return the first that matches a tab id. Concretely:
  ```go
  for _, hostProjectID := range orderedProjectStateIDs(states, projectID) {
      target := agentTabTargetFromProjectState(states[hostProjectID], projectID, taskID, sessionName, hostProjectID == projectID)
      if target.tabID != "" {
          target.hostProjectID = hostProjectID
          return target
      }
  }
  return notificationTabTarget{hostProjectID: projectID, tabID: taskID}
  ```
  For non-preferred projects the per-tab `tabBelongsToProject` check is skipped (`allowMissingProjectID=true` when `hostProjectID != projectID`). So if the same task id is open in another project, the alert gets remapped to that other project's tab.
- `tabBelongsToProject` (line 3961): if the tab has no `projectId` set, it "belongs" to any project (this is what the cross-project fallback relies on).
- `tabMatchesNotificationID` (hub.go 739) matches by tab id, or by `agentSessionId`/`agentSessionName` for `agent_chat` tabs.

### 2b. Server-side: broadcast is per-user, not per-workspace — **root cause of the bug**

`internal/server/hub.go`
- Case `protocol.TypeTerminalStreamAlert` (lines 2134–2143):
  ```go
  case protocol.TypeTerminalStreamAlert:
      alert, err := protocol.DecodePayload[protocol.TerminalStreamAlert](env)
      if err == nil {
          if enriched, ok := h.enrichTerminalStreamAlert(dc.userID, alert); ok {
              env.Payload, _ = json.Marshal(enriched)
          }
          forward := env
          forward.From = "server"
          h.broadcastToUser(dc.userID, forward)   // <-- the leak
      }
  ```
- `broadcastToUser` (line 2814) walks **every** `webConn` for the user. There is no project filter on the broadcast.
  ```go
  func (h *Hub) broadcastToUser(userID string, env protocol.Envelope) {
      h.mu.RLock()
      webs := make([]*webConn, 0, len(h.webs))
      for wc := range h.webs {
          if wc.userID != userID { continue }
          webs = append(webs, wc)
      }
      h.mu.RUnlock()
      for _, wc := range webs { wc.tryEnqueue(env) }
  }
  ```
- `enrichTerminalStreamAlert` (line 629) does the same global "first host project that owns this terminal" remap as the daemon, with `allowMissingProjectID=true` for non-preferred projects.
- `webConn` (line 231) does not track which project the user is currently viewing — only `userID` + `conn`. There is no per-connection `selectedProjectId` field, so even a smarter broadcast (e.g. by `alert.ProjectID` or `alert.HostProjectID`) would need a way to know which project each socket is on. The frontend never sends such a hint (only URL path/route on initial connect).

Compare with the terminal title path (line 2118) which does filter per terminal: it uses `h.terminalSubscribers(key)` keyed by `userID + projectID + terminalID` (the `terminalKey` helper, `broadcastToUser` does not consult this). The alert path was implemented as a fan-out and never got this scoping.

**Result:** an alert for project A reaches the dashboard and every open workspace tab of the user; the React side has no choice but to accept it.

### 2c. Frontend-side: alert accepted unconditionally, then attributed to the wrong project

`studio-frontend/src/App.tsx`
- `envelopeHandlerRef` (line 86) routes `terminal.stream.alert` (line 91) to `addTerminalNotification`.
- The alert does not check `selectedProjectId`. The full envelope is processed and stored regardless of which project the user is viewing.
- `addTerminalNotification` (line 212) creates a `TerminalNotification` keyed by `event.projectId` (and host project id) — but the React state holds a single global list, so a project-B alert accumulates while the user is in project A.
- `unreadProjectIds` (line 47) and `unreadTerminalIds` (line 49) are derived sets that are passed to `StudioWorkspace` (line 382) for badge styling. They do not gate the broadcast — they only decorate the badges.

`studio-frontend/src/components/studio/hooks/useWorkspaceLayout.ts`
- `alertTerminalIds` (line 92, 103, 410) is consumed at line 410 to auto-mark a focused tab as read; not to filter incoming alerts.
- `collectNotificationTargets` (line 61) walks every panel/tab in the current workspace and feeds them to `notificationTargetsRef` in App via `onNotificationTargetsChange`. This ref is later used by `findNotificationHostTarget` to know which host project actually contains a tab with the alert's id.

`studio-frontend/src/components/studio/studio-dashboard.tsx`
- Receives the same global `notifications` array (line 310). There is no per-project filter on the dashboard's notification center.

---

## 3. Frontend structure

### studio-frontend (`/home/choco/Downloads/remote-agent/studio-frontend/`)
- **Stack**: React 19 + Vite 8 + TypeScript + Tailwind v4 + shadcn-style components + xterm.js + Monaco. See `package.json`.
- **Realtime transport**: a single WebSocket to `<server>/ws/web` opened by `createStudioWebTransport` in `src/components/studio/web-transport.ts`. Reconnect timer 1.5 s, ping every 10 s. Incoming envelopes are JSON; envelope type strings mirror Go (`terminal.stream.alert`, `server.state`, etc.). `envelopeHandlerRef.current` in `App.tsx` dispatches by `envelope.type`.
- **Electron wrapper**: `electron/main.cjs` runs a windowed BrowserWindow on `pocket-studio://app/studio/`, with `pocket-studio://` custom protocol registered to serve `dist/electron-resources/ui/dist`. `registerAppIPC` (line ~242) wires `daemon:sync-config`, `app:local-mode`, `app:set-zoom`, `clipboard:write-text`, `clipboard:paste`. **No notification IPC**.
- **Browser Notification API**: not used anywhere. No `new Notification(`, no `Notification.requestPermission`, no `Notification.permission`.
- **Per-tab agent transport**: `agentChatWebSocketURL` in `src/components/studio/agent-chat/direct-websocket.ts` opens `/ws/agent?task_id=...&project_id=...&history_paging=1` (or a daemon-direct variant when `project.direct_mode` is on). Wire types: `AgentEnvelope = {id,type,version,timestamp,from,to:{device_id},payload:Record<string,unknown>}` (`agent-chat-tab.tsx:57`). Event types handled in `message-reducer.ts` include `task.completed|task.failed|task.killed|task.stopped|task.started|user.prompt|tool.call|tool.output`. Per-tab data does not go through the global `/ws/web` transport.

### user-frontend (`/home/choco/Downloads/remote-agent/user-frontend/`)
- **Stack**: React 19 + Vite + TypeScript, no Tailwind. Plain auth + token management UI.
- **No realtime**: only REST calls via `lib/api.ts` to `/api/auth/*`, `/api/tokens*`. No WebSocket, no SSE, no notifications.
- `App.tsx` shows `AuthScreen` / `TokenPanel` / `UsagePanel`. There is no `terminal.stream.alert` handling here.

### Android client
- `android-app/` only has resize notifications (`notifyResizeSuppressionChanged`). No Pocket Studio notification integration.

---

## 4. Event/message flow end-to-end

### Outbound (daemon → frontend) — the alert path
1. `internal/daemon/daemon.go:recordTaskEvent` (line ~3755) on each `task.event`.
2. If completion event for a `direct_acp` agent, `maybeSendAgentCompletionAlert` (line 3779) builds a `TerminalStreamAlert` via `agentCompletionAlert` and pushes it into `d.send` channel.
3. In parallel, agent stop hooks (claude/codex/opencode/kilo/pi/antigravity) call `POST http://127.0.0.1:<port>/terminal-event` which calls `handleTerminalHookEvent` (line ~4390) → `terminalHookAlert` → `d.send`.
4. Daemon goroutine writes to its upstream WebSocket (`/ws/daemon` to the server) — see `writeDaemonLoop` and the case statements in `readDaemonLoop` around `protocol.TypeTerminalStreamAlert` is on the server side. Daemon serializes the envelope with `d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamAlert, "daemon", *alert)`.

### Inbound (server → all web clients for user)
1. `internal/server/hub.go` daemon message loop (line ~2134) handles `TypeTerminalStreamAlert`:
   - `enrichTerminalStreamAlert` (line 629) re-derives `HostProjectID` / `PanelID` / `TerminalID` by walking the user's cached project states, with cross-project `allowMissingProjectID=true` fallback.
   - `broadcastToUser(dc.userID, forward)` (line 2142) sends the envelope to **every** `/ws/web` connection owned by the user, with no per-project filter.

### Frontend consumption
1. `studio-frontend/src/components/studio/web-transport.ts:createStudioWebTransport` opens `/ws/web`; `socket.onmessage` parses JSON and calls `onEnvelope`.
2. `studio-frontend/src/App.tsx:envelopeHandlerRef` (line 86):
   - `envelope.type === "terminal.stream.alert"` (line 91) extracts `project_id`, `host_project_id`, `panel_id`, `terminal_id`, `title`, `reason`, `message` and calls `addTerminalNotification` (line 212) — **no project filter applied**.
   - `envelope.type === "server.state"` updates `devices`.
3. `addTerminalNotification` (line 212) dedupes by `${projectId}:${hostProjectId}:${tabId}:${reason}:${message}` for 800 ms, prepends to `terminalNotifications` (cap 100).
4. UI:
   - `notification-center.tsx` (lines 14–187) renders a bell + ticker + dropdown list, with `unreadCount` badge.
   - `useWorkspaceLayout.ts:410` watches `alertTerminalIds` to auto-mark the focused tab read.
   - `project-switcher.tsx:342` decorates rows whose project id is in `alertProjectIds`.

### Per-tab agent events (separate WebSocket)
- `/ws/agent?task_id=&project_id=&history_paging=1` carries `task.event` envelopes consumed by `agent-chat-tab.tsx` reducer (`message-reducer.ts`). This is per-session, not per-user, so it is not affected by the broadcast bug.

---

## Likely fix points (for the next agent / worker)

1. **Server scope (the real fix)**: in `internal/server/hub.go` `TypeTerminalStreamAlert` (line 2134), replace `h.broadcastToUser(dc.userID, forward)` with a per-connection selector. Either:
   - (a) Track each `webConn`'s currently-viewed `projectID` (sent by the client over `/ws/web`, e.g. a `project.focus` envelope) and skip conns where `alert.ProjectID` / `alert.HostProjectID` ≠ focused id. Add a field to `webConn` (line 231) and update it from a new envelope type.
   - (b) Use the existing `terminalSubscribers` mechanism (`terminalKey = userID + "\x00" + projectID + "\x00" + terminalID`) for a per-terminal subset, plus a project-level fan-out only to conns whose `selectedProjectId` matches.
2. **Optional cross-project safety**: tighten `tabBelongsToProject` and `tabMatchesNotificationID` in both daemon and server so the cross-project `allowMissingProjectID=true` fallback only matches when the same terminal id really belongs to no project (rather than a different project).
3. **Frontend guardrail**: in `App.tsx:envelopeHandlerRef` (line 91), if (a) above is chosen, drop alerts whose `project_id` / `host_project_id` is not in the current view's project set. Even with a server fix this is cheap defense in depth.
4. **Feature add: OS / browser notifications** — none exist today. To add Electron desktop notifications, extend `electron/main.cjs` (`ipcMain.handle("notify:show", ...)`) and `preload.cjs`, then trigger from `App.tsx:envelopeHandlerRef` after the workspace filter passes, calling `new Notification(title, {body})` for browser fallback. For native OS notifications from the daemon, none are used today — would need to add `notify-send`/`osascript` calls in `maybeSendAgentCompletionAlert` / `terminalHookAlert`, gated by a config flag.

---

## Start here

`internal/server/hub.go` lines **2134–2143** (the broadcast case) and **2814–2824** (`broadcastToUser`). Then `internal/daemon/daemon.go` lines **3812–3842** (`agentNotificationTarget` / `terminalNotificationTarget` + the `orderedProjectStateIDs` walk) to see how `HostProjectID` gets remapped. Finally `studio-frontend/src/App.tsx` lines **86–110** and **212–240** for the frontend side.
