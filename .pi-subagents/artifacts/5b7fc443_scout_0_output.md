# Code Context: Inline Terminal Images (iTerm2 OSC 1337) — End-to-End Feasibility

Repo: `/home/choco/Downloads/remote-agent` (Go daemon + Go server + React/Vite studio-frontend using xterm.js).

The data path is end-to-end binary and already preserves raw bytes from PTY to xterm.write(), so multi-MB OSC 1337 sequences with long base64 lines are *not* corrupted by framing. The blockers are: (a) `@xterm/addon-image` is not installed/registered, (b) tmux (the default terminal backend in this daemon) does not have `iterm2`/`tc` enabled in its `terminal-features`, so OSC 1337 will be filtered before reaching the PTY read, and (c) `ITERM_SESSION_ID` is not set in the spawned-shell env, so CLI agents have only `TERM_PROGRAM=PocketStudio` as a hint.

---

## 1. xterm.js setup

### Files Retrieved
1. `studio-frontend/package.json` (lines 1-100) — xterm version + addon deps
2. `studio-frontend/src/components/studio/xterm-instance.tsx` (lines 1-15, 680-740) — Terminal construction, addon registration, OSC handlers
3. `studio-frontend/node_modules/@xterm/xterm/package.json` (lines 1-10) — confirms installed xterm version
4. `studio-frontend/node_modules/@xterm/addon-fit/package.json` — confirms installed FitAddon version

### Key Code

`studio-frontend/package.json:64-66`:
```json
"@xterm/addon-fit": "^0.11.0",
"@xterm/xterm": "^6.0.0",
```

Installed (via node_modules check): `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`. **No `@xterm/addon-image` in `dependencies` or `devDependencies`** (line 56-60 and 63-99). Confirmed: `ls node_modules/@xterm/` shows only `addon-fit/` and `xterm/`.

`studio-frontend/src/components/studio/xterm-instance.tsx:1-2, 684-731`:
```ts
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
...
term = new XTerminal({
  cursorBlink:   true,
  cursorStyle:   "bar",
  fontSize:      BASE_FONT_SIZE * scaleRef.current,
  fontFamily:    "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
  lineHeight:    1.2,
  scrollback:    5000,
  scrollSensitivity: 1,
  scrollOnUserInput: true,
  allowProposedApi: true,    // <-- already enabled; required by @xterm/addon-image
  theme: { ... },
});
term.write('\x1b[?1007l');
...
fitAddon = new FitAddon();
fitAddonRef.current = fitAddon;
term.loadAddon(fitAddon);

osc52Disposable = term.parser.registerOscHandler(52, (data) => { ... });  // only OSC 52 (clipboard)
```

### Findings
- **xterm version is 6.0.0** (recent enough for `@xterm/addon-image` ≥ 0.7.x).
- **`allowProposedApi: true` is already set** (xterm-instance.tsx:693) — required by the image addon.
- **Only `FitAddon` is registered** (xterm-instance.tsx:726-728). This is the addon registration point.
- **No `ImageAddon`** is imported, instantiated, or registered. `grep -rn "addon-image" /home/choco/Downloads/remote-agent` returns zero hits outside of node_modules.
- **No `registerOscHandler(1337, ...)`** is registered. The image addon intercepts OSC 1337 itself; you do not need a custom OSC handler, but you must `loadAddon(new ImageAddon())`.
- **Existing OSC 52 handler** (xterm-instance.tsx:730) is for clipboard read; it does not interfere with OSC 1337.

### Where an Image Addon Would Be Registered
- Import at top of xterm-instance.tsx: `import { ImageAddon } from "@xterm/addon-image";` (next to FitAddon import on line 2).
- Construct and load immediately after the FitAddon registration (after xterm-instance.tsx:728):
  ```ts
  const imageAddon = new ImageAddon();
  term.loadAddon(imageAddon);
  ```
- Cleanup: addon disposes with the terminal in the existing `term.dispose()` (xterm-instance.tsx:1010), so no separate teardown is needed.

---

## 2. Terminal output data path (daemon PTY → server → web frontend)

### Files Retrieved
1. `internal/daemon/terminal_output_batch.go` (lines 1-80) — PTY batching
2. `internal/daemon/daemon.go` (lines 4219-4343) — startTerminalStream, sendTerminalStreamData
3. `internal/daemon/daemon.go` (lines 5658-5730) — writeTerminalStream (input side, for symmetry)
4. `internal/daemon/daemon.go` (lines 355-460) — daemon↔server WebSocket read loop
5. `internal/daemon/daemon.go` (lines 4255-4330) — terminalEnv, tmux config
6. `internal/protocol/protocol.go` (lines 415-470) — TerminalStreamData + binary marshal
7. `internal/server/hub.go` (lines 30-40, 830-920, 1728-1790, 2641-2680, 3870-4020) — server relay
8. `internal/daemon/direct_web.go` (lines 30-220, 565-625) — direct WS path
9. `studio-frontend/src/components/studio/xterm-instance.tsx` (lines 905-970) — frontend WS handlers
10. `studio-frontend/src/lib/api.ts` (lines 20-50) — websocketURL / directWebsocketURL

### Key Code (per hop)

**Hop 1 — PTY read (daemon)**: `internal/daemon/terminal_output_batch.go:9-80`
```go
const (
    terminalOutputBatchDelay = 8 * time.Millisecond
    terminalOutputMaxBatch   = 64 << 10   // 64 KiB hard cap per emit
    terminalOutputReadBuffer = 32 << 10   // 32 KiB Read syscall chunks
)
```
A single `streamTerminalOutput` goroutine reads from the PTY in 32 KiB blocks, then accumulates them in-memory for up to 8 ms OR up to 64 KiB total — whichever comes first — before calling `emit(batch)` once. Order is preserved (FIFO channel `chunks`, `batch = append(batch, chunk.data...)`). An OSC 1337 sequence longer than 64 KiB will be split across multiple `emit` calls; the bytes are forwarded in order. **This is the only buffering on the data path.**

**Hop 2 — Daemon → Server WebSocket**: `internal/daemon/daemon.go:4325-4343`
```go
func (d *Daemon) sendTerminalStreamData(data protocol.TerminalStreamData) {
    ...
    if terminalBinary && data.ClientID == "" {
        frame, err := protocol.MarshalTerminalStreamDataBinary(data)
        if err != nil { /* fall back to JSON envelope */ }
        select {
        case d.sendBinary <- frame:   // non-blocking; buffered cap 256 (daemon.go:163)
            d.broadcastDirectTerminalData(data)
            return
        default:
            // sendBinary full → fall back to JSON envelope
        }
    }
    d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamData, "daemon", data)
    d.broadcastDirectTerminalData(data)
}
```
- **Binary wire format** (`internal/protocol/protocol.go:415-447`): `[4B magic 'PSTD'][1B version=1][2B BE projectID len][2B BE terminalID len][projectID][terminalID][raw bytes...]`. **No JSON wrapping, no base64.**
- **Fallback path**: when `terminalBinary` feature is not negotiated OR `sendBinary` is full, daemon sends a JSON envelope with `Data: []byte` (Go json marshals `[]byte` as base64). Server transparently decodes this into the same `TerminalStreamData` struct. The `Data` field is then forwarded to the web client as **raw bytes** (see Hop 3).
- The `terminal.binary.v1` feature is advertised by the daemon in `daemon.hello` (`daemon.go:3103`: `Features: []string{protocol.FeatureTerminalBinaryV1, protocol.FeatureDirectTerminalV1}`) and the server sets `dc.terminalBinary` on hello (`internal/server/hub.go:1832`).

**Hop 3 — Server → Web client WebSocket**: `internal/server/hub.go:2641-2680`
```go
func (h *Hub) forwardTerminalStreamData(userID string, streamData protocol.TerminalStreamData) {
    key := terminalKey(userID, streamData.ProjectID, streamData.TerminalID)
    for _, wc := range h.terminalSubscribers(key) {
        if streamData.ClientID != "" && wc.clientID != streamData.ClientID {
            continue
        }
        if err := wc.writeMessage(websocket.BinaryMessage, streamData.Data); err != nil {
            h.removeTerminalSubscriber(key, wc)
            _ = wc.conn.Close()
        }
    }
}

func (wc *terminalConn) writeMessage(messageType int, data []byte) error {
    wc.mu.Lock()
    defer wc.mu.Unlock()
    _ = wc.conn.SetWriteDeadline(time.Now().Add(terminalRelayWriteTimeout))   // 2s
    err := wc.conn.WriteMessage(messageType, data)
    _ = wc.conn.SetWriteDeadline(time.Time{})
    return err
}
```
- The server writes `streamData.Data` (raw bytes) as `websocket.BinaryMessage` to the web client. **No JSON envelope, no base64, no sanitization, no chunking.** One call to `WriteMessage` per daemon `emit` (preserves the daemon's batch boundaries).
- Write deadline: `terminalRelayWriteTimeout = 2 * time.Second` (`internal/server/hub.go:35`). A multi-MB frame that takes >2 s to flush will drop the subscriber.
- The `binaryType` on the gorilla upgrader is whatever the default gorilla produces; the server's read loop for terminal subscribers (`internal/server/hub.go:3953`) only parses JSON control messages (`type: resize|exit|ping`) and forwards `payload` bytes (which include the OSC 1337) as `TerminalStreamData.Data`. So client→daemon direction also preserves raw bytes.

**Hop 4 — WebSocket upgrader limits**:
- `internal/server/hub.go:830-833`: `var upgrader = websocket.Upgrader{CheckOrigin: ...}` — **no `ReadBufferSize`, no `WriteBufferSize`, no `SetReadLimit` on the underlying `conn`**. The terminal WS in `ServeTerminalWebSocket` (`hub.go:3860-4020`) inherits this. Default gorilla `Upgrader` means no message-size cap on reads. Write deadline is the only enforced limit (2 s).
- Daemon's outbound WS to the server uses `websocket.DefaultDialer` (`internal/daemon/daemon.go:361`) with the same defaults — no size limits.
- Direct daemon WS (`internal/daemon/direct_web.go:34`): `var directWebUpgrader = websocket.Upgrader{CheckOrigin: ...}` — same defaults. Write deadline: `directTerminalWriteTimeout = 2 * time.Second` (`direct_web.go:36`, applied in `direct_web.go:605-612`).

**Hop 5 — Frontend receive**: `studio-frontend/src/components/studio/xterm-instance.tsx:937-960`
```ts
socket.binaryType = "arraybuffer";
...
socket.onmessage = (event) => {
  if (!isCurrentEffect() || ...) return;
  if (event.data instanceof ArrayBuffer) {
    writeTerminalData(new Uint8Array(event.data));   // raw bytes → xterm
  } else if (typeof event.data === "string") {
    try {
      const message = JSON.parse(event.data) as { type?: string; ... };
      if (message.type === "title" && typeof message.title === "string") { ... return; }
      if (message.type === "exit") { ... return; }
    } catch {
      // Plain terminal text
    }
    writeTerminalData(event.data);
  }
};
```
And `writeTerminalData` (xterm-instance.tsx:480-487) buffers only if `terminalReadyRef.current` is false, then `term.write(data)` is called. xterm.js's parser buffers incomplete escape sequences until terminator (BEL `\a` or ST `ESC \`) arrives, so a split across two websocket frames is fine.

**studio-frontend/src/components/studio/web-transport.ts** is the **`/ws/web` envelope channel** for non-terminal messages (agent chat, tasks, etc.). It is **not** on the terminal stream path; do not confuse the two. The per-terminal WS is `XtermInstance` directly (xterm-instance.tsx:831-837: `websocketURL("/ws/terminal", wsParams)` or `directWebsocketURL(...)`).

### Findings (data path)
- **Wire format is binary end-to-end**: PTY bytes → gorilla `BinaryMessage` over WS. No JSON envelope on the wire for terminal data when `terminal.binary.v1` is negotiated (which is the default for any modern daemon). The fallback JSON path is only used if the daemon feature is missing or the binary channel is saturated; both paths deliver the same raw bytes.
- **No base64, no escape sanitization, no chunking on the relay**. The 32 KiB PTY read + 64 KiB batch cap + 8 ms delay on the daemon side are the only aggregation points. As long as the parser is told each batch in order, OSC 1337 sequences work.
- **Order is preserved** at every hop. No frame coalescing, no out-of-order merging. The `sendBinary` non-blocking send in `daemon.go:4328-4332` can drop the binary path and fall back to the JSON path when saturated; in both cases order is preserved.
- **Risk: write deadline of 2 s** in both `terminalRelayWriteTimeout` and `directTerminalWriteTimeout`. A multi-MB OSC 1337 frame (e.g. a 2 MB image → ~2.7 MB of base64) can easily exceed 2 s on a slow link. The subscriber is then dropped (`hub.go:2648-2649`, `direct_web.go:575-579`). The frontend's `socket.onclose` then reconnects (`xterm-instance.tsx:975-988`).
- **No read limit** on any WS (gorilla default). The browser may pre-buffer multi-MB `ArrayBuffer`s; in practice fine for chrome/electron.
- **Vite dev proxy** (`studio-frontend/vite.config.ts:21-30`) proxies `/ws/terminal` to the backend, so dev mode mirrors prod.

---

## 3. Env vars for spawned shells

### Files Retrieved
1. `internal/daemon/daemon.go` (lines 4758-4810) — `terminalEnv()` and `taskEnv()`
2. `internal/daemon/daemon.go` (lines 4700-4751) — `pocketStudioTmuxConfig()`
3. `internal/daemon/daemon.go` (lines 4219-4280) — `startTerminalStream()` and how env is passed
4. `internal/daemon/daemon.go` (lines 3030-3045) — `runTerminalCommand` (one-shot path)
5. `internal/daemon/daemon.go` (lines 4900-4920) — `agentHooks.env` (Claude Code hooks)

### Key Code

`internal/daemon/daemon.go:4758-4802`:
```go
func terminalEnv(extra ...string) []string {
    shell := userShell()
    env := make([]string, 0, len(os.Environ())+8+len(extra))
    pathValue := ""
    extraKeys := make(map[string]struct{}, len(extra))
    for _, item := range extra {
        key, _, ok := strings.Cut(item, "=")
        if ok && key != "" {
            extraKeys[key] = struct{}{}
        }
    }
    for _, item := range os.Environ() {
        key, _, ok := strings.Cut(item, "=")
        if !ok { env = append(env, item); continue }
        if key == "PATH" {
            pathValue = strings.TrimPrefix(item, "PATH=")
            continue
        }
        switch key {
        case "NO_COLOR", "TERM", "COLORTERM", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "SHELL":
            continue
        default:
            if _, overridden := extraKeys[key]; overridden { continue }
            env = append(env, item)
        }
    }
    if pathValue == "" { pathValue = os.Getenv("PATH") }
    env = append(env,
        "PATH="+pathValue,
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
        "TERM_PROGRAM=PocketStudio",       // <-- already set
        "CLICOLOR=1",
        "CLICOLOR_FORCE=1",
        "FORCE_COLOR=1",
        "SHELL="+shell,
    )
    return append(env, extra...)
}
```

Called from:
- `daemon.go:4247`: `cmd.Env = tmuxProcessEnv(agentHooks.env...)` (tmux path)
- `daemon.go:4261`: `cmd.Env = terminalEnv(agentHooks.env...)` (fallback direct shell)
- `daemon.go:3036`: `cmd.Env = taskEnv()` (one-shot `terminal/run`)

### Findings
- **`TERM_PROGRAM=PocketStudio` is already set.** A CLI agent (e.g. Claude Code, openclaw) checking for `TERM_PROGRAM == iTerm.app` will *not* enable inline images, but agents that just check for "known terminal programs" or "this is a TTY that might support images" may react. Most agents (e.g. `chafa --version` auto-detect) probe via `stty rows/cols` + `tput colors` + `echo $TERM`, and *some* look at `TERM_PROGRAM`/`COLORTERM`/`TERM=xterm-256color` to decide whether to render images. **`PocketStudio` is not a recognized value**, so most agents will fall through to "unknown terminal, skip images" or, worse, render images and have the user see garbage.
- **`ITERM_SESSION_ID` is NOT set anywhere** (`grep -rn ITERM_SESSION_ID internal/` returns no matches). Most iTerm2-aware agents also check for this. Adding a unique per-`terminalID` value (e.g. `ITERM_SESSION_ID=pocket-studio-<terminalID>`) is the simplest cross-agent compatibility move.
- **To add `ITERM_SESSION_ID`**: extend the `env = append(env, ...)` literal in `terminalEnv()` (around `daemon.go:4793-4799`). Use a stable per-`terminalID` value; `extra` only carries `POCKET_STUDIO_TERMINAL_ID` today, so you can either generate a UUID per call or pull it from `extra`.
- **`COLORTERM=truecolor` is already set.** Good — most iTerm2-aware agents use this as a positive signal for "supports true color".
- **tmux: passthrough of OSC 1337 depends on `terminal-features`**. The current daemon tmux config (`daemon.go:4724-4726`):
  ```tmux
  set-option -g terminal-overrides ",xterm-256color:RGB,tmux-256color:RGB,*-256color:RGB"
  set-option -ga terminal-features ",xterm-256color:RGB:clipboard,tmux-256color:RGB:clipboard,*-256color:RGB:clipboard"
  ```
  has RGB + clipboard but **no `iterm2` / `tc` (true color image) feature**. Tmux will filter OSC 1337 in this configuration (it only passes OSC sequences that the advertised terminfo explicitly supports). To support inline images under tmux, change to e.g.:
  ```tmux
  set-option -ga terminal-features ",xterm-256color:RGB:clipboard:iterm2,tmux-256color:RGB:clipboard:iterm2,*-256color:RGB:clipboard:iterm2"
  ```
  This needs verification on the actual tmux version the daemon ends up running.
- **Direct (non-tmux) fallback path** (`daemon.go:4259-4263`) does not go through tmux, so the OSC 1337 would be preserved if you set `ITERM_SESSION_ID`. But the daemon prefers tmux when it can (`daemon.go:4240-4243`).

---

## 4. Other relevant findings

### Electron main.cjs
- `studio-frontend/electron/main.cjs` has **no image-specific config**. The only clipboard handlers are text-only:
  - `clipboard:write-text` (line 285-290): `clipboard.writeText(text)`
  - `clipboard:paste` (line 292-298): `window.webContents.paste()` (delegates to Chromium's built-in paste, which handles images by default — see frontend's `pasteFromClipboardFallback` in xterm-instance.tsx)
- BrowserWindow config (line 444-457): no `webSecurity`, no `backgroundThrottling`, no `webgl` flags relevant to xterm.
- No mention of `enableBlinkFeatures`, no `sandbox: false`, no custom CSP that would block `data:` URLs or `blob:` URLs (which `@xterm/addon-image` may use to render images). xterm's image addon creates an internal canvas; it should work in Electron's default renderer.
- `appEnvironment` (`main.cjs:79`) is the env passed to the daemon child process; it does not inject `ITERM_SESSION_ID` or `TERM_PROGRAM` for the daemon itself (the daemon's `terminalEnv()` overwrites these on the spawned shell side).

### Existing image paste support (input side)
- `studio-frontend/src/components/studio/terminal-image-paste.ts` (whole file, 6 lines):
  ```ts
  export function terminalImagePasteText(command: string, path: string) {
    const normalizedCommand = command.toLowerCase();
    if (normalizedCommand.includes("claude") || normalizedCommand.includes("agy") || normalizedCommand.includes("kilo")) {
      return `/image ${path}`;
    }
    return path;
  }
  ```
  **This is input-side only** — it just produces the slash-command text that the user pastes. It has nothing to do with output rendering.
- The full paste-image flow lives in `xterm-instance.tsx`:
  - `xterm-instance.tsx:810-844` (`pasteFromClipboardFallback`): reads image from `navigator.clipboard.read()`, builds a `File`, base64-encodes via `FileReader.readAsDataURL`, posts to `POST /api/project/file/write` with `temporary: true`.
  - `xterm-instance.tsx:851-880` (the `paste` event handler): same flow but reads from `event.clipboardData.items`.
  - On success, calls `term.paste(getPasteTextForPath(result.path))` which invokes `terminalImagePasteText` to produce the `/image <path>` text.
- The output side has **no support for inline image rendering today**. xterm.js ignores OSC 1337 by default (it just logs an `[Unsupported]` line to the parser). Adding `@xterm/addon-image` is the only change required for the output side.
- The Electron `clipboard:paste` handler (`main.cjs:292-298`) just calls `webContents.paste()` which fires a synthetic `paste` event in the renderer — the renderer's handler in xterm-instance.tsx then runs the same flow.

### Flow control / backpressure
- **Daemon side**: `sendBinary` channel cap 256 (`daemon.go:163`). `sendTerminalStreamData` does a **non-blocking** send (`daemon.go:4328-4332` with `default` clause); on full, it falls back to the JSON envelope path (slower, base64). 256 × 64 KiB = 16 MiB of in-flight headroom. The JSON fallback channel `send` has cap 64 (also `daemon.go:163`).
- **Server side**: per-`terminalConn` `wc.mu` is held during `WriteMessage` (`hub.go:2664-2671`). Writes are not queued — if the web client is slow and the 2 s deadline elapses, the subscriber is dropped and the front-end reconnects. **No per-conn buffer.**
- **Frontend side**: `term.write(uint8Array)` is synchronous in xterm.js. A multi-MB write will block the main thread for the duration of the parse + draw. The xterm parser already handles incomplete escape sequences across `write()` calls, so chunking from upstream is benign.

### Other things worth noting
- `term.write('\x1b[?1007l')` is sent right after construction (xterm-instance.tsx:701). This disables the alternate-scroll mode; not related to images but worth noting.
- The xterm `term.buffer.active` is used elsewhere; not relevant to image addon.
- The ImageAddon may want the `WebGLAddon` for performance, but the default canvas renderer works.
- The `FontFace` usage (`xterm-instance.tsx:973-978`) waits for `document.fonts.ready` before fitting. This is unrelated but can cause a brief render delay right after open.
- `webContents.paste()` (Electron, main.cjs:297) is the supported way for an OS-level paste; in dev (non-Electron) the fallback path is used.

---

## Architecture (TL;DR)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ BROWSER (Electron renderer / dev browser)                                  │
│  XtermInstance (xterm-instance.tsx)                                         │
│   • new XTerminal({ allowProposedApi: true })  [line 684]                   │
│   • new FitAddon() + loadAddon(fitAddon)         [line 726-728]            │
│   • registerOscHandler(52, ...)  [OSC 52 clipboard] [line 730]              │
│   • socket.binaryType = "arraybuffer"             [line 937]               │
│   • onmessage → term.write(uint8Array/string)     [line 947-960]           │
│                                                                            │
│  NEEDS:  import { ImageAddon } from "@xterm/addon-image"                   │
│          new ImageAddon() + term.loadAddon(imageAddon)  [after line 728]   │
└────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │  WebSocket:  /ws/terminal   (gorilla BinaryMessage)
                                    │  Or direct daemon WS: terminal_ws_url
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ SERVER (internal/server/hub.go)                                             │
│  upgrader = websocket.Upgrader{CheckOrigin:...}  [line 830]  NO read limit │
│  ServeTerminalWebSocket [line 3860-4020]                                    │
│  forwardTerminalStreamData [line 2641] →                                   │
│   wc.writeMessage(websocket.BinaryMessage, streamData.Data)                 │
│  write deadline: terminalRelayWriteTimeout = 2s  [line 35]                 │
│  Binary input: UnmarshalTerminalStreamDataBinary (server) [hub.go:1771]     │
└────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │  Daemon↔Server WebSocket:  /ws/daemon
                                    │  Binary 'PSTD' frame: [magic|ver|projID|termID|data]
                                    │  Fallback: JSON envelope with base64 []byte
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ DAEMON (internal/daemon)                                                    │
│  streamTerminalOutput (terminal_output_batch.go)                            │
│   • 32 KiB Read, 8 ms batch, 64 KiB max per emit                            │
│  sendTerminalStreamData (daemon.go:4325)                                    │
│   • If terminal.binary.v1 negotiated → sendBinary channel                   │
│   • Else → JSON envelope (base64 []byte)                                    │
│  startTerminalStream (daemon.go:4219)                                       │
│   • PTY start: tmux > user shell fallback                                   │
│   • tmux config (pocketStudioTmuxConfig, daemon.go:4711)                    │
│     - set-option terminal-overrides …:RGB                                   │
│     - set-option terminal-features …:RGB:clipboard                          │
│     - NO iterm2/tc feature → OSC 1337 will be filtered under tmux           │
│   • terminalEnv (daemon.go:4758):                                           │
│     TERM=xterm-256color, COLORTERM=truecolor, TERM_PROGRAM=PocketStudio,    │
│     CLICOLOR=1, CLICOLOR_FORCE=1, FORCE_COLOR=1, SHELL=<user shell>         │
│     → ADD:  ITERM_SESSION_ID=pocket-studio-<terminalID>                     │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Start Here

1. **`studio-frontend/package.json`** — add `"@xterm/addon-image": "^0.7.0"` to devDependencies (alongside addon-fit at line 64).
2. **`studio-frontend/src/components/studio/xterm-instance.tsx`** — import `ImageAddon` (line 2), construct + `term.loadAddon(new ImageAddon())` after line 728.
3. **`internal/daemon/daemon.go`** (the `pocketStudioTmuxConfig` function at line 4711-4751) — add `iterm2` (and/or `tc`) to the `terminal-features` line at 4726 so tmux actually passes OSC 1337 through to xterm. Without this, the change in step 2 will not produce any visible image even though the addon is loaded.
4. **`internal/daemon/daemon.go`** (`terminalEnv` at line 4758) — add a stable `ITERM_SESSION_ID=pocket-studio-<terminalID>` so CLI agents that key on it will render images.

After those four edits, end-to-end support is in place; no changes to `internal/server/hub.go` or `internal/protocol/protocol.go` are required because the data path is already byte-preserving.

---

## Open questions / risks
- **tmux version compatibility for `iterm2` feature**: tmux 2.2+ understands `terminal-features`. The daemon's `tmuxCommand` (`daemon.go:4690`) invokes whatever tmux is on `$PATH`. Most distros ship tmux 3.x.
- **2-second write deadline** (`hub.go:35`, `direct_web.go:36`) may drop the connection mid-frame for very large images. Could be raised to e.g. 10 s if a real agent emits >1 MB OSC 1337 frames.
- **Long base64 line length in OSC 1337**: the parser buffer is xterm's responsibility; no project-side concern, but worth verifying the `@xterm/addon-image` version's parser handles a single multi-MB payload.
- **`TERM_PROGRAM=PocketStudio` is unrecognized** by most agents. Even with `ITERM_SESSION_ID` set, some agents gate on `TERM_PROGRAM in known_set` first. Consider also writing a `POCKET_STUDIO_INLINE_IMAGES=1` env var and documenting it for agent maintainers.
- **WebGL vs canvas renderer**: xterm's image addon creates an internal canvas; works with the default canvas renderer. If `WebGLAddon` is added later, verify image addon compatibility.