# Task for scout

Recon the remote-agent codebase at /home/choco/Downloads/remote-agent. I need to add new 'skill.*' request/response messages handled by the daemon and routed through two channels: (1) server hub envelope relay (internal/server/hub.go + internal/daemon/daemon.go), (2) daemon direct web websocket (internal/daemon/direct_web.go).\nReport concisely:\n1. How an existing CRUD-style request flows from Studio UI -> server hub -> daemon -> back to requesting client ONLY (not broadcast). Pick the workspace management or project CRUD message as the template. Exact function names, message type constants, envelope structure (internal/protocol/protocol.go Envelope type), request_id correlation pattern.\n2. How the same request flows through direct_web.go (daemon direct websocket): message parsing, dispatch switch, response envelope, auth token check.\n3. Where DaemonHello.Features is populated and how frontend gates UI on features.\n4. How frontend sends such requests: find the WS client helper in studio-frontend/src that sends envelope messages and awaits responses by request_id (probably in App.tsx or a lib). Exact file/function.\n5. The atomic file write helper in internal/daemon/atomic_file.go - signature and usage.\n6. How startTerminalStream receives TerminalStreamStart and where req.Command is built for tmux (exact lines around daemon.go:4264-4300).\n7. Any existing frontend 'settings'-like panel/page component that could host a new Skill Library UI tab - where settings UI lives (component file names).\nReturn: file paths + line numbers + short code excerpts for each. No speculation.

---
**Output:**
Write your findings to exactly this path: /home/choco/Downloads/remote-agent/.pi-subagents/artifacts/outputs/e69f3c33/context.md
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