# Task for scout

Recon the pocket-studio repo at /home/choco/Downloads/remote-agent (Go daemon + Go server + React frontends using xterm.js). The goal is to understand what it takes to support inline terminal images (iTerm2 OSC 1337 protocol) end-to-end. Determine:

1. **xterm.js setup** in studio-frontend/src/components/studio/xterm-instance.tsx: how the Terminal is constructed, which addons are registered, xterm version in package.json, whether @xterm/addon-image is already a dependency. Note where an addon would be registered.

2. **Terminal output data path**: daemon (internal/daemon) reads PTY → websocket to server → server relays to web frontend → frontend writes to xterm. For each hop report: are frames text or binary? Is there JSON envelope wrapping? Any message size limits, chunking, base64, or escape-sequence sanitization that could corrupt a multi-MB OSC 1337 sequence (single very long line with base64)? Check websocket read/write limits in internal/server/hub.go and daemon code, and how the frontend receives terminal stream data (web-transport.ts or per-terminal ws).

3. **Env vars for spawned shells**: what env does the daemon set when spawning terminal shells (search internal/daemon for TERM=, TERM_PROGRAM, COLORTERM, os.Environ)? Would a CLI agent in this terminal believe it supports inline images? Where would we add TERM_PROGRAM / ITERM_SESSION_ID?

4. Anything else relevant: Electron main.cjs image-relevant config, existing image paste support (terminal-image-paste.ts — input side only?), flow control / backpressure handling.

Return exact file paths + line numbers + short snippets. Do not modify anything.

---
**Output:**
Write your findings to exactly this path: /home/choco/Downloads/remote-agent/.pi-subagents/artifacts/outputs/5b7fc443/context.md
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