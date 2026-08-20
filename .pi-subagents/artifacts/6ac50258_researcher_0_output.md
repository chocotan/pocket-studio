# Research: Terminal inline image display for a web-based (xterm.js) terminal hosting pi

## Summary
pi (`@mariozechner/pi-coding-agent`) renders images inline in its TUI by emitting **Kitty graphics protocol (APC `_G`)** or **iTerm2 inline images (OSC 1337)** sequences, chosen purely by **environment-variable sniffing** (`KITTY_WINDOW_ID`, `TERM_PROGRAM`, `ITERM_SESSION_ID`, `WEZTERM_PANE`, etc.) — no terminal queries for protocol detection. A web terminal can therefore force iTerm2 output by spawning the shell with `TERM_PROGRAM=iTerm.app` + `ITERM_SESSION_ID=...`, and render it with `@xterm/addon-image` (supports Sixel beta, iTerm2 IIP alpha, and — since ~Feb 2026 — partial Kitty). The most practical path for xterm.js today is **iTerm2 IIP** (single self-contained base64 OSC sequence, no stateful IDs), with Kitty as a newer, still-partial option.

## Findings

### 1. Pi's image display (`packages/tui/src/terminal-image.ts`, pi-mono)

1. **Protocols emitted: Kitty + iTerm2 only (no Sixel).** `ImageProtocol = "kitty" | "iterm2" | null`. Kitty encoder emits `\x1b_Ga=T,f=100,q=2,c=<cols>,r=<rows>,i=<id>;<base64>\x1b\\` (f=100 = PNG), chunked at **4096 bytes** per APC chunk using `m=1` / final `m=0`. iTerm2 encoder emits a **single** `\x1b]1337;File=inline=1;size=<bytes>;width=<cells>;height=auto;name=<b64>:<base64>\x07` sequence. [terminal-image.ts](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/terminal-image.ts)

2. **Detection is 100% env-var based** (`detectCapabilities()`), in this priority order:
   - `TMUX` set or `TERM` starts with `tmux` → `images: null` (images explicitly disabled under tmux; known issue earendil-works/pi#2374 — pi emits raw Kitty APC that tmux filters without DCS passthrough)
   - `TERM` starts with `screen` → `images: null`
   - `KITTY_WINDOW_ID` set or `TERM_PROGRAM=kitty` → kitty
   - `TERM_PROGRAM=ghostty`, `TERM` contains `ghostty`, or `GHOSTTY_RESOURCES_DIR` → kitty
   - `WEZTERM_PANE` set or `TERM_PROGRAM=wezterm` → kitty
   - `TERM_PROGRAM=WarpTerminal` / `WARP_SESSION_ID` / `WARP_TERMINAL_SESSION_UUID` → kitty
   - `ITERM_SESSION_ID` set or `TERM_PROGRAM=iTerm.app` → **iterm2**
   - `WT_SESSION`, `TERM_PROGRAM=vscode`, `TERM_PROGRAM=alacritty`, JetBrains, unknown → `images: null`
   No DA/XTGETTCAP/Kitty-query roundtrips are used for image capability. [terminal-image.ts](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/terminal-image.ts)

3. **Cell-dimension query:** pi *does* query the terminal at startup for cell pixel size ("Aspect ratio is preserved by querying terminal cell dimensions on startup", release notes) to compute `c=`/`r=`/width; default fallback is 9×18 px. The terminal must answer the cell/window-size report (xterm.js `enableSizeReports` in addon-image, or core CSI 14/16 t handling) for correct aspect ratio. [v0.21.0 release](https://github.com/badlogic/pi-mono/releases/tag/v0.21.0)

4. **Config settings** (`~/.pi/agent/settings.json` or project settings):
   - `terminal.showImages` (boolean, default `true`) — master toggle, also `/show-images` slash command
   - `terminal.imageWidthCells` (number, default `60`) — preferred inline image width in cells
   - `images.autoResize` (boolean, default `true`) — downscales to max 2000×2000 before emitting
   [settings docs](https://pi.dev/docs/latest/settings), [settings-manager.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/settings-manager.ts)

5. **Feature landed in v0.21.0** via PR badlogic/pi-mono#177 (by @nicobailon). Fallback when unsupported/disabled: `[Image: [image/png] 1024x768]` text placeholder. [PR #177](https://github.com/badlogic/pi-mono/pull/177), [newreleases.io 0.21.0](https://newreleases.io/project/npm/@mariozechner/pi-coding-agent/release/0.21.0)

### 2. The protocols (concise)

6. **iTerm2 inline images (OSC 1337):** `ESC ] 1337 ; File=inline=1;size=N;width=..;height=..;name=b64 : <base64> BEL` (ST also accepted). One self-contained sequence; supports png/jpeg/gif; `MultipartFile` chunked variant exists for tmux. Simplest stateless protocol; easiest to implement and proxy. [iTerm2 docs](https://iterm2.com/documentation-images.html), [ansicode OSC 1337](https://ansicode.eversources.app/en/sequence/osc-iterm-image)

7. **Kitty graphics protocol:** `ESC _ G <key=val,...> ; <base64 payload> ESC \` (APC). Supports direct (`t=d`), file (`t=f`), temp-file (`t=t`), shared-mem (`t=s`) transmission; chunked streaming via `m=1/0`; image IDs, placements, deletion, z-index, animation. Most powerful, most stateful. [Kitty spec](https://sw.kovidgoyal.net/kitty/graphics-protocol/)

8. **Sixel:** DEC-era bitmap format (`DCS ... q`), palette-based, 6-pixel-tall bands. Widest historical support (foot, mlterm, xterm with `--sixel`, Windows Terminal), but palette limits, no true color without palette tricks, and bulky. Practical only if you need maximum terminal coverage; irrelevant for pi which never emits it. [Wave PR #2940](https://github.com/wavetermdev/waveterm/pull/2940) (enables sixel in Wave via addon-image)

   **Practicality ranking for a web terminal: iTerm2 IIP > Kitty > Sixel.**

### 3. xterm.js image support

9. **`@xterm/addon-image`** (current npm version **0.9.0**, MIT license, part of the xtermjs/xterm.js monorepo): supports **Sixel (beta quality)**, **iTerm2 IIP (alpha)**, and **partial Kitty TGP** (merged Feb 2026, PR #5619 "Support Kitty graphics protocol mvp", closed issue #5592). Constructor options: `sixelSupport` (default true), `iipSupport` (true), `kittySupport` (true on master), `pixelLimit` 16777216 (4096²), `iipSizeLimit` / `kittySizeLimit` / `sixelSizeLimit` (~20–25 MB per sequence), `storageLimit` 128 MB FIFO, `enableSizeReports` (answers CSI t cell/window size reports — needed by pi for aspect ratio). [addon-image README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-image), [npm](https://www.npmjs.com/package/@xterm/addon-image), [PR #5619](https://github.com/xtermjs/xterm.js/commit/3a9bfa94bc41fb3f53b8926392d9cab854cab867)

10. **Kitty support is partial:** only `t=d` (direct payload) transmission works; `t=f/t=t/t=s` return "unsupported transmission medium" (issue #5714). Since pi always sends PNG inline with `a=T,f=100` chunked at 4 KB (i.e., `t=d` default + `m=` chunking), pi's Kitty output is within the addon's supported subset — but the Kitty path in the addon is very new (weeks old) and should be treated as experimental. [issue #5714](https://github.com/xtermjs/xterm.js/issues/5714), [Kitty discussion #5683](https://github.com/xtermjs/xterm.js/discussions/5683)

11. **Known limitations (upstream, inherited from jerch/xterm-addon-image):** images don't survive terminal serialization/reload; copying selection as HTML drops images; IIP chunking (`FilePart`) support incomplete (issue #5858); images are DOM/canvas overlays so they don't reflow with text on resize the way native terminals do. Bundle size not officially published — expect on the order of ~100 kB min for the addon (⚠️ unverified; check bundlephobia before shipping). [VS Code docs](https://code.visualstudio.com/docs/terminal/advanced), [issue #5858](https://github.com/xtermjs/xterm.js/issues/5858)

12. **Alternatives:** there is no maintained standalone Kitty-protocol addon for xterm.js outside the official addon-image (the original third-party source, `jerch/xterm-addon-image`, was upstreamed). sindresorhus's [`supports-terminal-graphics`](https://github.com/sindresorhus/supports-terminal-graphics) is a useful reference for env-based protocol detection (Node-side).

### 4. What env a web terminal should fake so pi emits images

13. **To get iTerm2 protocol (recommended):** spawn the shell/pty with
    - `TERM_PROGRAM=iTerm.app` (pi lowercases and compares to `iterm.app`) **and/or** `ITERM_SESSION_ID=w0t0p0:<random-hex>`
    - `COLORTERM=truecolor` (for trueColor)
    - `TERM=xterm-256color` (do **not** let `TERM` start with `tmux`/`screen`, and do **not** set `TMUX`, or pi disables images entirely)
    [terminal-image.ts detectCapabilities](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/terminal-image.ts)

14. **To get Kitty protocol instead:** set `KITTY_WINDOW_ID=1` (simplest; presence is enough) or `TERM_PROGRAM=kitty`. Also viable: `WEZTERM_PANE`, `GHOSTTY_RESOURCES_DIR`, `TERM_PROGRAM=ghostty|wezterm|WarpTerminal`. Only do this if your addon-image version includes Kitty support (≥ the Feb 2026 MVP; check that the published 0.9.0 actually ships it — master README documents it, npm 0.9.0 README still says "SIXEL and IIP" ⚠️).

15. **Ordering caution:** pi checks Kitty-family vars **before** iTerm2. If you set both `KITTY_WINDOW_ID` and `TERM_PROGRAM=iTerm.app`, pi picks Kitty. Set only the family you can render.

16. **Also answer the cell-size query:** pi sends a terminal cell/window pixel-size report request at startup (CSI 14 t / 16 t family). Either enable `enableSizeReports: true` in addon-image or make sure xterm.js core handles it; otherwise pi falls back to 9×18 px cells and aspect ratio may be slightly off.

### 5. Reference implementations & gotchas

17. **VS Code:** uses xterm.js + addon-image. Images off by default; enable with `terminal.integrated.enableImages`. Shipped with Sixel + IIP originally (PR microsoft/vscode#182442); Kitty enabled in Feb 2026 via PR #295701 ("Enable kitty graphics protocol, bump xterm.js"). Known VS Code-documented limitations: no serialization (reload loses images), HTML copy excludes images. [VS Code Terminal Advanced docs](https://code.visualstudio.com/docs/terminal/advanced), [PR #182442](https://github.com/microsoft/vscode/pull/182442), [commit f32f330](https://github.com/microsoft/vscode/commit/f32f3306fd3c291e444be7426229d485198d87d7)

18. **Wave terminal (waveterm):** xterm.js-based; added Sixel via `@xterm/addon-image` (`sixelSupport: true, enableSizeReports: true`) and propagates pixel winsize (`TIOCGWINSZ.ws_xpixel/ypixel`) to the PTY so image tools place correctly. [Wave PR #2940](https://github.com/wavetermdev/waveterm/pull/2940)

19. **Tabby:** depends on `@xterm/addon-image` (dependabot shows 0.7.0→0.9.0 bumps in tabby-terminal) — Sixel/IIP via the standard addon. Hyper has no native image support (stale community plugins only). [dependabot.ecosyste.ms](https://dependabot.ecosyste.ms/packages/npm/@xterm%2Faddon-image)

20. **Websocket/transport gotchas:**
    - **Base64 payloads are big:** a 2000×2000 PNG can be several MB → iTerm2 emits it as one multi-MB OSC sequence; Kitty splits into 4 KB APC chunks but the total is the same. Make sure your ws layer tolerates multi-MB messages (or streams/chunks them) — check server/client max frame and message size limits.
    - **Use binary ws frames, not JSON+base64 wrapping:** xterm.js maintainers warn that JSON/base64 mangling "will kill IO throughput"; prefer binary frames (or raw text) end-to-end. [xterm.js PR #4442 comment](https://github.com/xtermjs/xterm.js/pull/4442)
    - **Flow control:** a fast producer dumping megabytes of image data can make xterm.js sluggish or overflow transport buffers; `term.write()` is non-blocking and buffered — implement backpressure (pause pty reads until written drains). [xterm.js flowcontrol guide](http://xtermjs.org/docs/guides/flowcontrol/), [discussion #5098](https://github.com/xtermjs/xterm.js/discussions/5098)
    - **tmux:** if pi runs inside tmux it self-disables images; if your web terminal fronts a tmux session, images won't be emitted unless `TERM`/`TMUX` are masked — but other terminals' image passthrough under tmux requires DCS-passthrough wrapping, which xterm.js/addon-image does not do for you.

## Sources
- Kept: [pi-mono terminal-image.ts](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/tui/src/terminal-image.ts) — primary source: exact detection logic, encoders, chunk sizes
- Kept: [pi settings docs](https://pi.dev/docs/latest/settings) — `terminal.showImages`, `terminal.imageWidthCells`, `images.autoResize`
- Kept: [pi-mono v0.21.0 release](https://github.com/badlogic/pi-mono/releases/tag/v0.21.0) / [PR #177](https://github.com/badlogic/pi-mono/pull/177) — feature provenance, `/show-images`, cell-dim query
- Kept: [xterm.js addon-image README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-image) + [npm](https://www.npmjs.com/package/@xterm/addon-image) — protocol support, defaults, maturity labels
- Kept: [xterm.js Kitty MVP PR #5619](https://github.com/xtermjs/xterm.js/commit/3a9bfa94bc41fb3f53b8926392d9cab854cab867), [issue #5714](https://github.com/xtermjs/xterm.js/issues/5714), [discussion #5683](https://github.com/xtermjs/xterm.js/discussions/5683) — Kitty partial-support details
- Kept: [iTerm2 protocol docs](https://iterm2.com/documentation-images.html), [Kitty spec](https://sw.kovidgoyal.net/kitty/graphics-protocol/) — protocol references
- Kept: [VS Code Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced), [vscode PR #295701](https://github.com/microsoft/vscode/commit/f32f3306fd3c291e444be7426229d485198d87d7), [Wave PR #2940](https://github.com/wavetermdev/waveterm/pull/2940) — reference implementations
- Kept: [xterm.js flowcontrol guide](http://xtermjs.org/docs/guides/flowcontrol/), [PR #4442](https://github.com/xtermjs/xterm.js/pull/4442) — transport gotchas
- Kept: [pi tmux issue #2374](https://github.com/earendil-works/pi/issues/2374) — tmux image suppression
- Dropped: jerch/xterm-addon-image standalone repo — superseded by upstream @xterm/addon-image
- Dropped: ansicode/Otty OSC 1337 pages — redundant with official iTerm2 docs
- Dropped: newreleases.io — secondary aggregator, kept only for version confirmation

## Gaps
- **Whether npm `@xterm/addon-image@0.9.0` actually ships Kitty support** is uncertain: master README says "partially Kitty (TGP)", the 0.9.0 npm README still says only "SIXEL and IIP". Verify `kittySupport` exists in the published 0.9.0 typings before relying on it; otherwise build from master or pin a newer beta.
- **Exact escape sequence pi uses for the cell-dimension query** (CSI 14 t vs 16 t) was not confirmed from source (query lives in the TUI startup code, not terminal-image.ts). Low risk: enabling `enableSizeReports` covers the CSI t family.
- **Bundle size of addon-image** not officially published; measure with bundlephobia/webpack-bundle-analyzer.
- **Sixel emission by pi:** none — pi never emits Sixel, so sixel support is unnecessary if pi is the only image producer.