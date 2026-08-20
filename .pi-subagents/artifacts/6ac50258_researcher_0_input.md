# Task for researcher

Research how terminal inline image display works, focused on implementing it in a web-based terminal (xterm.js). Deliver a structured brief covering:

1. **Pi coding agent's image display**: pi (pi-coding-agent by badlogic) supports `terminal.showImages` and renders images inline in terminals. Which protocols does it emit (Kitty graphics protocol, iTerm2 inline images/OSC 1337)? How does it detect terminal support (env vars like TERM_PROGRAM, KITTY_WINDOW_ID, WEZTERM_EXECUTABLE, ITERM_SESSION_ID, or terminal queries)? Any config settings (terminal.showImages etc.)?

2. **The protocols themselves** (concise): iTerm2 inline image protocol (OSC 1337;File=...base64), Kitty graphics protocol (APC G ...), Sixel. Which are most practical to support?

3. **xterm.js image support**: status of @xterm/addon-image — which protocols it supports (sixel? iTerm2 IIP? Kitty?), maturity, known limitations, bundle size, license. Are there alternative libs for Kitty protocol over xterm.js?

4. **How pi/agents decide to emit images**: what environment a shell needs to advertise (TERM, TERM_PROGRAM, etc.) so that CLI agents like pi will emit iTerm2/Kitty sequences. If a web terminal wants pi to emit iTerm2 protocol, what env should it fake (e.g., TERM_PROGRAM=iTerm.app)?

5. **Reference implementations**: how do web-based terminals handle images — e.g., does VS Code's xterm.js support images, how do Tabby/Hyper/Wave terminal handle iTerm2/Kitty/sixel, any gotchas (large base64 payloads over websocket, chunking, binary vs text frames)?

Return a compressed brief with concrete facts, library names/versions, and links. Flag anything uncertain.

---
**Output:**
Write your findings to exactly this path: /home/choco/Downloads/remote-agent/.pi-subagents/artifacts/outputs/6ac50258/research.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```