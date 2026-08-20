# Task for scout

侦察本地仓库 /home/choco/Downloads/remote-agent (Pocket Studio: Go 编写的 Server + Daemon, React 前端 studio-frontend)。它是远程 AI 编程工作台,通过 Daemon 在开发机上管理项目目录、终端会话和 AI Agent 进程。

目标:搞清楚"新增一个外部 CLI Agent(如 DeepSeek dsh)"需要动哪些地方。已知它已支持 Claude Code, Codex, OpenCode, Kilo, Pi, antigravity, 以及 Direct ACP (stdin/stdout JSON-RPC)。请回答:

1. Agent 集成点清单: 在哪里注册/枚举可用的 Agent 执行体?(cmd/daemon、internal/ 下找 agent 相关目录)列出需要改动的具体文件路径。
2. Direct ACP 实现: internal 中 ACP 客户端实现在哪个文件?支持哪些 ACP agent(codex/opencode/kilo?),新增一个 ACP agent 的注册方式是什么(命令行模板?)?ACP 会话的生命周期管理(chat、工具调用渲染、取消、resume)在哪?
3. 终端模式 Agent: 走终端PTY跑的 CLI agent(如 claude code)如何配置启动命令?在哪检测 agent 类型?
4. Hook/通知: 终端 AI Hook(检测 tool call / 任务完成 → 通知 UI)在哪实现?对未知新 agent 的兜底行为是什么?
5. 前端: studio-frontend 中 Agent 类型/图标的映射在哪?新增 agent 需要改前端吗?
6. 协议: internal/protocol 中与 agent 相关的消息 envelope 有哪些关键类型?

返回压缩结论 + 关键文件路径清单(精确到文件),不要贴大段代码。

---
**Output:**
Write your findings to exactly this path: /home/choco/Downloads/remote-agent/.pi-subagents/artifacts/outputs/d6608e26/context.md
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