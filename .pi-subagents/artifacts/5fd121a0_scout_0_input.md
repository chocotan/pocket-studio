# Task for scout

侦察 DeepSeek Harness (dsh) 仓库,位于 /tmp/pi-github-repos/deepseek-ai/deepseek-harness (TypeScript/pnpm monorepo, 基于 Cordis 插件架构)。

目标:搞清楚如何把它作为"Agent 执行体"集成进一个外部的远程工作台产品(类似人们集成 Claude Code / Codex CLI 那样)。请回答:

1. CLI 入口与启动方式: dsh 命令有哪些子命令/参数 (查 package.json bin、apps/、packages/ 中的 CLI 定义)?有没有 TUI 模式、headless/非交互模式、print/exec 模式(类似 claude -p)?工作目录、模型、系统提示如何指定?支持 session resume 吗?
2. ACP 支持: 仓库中有 acp-agent-client-protocol 相关文档 (.agents/notes/archived/feature/2026-06-14-acp-agent-client-protocol.md 等)。确认 dsh 是 ACP 客户端还是 ACP 服务端(agent),还是两者?具体命令是什么(比如 dsh acp 之类)?stdin/stdout JSON-RPC 吗?找到实现代码位置。
3. 模型/Provider 配置: 如何配置 DeepSeek API / 兼容 OpenAI 的 provider?API key 环境变量?支持哪些模型?
4. Web 模式: dsh web 起的 Web UI 是什么架构(端口、是否能远程访问、是否有多会话)?
5. 插件/扩展机制: 基于 Cordis,外部如何写插件?有没有 hook/事件可以监听 agent 完成任务(类似 Claude Code hooks)?
6. 稳定性: 版本号、发布节奏、是否 npm 可安装(@deepseek-ai/dsh)、文档中提到的兼容性风险。

重点看: package.json, apps/, packages/ 的目录名与 README, docs/architecture.md, docs/development.md, docs/user/guide/, .agents/notes/ 中 acp 相关文档, AGENTS.md。返回压缩后的结论 + 关键文件路径 + 关键命令行示例。

---
**Output:**
Write your findings to exactly this path: /home/choco/Downloads/remote-agent/.pi-subagents/artifacts/outputs/5fd121a0/context.md
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