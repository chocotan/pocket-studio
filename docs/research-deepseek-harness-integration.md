# DeepSeek Harness (dsh) 集成调研

> 调研对象: https://github.com/deepseek-ai/deepseek-harness (`dsh`, 版本 0.1.0-rc.6)
> 目标: 将 dsh 作为 Pocket Studio 可管理的 Agent 执行体接入,与现有 Claude Code / Codex / OpenCode / Kilo / Pi 并列。
>
> **落地状态(2026-08-17)**:P0+P1 已完成并验证 —— ① 终端 PTY 形态(`dsh --profile tui` + CC hooks 桥 + TERMINAL_TYPES 条目);② Direct ACP 形态(config.go 默认注册 + cordis.yml 自动生成 + 图片附件拦截 + resume 友好降级 + 前端隐藏图片按钮)。实测结论:数字 `protocolVersion:1` 握手直接通过;`session/resume` 返回 `-32601`;带图片块的 prompt 返回 `-32602` 整条拒绝;`promptCapabilities.image:false` 是可靠的能力信号,daemon 侧据此通用化拦截(不硬编码 dsh)。npm 侧 `@deepseek-ai/dsh-acp-demo` peer 依赖不全(需手动补齐插件树包),故默认条目锁 `0.1.0-rc.6`。P2(qualification 场景)待做。

## 1. dsh 是什么

DeepSeek 官方开源的 agent harness,TypeScript/pnpm monorepo,基于 Cordis 插件框架("一切都是插件":模型适配器、工具注册表、会话日志、agent loop 本身都是可替换插件)。

- **npm 发布**:`@deepseek-ai/dsh`(bin: `dsh`, 0.1.0-rc.6)、`@deepseek-ai/dsh-acp-demo`(bin: `dsh-acp-demo`)
- **成熟度**:Developer preview,README 明确"会有破坏性兼容变更"
- **运行要求**:Node ≥22.19 或 ≥24
- **模型**:原生 DeepSeek 适配器(`DEEPSEEK_API_KEY`,默认模型 `deepseek-v4-pro` / `deepseek-v4-flash`);另支持 OpenAI/Anthropic 兼容自定义 provider(`$DSH_HOME/settings.yaml`)
- **注意**:dsh **没有 TUI 模式**,只有 Web UI 和 headless,不存在"在终端里跑 dsh 交互会话"的形态

## 2. 三种可对接面对比

| 对接面 | 命令 | 交互性 | 与 Pocket Studio 契合度 |
|---|---|---|---|
| **ACP stdio 服务器** | `dsh-acp-demo --config cordis.yml` | 多会话、流式文本、权限请求、取消 | ★★★ 最契合,直接复用 Direct ACP 通道 |
| Headless 一次性任务 | `dsh --profile headless "task"` | 无(打印最终回复即退出, 类似 `claude -p`) | ★ 只适合单发任务场景 |
| Web UI | `dsh web`(127.0.0.1:3080) | 自带完整 UI | ✗ 明确不支持 `--host 0.0.0.0`,与 Studio UI 定位重复,不建议深集成 |

### 2.1 ACP 是刻意收缩的 "automation-only" 协议

dsh 曾有面向 Zed 的完整编辑器级 ACP 桥(diff 卡片、终端卡片、session load/resume),2026-07-23 起退役为**纯自动化协议**(`.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md`,实现在 `packages/acp/acp/`)。

支持的方法与限制(`packages/acp/acp/README.md`):

| 方法 | 行为 |
|---|---|
| `initialize` | 仅通告 baseline 文本 prompt 能力;**不**通告 loadSession / list / resume / 图片 / MCP |
| `session/new` | 绝对 `cwd`;`additionalDirectories`/`mcpServers` 非空即拒绝 |
| `session/prompt` | 仅 text block 拼接;每会话一个 in-flight;等 agent 完全空闲 |
| `session/cancel` | 取消并结算为 `cancelled` |
| `session/update` | **只发 committed `assistant/message` 的文本 chunk**——无工具调用事件、无 reasoning、无 diff 卡片 |
| `session/request_permission` | 一次性 allow/reject,可自动应答 |

明确**不支持**:session/load、resume、list、fork、图片/音频输入、MCP passthrough、逐 token 流。

### 2.2 dsh-acp-demo 的启动要求

`dsh-acp-demo` 不走 dsh profile 系统,直接 boot 一份 `cordis.yml`(必需,默认 `./cordis.yml`)。完整参考配置在仓库 `examples/acp-agent/cordis.yml`,核心行:

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config: { thinking: enabled, reasoningEffort: max, models: [{id: deepseek-v4-flash}, {id: deepseek-v4-pro}] }
- id: sandbox / subprocess / bash / approval / fs-sandbox / tool-fs ...  # 执行栈
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    persistenceRoot: './.sessions'
    persona: |
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}. ...
```

凭据解析顺序:继承环境变量 → `$DSH_HOME/.credentials.yaml` → 启动目录 `.env` → `$DSH_HOME/.env`。沙箱默认 `workspace-write`(bash/fs 写限制在 session workspace + 临时目录),`DSH_PERMISSION_MODE` 可覆盖为 `danger-full-access`。

## 3. 推荐方案:Direct ACP 通道接入

Pocket Studio Daemon 已是标准 ACP 客户端(`internal/daemon/direct_acp.go`,1935 行),与 dsh 的 ACP server 直接对得上。改动清单:

### 3.1 Daemon 侧(Go)

| 文件 | 改动 |
|---|---|
| `internal/daemon/config.go` `normalizeDirectACPAgents()` | 增加 `dsh` 默认条目:`{Command: "npx", Args: ["-y", "@deepseek-ai/dsh-acp-demo@latest", "--config", <生成的配置路径>]}`;本机 `LookPath("dsh-acp-demo")` 命中则优先直连二进制(与 codex/claude/pi 的模式完全一致) |
| `internal/daemon/config.go` 或 daemon 启动逻辑 | 首次启动时**生成默认 `cordis.yml`** 到 daemon 配置目录(参考 `prepareTerminalAgentHooks` 为 opencode/kilo 写插件的先例)。精简版只需 llm-deepseek + sandbox 栈 + acp-agent 行 |
| `internal/daemon/direct_acp.go` `directACPPromptContent()` | 对 `dsh` 过滤/拒绝 image attachment(dsh 只收 text,发了会被 ACP 拒绝整个 prompt) |
| `internal/daemon/direct_acp.go` resume 路径 | dsh 无 load/resume 能力,现有代码在 `sessionID != ""` 时会报 "agent does not support resume or load"。对 dsh 建议提前短路:新开会话而不是报错,或在错误信息中说明"dsh 不支持会话恢复,已开新会话" |
| `internal/daemon/daemon.go` `agentCapabilities()` | 无需改动(自动枚举 `DirectACP.Agents`) |
| env | 通过 `DirectACPAgentConfig.Env` 透传 `DEEPSEEK_API_KEY`、可选 `DSH_PERMISSION_MODE` |

### 3.2 前端侧(studio-frontend)

| 文件 | 改动 |
|---|---|
| `src/components/studio/terminal-types.tsx` | `TerminalKind` union 加 `"dsh"`;`TERMINAL_TYPES` 加条目(label: "DeepSeek", command: `dsh-acp-demo` 或展示名, accent/logo 新增 DeepSeek 图标);`normalizeAgentKind` / `agentTerminalCommand` 相关映射加分支 |
| Agent Chat 面板 | dsh 无工具调用/diff 卡片事件(只有文本 chunk),UI 自然降级为纯对话流,无需专门开发,但建议对 dsh 隐藏"图片附件"按钮 |

### 3.3 验证

- 复用 `scripts/agent-qualification.py` + `conversation-e2e-lib.mjs` 体系,为 dsh 增加一条 qualification 场景(new → prompt → 文本回包 → cancel → permission 自动应答)
- 手动 PoC 最快路径:

```sh
mkdir -p /tmp/dsh-agent && cd /tmp/dsh-agent
# 从 dsh 仓库复制 examples/acp-agent/cordis.yml(或手写精简版)
export DEEPSEEK_API_KEY=sk-...
npx -y @deepseek-ai/dsh-acp-demo@latest --config ./cordis.yml
# 另一终端,用 Pocket Studio 的 Direct ACP 配置指向同一命令即可联调
```

## 4. CLI / 终端交互模式(2026-08-17 补充)

**官方没有内置 TUI**——upstream 在 commit `10bb9cbf4a` 把 `packages/ui/tui` 移除了。但存在三个社区 TUI 插件,且 dsh 的 profile 机制天然支持:

| 项目 | 安装 | 特点 | 风险 |
|---|---|---|---|
| **`dsh-tui/dsh-tui`**(推荐) | `dsh plugin --profile tui add @dsh-tui/dsh-tui`<br>`dsh --profile tui` | 从官方历史恢复的原版 TUI 移植,基于 pi-tui;流式 Markdown、工具卡片/diff、`/resume`、`/model`、审批对话 | 明说"跟随 rc 线,预期会坏";peer 依赖锁测试过的 rc;pi-tui 0.80.7 有 patch |
| `turtle1999/turtle-ui` | `dsh plugin --profile tui add github:deepseek-harness/turtle-ui`(注意:文档示例用 deepseek-harness org,实际在 turtle1999 个人号下,见 Discussion #871) | 原始 TUI 仓库(要求与 dsh 仓库同级目录构建) | 安装路径有坑 |
| `ccch1mneyyy/dsh-cc-tui` | npm | Claude Code 风格,官方公众号收录 | 同为社区项目 |

### 前置条件

```sh
npm i -g @deepseek-ai/dsh@next   # Node ^22.19 || >=24
export DEEPSEEK_API_KEY=sk-...
```

### Pocket Studio 集成方式(终端 PTY 模式)

和 claude/codex/kilo 一样走终端面板,daemon 需要做的事:

1. **`agentTerminalCommand()`**(`daemon.go:5610`)的 `switch base` 白名单加 `"dsh"`(或映射 `dsh-tui` 命令形态),归一化为 agent 名 `dsh`。
2. **启动命令**:`dsh --profile tui`(cwd = 项目目录)。首次运行前需 `dsh plugin --profile tui add @dsh-tui/dsh-tui` 初始化 profile(daemon 可代跑一次,或文档引导用户跑)。
3. **任务完成通知 → CC hooks 兼容桥**:dsh 内置 `@deepseek-ai/dsh-hooks-claude-code` 插件,直接执行 Claude Code 方言的 `hooks.json`(支持 `Stop`、`PreToolUse`、`PostToolUse` 等映射到 typed Decisions)。Pocket Studio 现有 `writeClaudeHookIntegration()` 生成的正是 CC 方言 `Stop` hook(node 脚本上报 daemon),因此:
   - 在生成的 dsh profile `cordis.patch.yml` 里加一行挂载 `dsh-hooks-claude-code`,`configPath` 指向 Pocket Studio 生成的 hooks 配置;
   - hook 命令在**会话工作目录**执行,`POCKET_STUDIO_*` 环境变量照常注入 → 现有通知链路(徽章/声音/通知中心)零改动复用。
4. **前端**:`TERMINAL_TYPES` 增加 `{value: "dsh", command: "dsh --profile tui"}` 条目即可,无需更多改动。

### hooks 注意点(来自 dsh 文档)

- `configPath` 是**进程级、启动时读一次**:相对路径按 server 启动 cwd 解析,一个配置管整个进程,暂无 per-session 发现(TODO)。
- 只执行 `type: "command"` 的 hook;`http`/`mcp_tool`/`prompt`/`agent` 类型解析后跳过。
- `Stop` hook 阻塞返回会 steer 强制再来一步——通知脚本应快速返回(现有 `claude-stop.js` 模式即可)。
- git 安装的插件需在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 白名单(`@dsh-tui/dsh-tui: true`)。

### 双形态并存建议

- **终端面板(PTY)**:`dsh --profile tui` + CC hooks 桥 → 完整交互体验 + 通知,适合作为 dsh 的主打集成形态。
- **Agent Chat(Direct ACP)**:`dsh-acp-demo` → 结构化但降级(无 resume/工具卡片),适合自动化场景。
- 两者共享 `DEEPSEEK_API_KEY` 与 `$DSH_HOME` 凭据,互不冲突。

## 5. 兼容性风险清单

1. **protocolVersion 形态**:Pocket Studio `initialize` 发的是数字 `1`(direct_acp.go:102);ACP 规范与 dsh 的 SDK(`@agentclientprotocol/sdk` 0.25.1)按字符串协商。codex-acp 等宽容,但**必须实测 dsh 的握手**,不行就发字符串 `"1"`。
2. **会话恢复缺失是长期的**:automation-only 是 dsh 的刻意架构决策(不是待修 bug),Pocket Studio 的"导入历史/恢复会话"功能对 dsh 永久降级,建议产品层面明示。
3. **体验降级**:无工具调用渲染、无 reasoning 流、无逐 token 流(committed message 粒度)。用户感知是"回复整段蹦出来"。
4. **图片附件会被整体拒绝**:必须在 daemon 或前端拦截,否则一个附件废掉整条 prompt。
5. **rc 版本依赖**:`@deepseek-ai/dsh-acp-demo` 全家桶都是 0.x-rc,建议在配置里锁版本(不用 `@latest`),dsh 承诺破坏性变更。
6. **配置文件是硬依赖**:cordis.yml 缺失/写错即启动失败;生成逻辑要随 dsh 升级维护(留意 dsh 仓库 `examples/acp-agent/cordis.yml` 的演进)。
7. **headless 兜底**:若某场景需要"单发无状态任务"(如后台批处理),`dsh --profile headless "task"`(stdout 最终回复,exit code 0/1)可作为轻量补充,不需要 ACP。
8. **遥测默认关**:dsh 会话遥测本地留存,默认不上传,无隐私外泄问题。
9. **TUI 是社区插件**:官方删除了 TUI 上游(`10bb9cbf4a`),`dsh-tui` 等插件跟随 rc 线,损坏风险自担;`@dsh-tui/dsh-tui` peer 依赖锁 rc 版本,升级 dsh 时可能需要同步升级 TUI 插件。
10. **hooks 桥只支持 CC 方言子集**:`http`/`mcp_tool`/`prompt`/`agent` 类型 hook 不执行;`systemMessage`/`updatedInput` 不模型可见。Pocket Studio 只用 `Stop` 通知,不受影响。

## 6. 分阶段落地建议

- **P0(PoC)✅ 已完成(2026-08-17)**:① ACP 路线:实测 initialize(`protocolVersion` 数字直接通过,无需改字符串)/ session/new / 图片拒绝(-32602)/ resume 缺失(-32601)。注意:`npx @deepseek-ai/dsh-acp-demo` 裸跑会因 peer 依赖不全而 plugin tree 加载失败,需在安装目录补齐插件树(见 ~/.npm 缓存或手动 npm i 全套)。② CLI 路线:本机 `dsh --profile tui` 在终端面板验证通过。
- **P1(产品化)✅ 已完成(2026-08-17)**:config.go 默认注册(锁 0.1.0-rc.6,`deepseek` 别名归一到 `dsh`,陈旧 npx 条目自动修复)+ `ensureDshACPCordisConfig()` 在 daemon Run 时生成 cordis.yml(已用真实 dsh-acp-demo 验证可 boot)+ 前端 DeepSeek 图标/类型/菜单条目 + 图片附件拦截(通用:`capabilities.Image` 从 `promptCapabilities.image` 解析,false 时丢弃图片发 `attachment.dropped` 事件)+ resume 友好降级(新开会话 + `session.restore_unavailable` 事件)+ 前端对 dsh 隐藏图片上传按钮/粘贴拦截。CLI 路线:`agentTerminalCommand` 白名单 + hooks 桥 cordis.patch 注入(`upsertDshProfileHookPatch`,带测试)+ TERMINAL_TYPES 条目。
- **P2(质量,待做)**:qualification 场景(new → prompt → 文本回包 → cancel → permission 自动应答)+ e2e + 锁版本升级流程 + 文档(README Agent 列表提及 dsh)。
- **观察项**:跟踪 dsh 仓库 `.agents/notes/` 的 ACP 决策变化;跟踪 `dsh-tui` 插件与 rc 线的兼容性;若未来官方恢复 TUI 或恢复 load/resume,可升级集成深度。
