# Task for frontend-worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement the Pocket Studio Skill & Custom Agent manager UI in /home/choco/Downloads/remote-agent/studio-frontend.\nREAD FIRST: docs/skill-profiles-plan.md (same repo) for the feature design; studio-frontend/src/components/studio/studio-settings.tsx + studio-dashboard.tsx for dialog/tab conventions; studio-frontend/src/lib/api.ts (postJSON/getJSON helpers, apiURL); src/components.json (shadcn components available under src/components/ui).\nBACKEND API (already implemented, all POST unless noted, all need query param ?device_id=<id>, body is JSON, response is the daemon result object; treat non-empty .error field as failure):\n- /api/skill/catalog -> { skills: [{name, description, path, source: 'store'|'shared-global', managed, writable, revision, valid, issue}] }\n- /api/skill/create -> { name, description, location: 'store'|'shared' } -> { skill }\n- /api/skill/store/install -> { source: 'git'|'local', ref: '<git url or local path>', name? } -> { skill }\n- /api/skill/store/remove -> { name } -> { removed }\n- /api/skill/store/upgrade -> { name, force? } -> { skill }\n- /api/skill/file/tree -> { name } -> { root, entries: [{name, path, is_dir, size, modified}] }\n- /api/skill/file/read -> { name, path } -> { content, revision, binary, size } (error means missing)\n- /api/skill/file/write -> { name, path, content, expected_revision } -> { revision } or { conflict: true, error }\n- /api/skill/file/create -> { name, path, is_dir } / rename -> { name, path, new_path } / delete -> { name, path }\n- /api/agent/list -> { agents: CustomAgent[] }\n- /api/agent/save -> { agent: CustomAgent } -> { agent }\n- /api/agent/delete -> { agent_id } -> { deleted }\nCustomAgent = { id, name, description, base_agent: 'pi'|'kimi'|'opencode'|'claude'|'codex'|'kilo', system_prompt, skills: [{name, path}], extra_env?, extra_args? }\nDELIVERABLES:\n1. New file src/components/studio/skill-agent-manager.tsx exporting SkillAgentManagerContent({ deviceId }: { deviceId: string }). Three tabs inside: 「技能库」「自定义 Agent」「技能编辑」.\n   - 技能库 tab: catalog list w/ search; source badge (受管=store / 共享全局=shared-global); valid/issue indicator; actions per skill: 编辑 (switch to edit tab), 升级 (git skills only), 删除 (store only, confirm). Buttons: 新建技能 (dialog: name/description/location select store|shared with warning text for shared: '共享全局技能可能被普通 Agent 会话自动发现'), 从 Git 安装 (dialog: url + optional name), 从本地导入 (dialog: path).\n   - 自定义 Agent tab: agent cards (name, base agent label, description, skill count, prompt indicator); 新建/编辑 dialog with fields: 名称, 描述, 底层 CLI (select of the six with labels Pi/Kimi/OpenCode/Claude Code/Cilo→Kilo Code/Codex), 系统提示词 (textarea, placeholder explains it shapes the agent persona), 技能多选 (checkbox list from catalog, show source badge); 删除 with confirm. Save via /api/agent/save.\n   - 技能编辑 tab: skill picker (select from catalog) -> file tree (entries list, indent by path depth, dir/file icons, click file to open) + textarea editor (monospace, full width) + 保存 (sends expected_revision from last read, on conflict show reload/diff choice), 新建文件/重命名/删除 actions on tree items. Binary files: show '二进制文件，不支持编辑' instead of editor.\n2. Wire into studio-settings.tsx: add a new exported component SkillAgentSettingsContent in a NEW file section or extend ShortcutSettingsContent's tab structure — better: add tab bar inside studio-settings.tsx with two tabs 快捷键 / 技能与 Agent; render SkillAgentManagerContent with the CURRENT device id. For device id: add prop with default from first device of /api/project/list (already used in dashboard) — accept deviceId prop, and in studio-dashboard.tsx where ShortcutSettingsContent is used, pass the same device id used for project creation (look at existing state there, e.g. selectedDeviceId).\n3. Types: add shared interfaces to src/lib/types.ts (SkillSummary, CustomAgent, SkillRef) matching the backend JSON exactly.\nSTYLE: match existing studio-dashboard.tsx aesthetic exactly — text-xs density, rounded-xl borders, bg-muted/40 inputs, shadcn Dialog/Select/Checkbox from src/components/ui, Chinese labels, lucide-react icons. NO new dependencies.\nVERIFY: cd studio-frontend && npx tsc -p tsconfig.app.json --noEmit must pass. Do not run dev server.\nKeep everything self-contained in the new component file; minimal edits to studio-settings.tsx, studio-dashboard.tsx, types.ts.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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