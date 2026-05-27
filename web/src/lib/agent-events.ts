export type TaskEvent = {
  task_id: string;
  event_id?: string;
  event_type: string;
  source?: string;
  sequence?: number;
  timestamp?: number;
  received_at?: number;
  data?: unknown;
  raw?: unknown;
};

export type TimelineKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "permission"
  | "commands"
  | "mode"
  | "usage"
  | "system"
  | "error";

export type TimelineItem =
  | { kind: "message"; itemKind: TimelineKind; event: TaskEvent; title: string; summary: string; meta: [string, string][] }
  | { kind: "tool"; itemKind: "tool"; id: string; uiKey: string; event: TaskEvent; call: ToolUse | null; result: TaskEvent | null }
  | { kind: "permission"; itemKind: "permission"; id: string; uiKey: string; event: TaskEvent; request: PermissionRequest }
  | { kind: "commands"; itemKind: "commands"; uiKey: string; event: TaskEvent; commands: AgentCommand[] }
  | { kind: "mode"; itemKind: "mode"; uiKey: string; event: TaskEvent; modeID: string; modes: AgentMode[] };

export type TimedTimelineItem = TimelineItem & {
  elapsedSeconds?: number;
};

export type ToolUse = {
  id?: string;
  tool_use_id?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  input?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  locations?: ToolLocation[];
  content?: unknown[];
};

export type ToolLocation = {
  path?: string;
};

export type ToolOutput = {
  title: string;
  summary: string;
  meta: [string, string][];
  isError: boolean;
};

export type PermissionRequest = {
  id: string;
  title: string;
  kind: string;
  status: string;
  input: Record<string, unknown>;
  options: PermissionOption[];
};

export type PermissionOption = {
  id: string;
  name: string;
  kind: string;
};

export type AgentCommand = {
  name: string;
  description?: string;
  hint?: string;
};

export type AgentMode = {
  id: string;
  name: string;
  description?: string;
};

export type AgentModel = {
  modelId: string;
  name: string;
  description?: string;
};

export type SessionUsage = {
  contextUsed?: number;
  contextSize?: number;
  costAmount?: number;
  costCurrency?: string;
  turnInput?: number;
  turnOutput?: number;
  turnCachedRead?: number;
  turnCachedWrite?: number;
  turnTotal?: number;
};

export type ACPXSessionStatus = {
  status?: string;
  pid?: number;
  uptime?: number;
  ttlSeconds?: number;
  session?: string;
  agent?: string;
  text?: string;
};

export function buildTimelineItems(sourceEvents: TaskEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolItems = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const pendingResults = new Map<string, TaskEvent>();

  for (const event of sourceEvents) {
    const payload = eventPayload(event);
    const toolUse = isToolCallEvent(event, payload) ? extractToolUse(payload) : null;
    if (toolUse && isVisibleEvent(event)) {
      const id = toolID(toolUse) || event.event_id || `tool-${items.length}`;
      const item = upsertToolItem(items, toolItems, event, id, toolUse);
      const pendingResult = pendingResults.get(id);
      if (pendingResult) {
        item.result = pendingResult;
        pendingResults.delete(id);
      }
      continue;
    }

    if (isToolResultEvent(event, payload)) {
      const resultID = extractToolResultID(payload);
      const existing = resultID ? toolItems.get(resultID) : undefined;
      if (existing) {
        existing.result = event;
        continue;
      }
      if (resultID) pendingResults.set(resultID, event);
      const id = resultID || event.event_id || `tool-result-${items.length}`;
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        kind: "tool",
        itemKind: "tool",
        id,
        uiKey: timelineKey(event, id, items.length),
        event,
        call: null,
        result: event
      };
      toolItems.set(id, item);
      items.push(item);
      continue;
    }

    const permission = extractPermissionRequest(payload);
    if (permission) {
      items.push({ kind: "permission", itemKind: "permission", id: permission.id, uiKey: timelineKey(event, permission.id, items.length), event, request: permission });
      continue;
    }

    const commands = extractCommands(payload);
    if (commands.length > 0 && isVisibleEvent(event)) {
      items.push({ kind: "commands", itemKind: "commands", uiKey: timelineKey(event, "commands", items.length), event, commands });
      continue;
    }

    const mode = extractModeUpdate(payload);
    if (mode && isVisibleEvent(event)) {
      items.push({ kind: "mode", itemKind: "mode", uiKey: timelineKey(event, "mode", items.length), event, modeID: mode.modeID, modes: mode.modes });
      continue;
    }

    if (!isVisibleEvent(event)) continue;
    const description = describeEvent(event);
    items.push({ kind: "message", itemKind: messageItemKind(event), event, ...description });
  }

  return items;
}

function upsertToolItem(
  items: TimelineItem[],
  toolItems: Map<string, Extract<TimelineItem, { kind: "tool" }>>,
  event: TaskEvent,
  id: string,
  toolUse: ToolUse
) {
  const existing = toolItems.get(id);
  if (existing) {
    const previousHasInput = hasToolInput(existing.call);
    existing.call = mergeToolUse(existing.call, toolUse);
    if (hasToolInput(toolUse) || !previousHasInput) existing.event = event;
    return existing;
  }
  const item: Extract<TimelineItem, { kind: "tool" }> = {
    kind: "tool",
    itemKind: "tool",
    id,
    uiKey: timelineKey(event, id, items.length),
    event,
    call: toolUse,
    result: null
  };
  toolItems.set(id, item);
  items.push(item);
  return item;
}

export function attachTimelineTiming(items: TimelineItem[]): TimedTimelineItem[] {
  let previousTime = 0;
  return items.map((item) => {
    const currentTime = eventTimeSeconds(item.kind === "tool" && item.result ? item.result : item.event);
    const elapsedSeconds = previousTime && currentTime ? Math.max(0, currentTime - previousTime) : undefined;
    if (currentTime) previousTime = currentTime;
    return { ...item, elapsedSeconds };
  });
}

export function isVisibleEvent(event: TaskEvent) {
  const type = event.event_type || "";
  const payload = eventPayload(event);
  if (type === "user.prompt") return true;
  if (type === "assistant.message") return hasVisibleText(event);
  if (type === "assistant.thinking") return hasVisibleText(event);
  if (type === "tool.call" || type === "tool.output") return true;
  if (extractACPXToolUpdate(payload)) return true;
  if (extractPermissionRequest(payload)) return true;
  if (type === "commands.updated" || type === "mode.updated") return true;
  if (type === "task.failed" || type === "task.killed" || type === "server.error") return true;
  if (type === "model.list" || type === "acpx.status" || type === "acpx.status_failed") return false;
  if (type === "model.updated" || type === "model.update_failed") return false;
  if (type === "metric.updated") return false;
  if (type === "claude.raw") {
    const rawType = String(payload.type || payload.subtype || "");
    if (isToolResultPayload(payload)) return true;
    if (rawType === "system" || rawType === "result" || rawType === "user") return false;
    return hasVisibleText(event);
  }
  if (type === "acpx.raw" || type === "acpx.session") return false;
  return false;
}

export function describeEvent(event: TaskEvent) {
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  const payload = Object.keys(raw).length ? raw : data;
  const type = event.event_type || "";
  if (isToolResultPayload(payload)) return describeToolOutput(data, payload);
  if (type === "user.prompt") return { title: "用户", summary: String(data.prompt || ""), meta: [] as [string, string][] };
  if (type === "assistant.message") return { title: "Agent", summary: extractText(data) || extractText(raw) || "Agent 返回了一条消息。", meta: [] as [string, string][] };
  if (type === "assistant.thinking") return { title: "Thinking", summary: extractText(data) || extractText(raw) || "Agent 正在思考。", meta: [] as [string, string][] };
  if (type === "permission.request") return { title: "权限请求", summary: extractPermissionRequest(payload)?.title || "Agent 请求授权。", meta: [] as [string, string][] };
  if (type === "commands.updated") return { title: "可用命令", summary: `可用命令 ${extractCommands(payload).length} 个。`, meta: [] as [string, string][] };
  if (type === "mode.updated") return { title: "模式更新", summary: extractModeUpdate(payload)?.modeID || "Agent 模式已更新。", meta: [] as [string, string][] };
  if (type === "acpx.session") return { title: "会话", summary: "已确保当前工作区会话可复用。", meta: sessionMeta(payload) };
  if (type === "acpx.raw") return { title: "系统事件", summary: describeACPXRaw(payload), meta: [] as [string, string][] };
  if (type === "acpx.status") return { title: "acpx 状态", summary: formatACPXStatusPayload(payload), meta: statusMeta(payload) };
  if (type === "acpx.status_failed") return { title: "acpx 状态失败", summary: String(data.error || "获取 acpx 状态失败。"), meta: [] as [string, string][] };
  if (type === "metric.updated") return describeMetricEvent(payload);
  if (type === "model.list") return { title: "模型列表", summary: `可用模型 ${extractSessionModels([event]).length} 个。`, meta: [] as [string, string][] };
  if (type === "model.updated") return { title: "模型已切换", summary: `当前模型：${String(data.model_id || raw.model_id || "")}`, meta: [] as [string, string][] };
  if (type === "model.update_failed") return { title: "模型切换失败", summary: String(data.error || raw.error || "模型切换失败。"), meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "user") return { title: "上下文注入", summary: "Agent 向模型注入了上下文内容。", meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "system") return { title: "系统事件", summary: "Agent 会话元数据更新。", meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "result") return { title: "执行结果", summary: "Agent 返回最终执行结果。", meta: [] as [string, string][] };
  if (type === "task.failed") return { title: "任务失败", summary: String(data.message || data.error || "任务执行失败。"), meta: [] as [string, string][] };
  if (type === "server.error") return { title: "服务端错误", summary: String(data.message || "服务端返回错误。"), meta: [] as [string, string][] };
  return { title: type || "事件", summary: extractText(payload) || "收到一条事件。", meta: [] as [string, string][] };
}

export function messageItemKind(event: TaskEvent): TimelineKind {
  const type = event.event_type || "";
  if (type === "user.prompt") return "user";
  if (type === "assistant.message") return "assistant";
  if (type === "assistant.thinking") return "thinking";
  if (type === "permission.request") return "permission";
  if (type === "commands.updated") return "commands";
  if (type === "mode.updated") return "mode";
  if (type === "metric.updated") return "usage";
  if (type === "task.failed" || type === "task.killed" || type === "server.error") return "error";
  return "system";
}

export function messageTone(itemKind: TimelineKind) {
  if (itemKind === "user") return "user";
  if (itemKind === "thinking") return "thinking";
  if (itemKind === "error") return "error";
  if (itemKind === "commands" || itemKind === "mode" || itemKind === "usage" || itemKind === "system") return "system";
  return "assistant";
}

export function displayTitle(item: Extract<TimelineItem, { kind: "message" }>, agentLabel: string) {
  if (item.itemKind === "user") return "用户";
  if (item.itemKind === "thinking") return "Thinking";
  if (item.itemKind === "assistant") return agentLabel || "Agent";
  return item.title;
}

export function describeToolOutput(data: Record<string, unknown>, payload: Record<string, unknown>): ToolOutput {
  const result = (payload.tool_use_result || {}) as Record<string, unknown>;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const text = String(data.text || stdout || stderr || extractToolResultContent(payload) || extractText(payload) || "");
  const isError = Boolean(result.is_error || stderr);
  return { title: isError ? "工具错误输出" : "工具返回", summary: text || "工具返回了输出。", meta: [] as [string, string][], isError };
}

export function toolOutputForEvent(event: TaskEvent | null | undefined) {
  if (!event) return null;
  return describeToolOutput(normalizePayload(event.data), normalizePayload(event.raw));
}

export function extractToolUse(payload: Record<string, unknown>): ToolUse {
  const acpxToolUpdate = extractACPXToolUpdate(payload);
  if (acpxToolUpdate) return acpxToolUpdate;
  if ((payload.name || payload.title || payload.kind) && (payload.input || payload.rawInput || payload.rawOutput)) return payload as ToolUse;
  const content = (payload.content || (payload.message as Record<string, unknown> | undefined)?.content) as unknown;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (((item as Record<string, unknown>).type === "tool_use") || (item as Record<string, unknown>).name || (item as Record<string, unknown>).title)) {
        return item as ToolUse;
      }
    }
  }
  return {};
}

export function extractACPXToolUpdate(payload: Record<string, unknown>): ToolUse | null {
  const update = acpxUpdate(payload);
  const updateType = String(update?.sessionUpdate || "");
  if (updateType !== "tool_call" && updateType !== "tool_call_update") return null;
  const id = String(update?.toolCallId || update?.tool_call_id || update?.id || "");
  const meta = update?._meta as Record<string, unknown> | undefined;
  const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
  return {
    id,
    toolCallId: id,
    name: String(claudeCode?.toolName || update?.title || update?.kind || update?.name || "tool"),
    title: String(update?.title || claudeCode?.toolName || update?.kind || "tool"),
    kind: String(update?.kind || ""),
    status: String(update?.status || ""),
    rawInput: objectValue(update?.rawInput),
    input: objectValue(update?.input),
    rawOutput: update?.rawOutput,
    locations: Array.isArray(update?.locations) ? update.locations as ToolLocation[] : undefined,
    content: Array.isArray(update?.content) ? update.content as unknown[] : undefined
  };
}

export function extractToolResultID(payload: Record<string, unknown>) {
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    const result = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result" && (item as Record<string, unknown>).tool_use_id) as Record<string, unknown> | undefined;
    if (result) return String(result.tool_use_id);
  }
  return String(payload.tool_use_id || payload.parent_tool_use_id || payload.toolCallId || payload.tool_call_id || "");
}

export function isToolResultPayload(payload: Record<string, unknown>) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.tool_use_result) return true;
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  return Array.isArray(content) && content.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result");
}

export function isToolResultEvent(event: TaskEvent, payload = eventPayload(event)) {
  return event.event_type === "tool.output" || isToolResultPayload(payload);
}

export function isToolCallEvent(event: TaskEvent, payload = eventPayload(event)) {
  return event.event_type === "tool.call" || Boolean(extractACPXToolUpdate(payload));
}

export function extractPermissionRequest(payload: Record<string, unknown>): PermissionRequest | null {
  if (payload.method !== "session/request_permission") return null;
  const params = payload.params as Record<string, unknown> | undefined;
  const toolCall = params?.toolCall as Record<string, unknown> | undefined;
  if (!toolCall) return null;
  const rawInput = objectValue(toolCall.rawInput) || objectValue(toolCall.raw_input) || {};
  const id = String(toolCall.toolCallId || toolCall.tool_call_id || toolCall.id || "");
  const options = Array.isArray(params?.options) ? params.options as Record<string, unknown>[] : [];
  return {
    id,
    title: String(toolCall.title || rawInput.description || toolCall.kind || "权限请求"),
    kind: String(toolCall.kind || "execute"),
    status: String(toolCall.status || "pending"),
    input: rawInput,
    options: options.map((option, index) => ({
      id: String(option.optionId || option.option_id || `option_${index}`),
      name: String(option.name || `选项 ${index + 1}`),
      kind: String(option.kind || "")
    }))
  };
}

export function extractCommands(payload: Record<string, unknown>): AgentCommand[] {
  const update = acpxUpdate(payload);
  if (update?.sessionUpdate !== "available_commands_update") return [];
  const available = update.availableCommands;
  if (!Array.isArray(available)) return [];
  return available
    .map((command) => {
      if (!command || typeof command !== "object") return null;
      const item = command as Record<string, unknown>;
      const input = item.input as Record<string, unknown> | undefined;
      const name = String(item.name || "");
      if (!name) return null;
      return {
        name,
        description: typeof item.description === "string" ? item.description : undefined,
        hint: typeof input?.hint === "string" ? input.hint : undefined
      };
    })
    .filter(Boolean) as AgentCommand[];
}

export function extractModeUpdate(payload: Record<string, unknown>): { modeID: string; modes: AgentMode[] } | null {
  const update = acpxUpdate(payload);
  if (update?.sessionUpdate !== "current_mode_update") return null;
  return {
    modeID: String(update.modeId || update.mode_id || update.currentModeId || ""),
    modes: modesFromPayload(payload)
  };
}

export function modesFromPayload(payload: Record<string, unknown>): AgentMode[] {
  const result = payload.result as Record<string, unknown> | undefined;
  const modes = (result?.modes || payload.modes) as Record<string, unknown> | undefined;
  const available = modes?.availableModes || payload.availableModes;
  if (!Array.isArray(available)) return [];
  return available
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const mode = item as Record<string, unknown>;
      const id = String(mode.id || mode.modeId || "");
      if (!id) return null;
      return {
        id,
        name: String(mode.name || id),
        description: typeof mode.description === "string" ? mode.description : undefined
      };
    })
    .filter(Boolean) as AgentMode[];
}

export function extractSessionModels(events: TaskEvent[]): AgentModel[] {
  const models = new Map<string, AgentModel>();
  for (const event of events) {
    for (const payload of [normalizePayload(event.raw), normalizePayload(event.data)]) {
      for (const model of modelsFromPayload(payload)) {
        models.set(model.modelId, model);
      }
    }
  }
  return [...models.values()];
}

export function modelsFromPayload(payload: Record<string, unknown>): AgentModel[] {
  const result = payload.result as Record<string, unknown> | undefined;
  const models = (result?.models || payload.models) as Record<string, unknown> | undefined;
  const available = models?.availableModels || payload.availableModels;
  if (!Array.isArray(available)) return [];
  return available
    .map((item) => {
      if (typeof item === "string") return { modelId: item, name: item };
      if (!item || typeof item !== "object") return null;
      const model = item as Record<string, unknown>;
      const modelId = String(model.modelId || model.id || "");
      if (!modelId) return null;
      return {
        modelId,
        name: String(model.name || modelId),
        description: typeof model.description === "string" ? model.description : undefined
      };
    })
    .filter(Boolean) as AgentModel[];
}

export function latestModelID(events: TaskEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    for (const payload of [normalizePayload(event.data), normalizePayload(event.raw)]) {
      const result = payload.result as Record<string, unknown> | undefined;
      const models = result?.models as Record<string, unknown> | undefined;
      const modelID = String(payload.model_id || payload.modelId || payload.model || models?.currentModelId || "");
      if (modelID) return modelID;
    }
  }
  return "";
}

export function extractACPXSessionStatus(events: TaskEvent[]): ACPXSessionStatus {
  const status: ACPXSessionStatus = {};
  for (const event of events) {
    if (event.event_type !== "acpx.status") continue;
    const data = normalizePayload(event.data);
    const raw = normalizePayload(event.raw);
    const payload = { ...raw, ...data };
    status.status = stringValue(payload.status || payload.state) || status.status;
    status.pid = numberValue(payload.pid) ?? status.pid;
    status.uptime = numberValue(payload.uptime || payload.uptimeSeconds || payload.uptime_seconds) ?? status.uptime;
    status.ttlSeconds = numberValue(payload.ttl_seconds || payload.ttlSeconds || payload.ttl) ?? status.ttlSeconds;
    status.session = stringValue(payload.session || payload.session_name || payload.name) || status.session;
    status.agent = stringValue(payload.agent) || status.agent;
    status.text = stringValue(payload.text) || status.text;
  }
  return status;
}

export function formatACPXStatus(status: ACPXSessionStatus) {
  if (status.status) return status.pid ? `${status.status} / pid ${status.pid}` : status.status;
  return status.text || "-";
}

export function formatACPXTtl(status: ACPXSessionStatus) {
  if (status.ttlSeconds === undefined) return "-";
  if (status.ttlSeconds === 0) return "不自动退出";
  return `${status.ttlSeconds}s`;
}

export function formatACPXStatusPayload(payload: Record<string, unknown>) {
  const status = extractACPXSessionStatus([{ task_id: "", event_type: "acpx.status", data: payload }]);
  return [`状态 ${formatACPXStatus(status)}`, `TTL ${formatACPXTtl(status)}`].join(" / ");
}

export function extractSessionUsage(events: TaskEvent[]): SessionUsage {
  const usage: SessionUsage = {};
  for (const event of events) {
    if (event.event_type !== "metric.updated") continue;
    const payload = normalizePayload(event.raw);
    const update = acpxUpdate(payload);
    if (update?.sessionUpdate === "usage_update") {
      usage.contextUsed = numberValue(update.used) ?? usage.contextUsed;
      usage.contextSize = numberValue(update.size) ?? usage.contextSize;
      const cost = update.cost as Record<string, unknown> | undefined;
      if (cost && typeof cost === "object") {
        usage.costAmount = numberValue(cost.amount) ?? usage.costAmount;
        if (typeof cost.currency === "string") usage.costCurrency = cost.currency;
      }
    }
    const result = payload.result as Record<string, unknown> | undefined;
    const turn = result?.usage as Record<string, unknown> | undefined;
    if (turn) {
      usage.turnInput = numberValue(turn.inputTokens) ?? usage.turnInput;
      usage.turnOutput = numberValue(turn.outputTokens) ?? usage.turnOutput;
      usage.turnCachedRead = numberValue(turn.cachedReadTokens) ?? usage.turnCachedRead;
      usage.turnCachedWrite = numberValue(turn.cachedWriteTokens) ?? usage.turnCachedWrite;
      usage.turnTotal = numberValue(turn.totalTokens) ?? usage.turnTotal;
    }
  }
  return usage;
}

export function formatContextUsage(usage: SessionUsage) {
  if (usage.contextUsed === undefined && usage.contextSize === undefined) return "-";
  return `${formatNumber(usage.contextUsed)} / ${formatNumber(usage.contextSize)}`;
}

export function formatUsageCost(usage: SessionUsage) {
  if (usage.costAmount === undefined) return "-";
  return `${formatCost(usage.costAmount)} ${usage.costCurrency || ""}`.trim();
}

export function formatTurnUsage(usage: SessionUsage) {
  if (usage.turnTotal === undefined) return "-";
  return `总 ${formatNumber(usage.turnTotal)} · 入 ${formatNumber(usage.turnInput)} / 出 ${formatNumber(usage.turnOutput)}`;
}

export function toolID(toolUse: ToolUse | null | undefined) {
  if (!toolUse) return "";
  return String(toolUse.id || toolUse.tool_use_id || toolUse.toolCallId || "");
}

export function toolName(toolUse: ToolUse | null | undefined) {
  return String(toolUse?.name || toolUse?.title || toolUse?.kind || "tool");
}

export function toolInput(toolUse: ToolUse | null | undefined) {
  return toolUse?.input || toolUse?.rawInput || {};
}

export function toolTitle(name: string, input: Record<string, unknown>, kind = "") {
  const lower = `${name || ""} ${kind || ""}`.toLowerCase();
  if (isSkillRead(name, input)) return `阅读 Skill：${skillNameFromInput(input)}`;
  if (isSkillTool(name, input)) return `调用 Skill：${skillNameFromInput(input)}`;
  if (lower.includes("bash") || lower.includes("execute")) return "执行命令";
  if (lower.includes("read")) return "读取文件";
  if (lower.includes("edit") || lower.includes("write")) return "修改文件";
  if (lower.includes("grep") || lower.includes("search")) return "搜索文本";
  if (lower.includes("glob")) return "查找文件";
  if (lower.includes("todo")) return "更新任务清单";
  if (lower.includes("fetch")) return "获取网页";
  return `调用工具：${name}`;
}

export function toolTarget(input: Record<string, unknown>) {
  return String(input.file_path || input.path || input.pattern || input.query || input.command || input.cmd || input.url || "");
}

export function toolUseSummary(input: Record<string, unknown>, locations?: ToolLocation[]) {
  const target = toolTarget(input);
  if (target) return target;
  const location = locations?.find((item) => item.path)?.path;
  if (location) return location;
  return JSON.stringify(input, null, 2);
}

export function toolStatusLabel(toolUse: ToolUse | null | undefined, hasResult: boolean, isError: boolean) {
  const status = String(toolUse?.status || "").toLowerCase();
  if (isError || status.includes("fail") || status.includes("error")) return "失败";
  if (hasResult || status === "completed") return "完成";
  if (status === "pending") return "等待";
  return "执行中";
}

export function toolStatusVariant(toolUse: ToolUse | null | undefined, hasResult: boolean, isError: boolean) {
  const status = String(toolUse?.status || "").toLowerCase();
  if (isError || status.includes("fail") || status.includes("error")) return "destructive" as const;
  if (hasResult || status === "completed") return "secondary" as const;
  return "warning" as const;
}

export function hasToolInput(toolUse: ToolUse | null | undefined) {
  if (!toolUse) return false;
  return hasObjectContent(toolUse.input) || hasObjectContent(toolUse.rawInput);
}

export function hasObjectContent(value: unknown) {
  if (!value) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function normalizePayload(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { text: value };
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return { text: String(value) };
}

export function eventTimeSeconds(event: TaskEvent | undefined) {
  return Number(event?.timestamp || event?.received_at || 0);
}

export function formatEventTime(event: TaskEvent) {
  const value = eventTimeSeconds(event);
  if (!value) return "--:--:--";
  return new Date(value * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

export function extractText(value: Record<string, unknown> | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const part = item as Record<string, unknown>;
        if (part.type === "tool_result" || part.type === "tool_use") return "";
        return String(part.text || part.content || "");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value.message && typeof value.message === "object") return extractText(value.message as Record<string, unknown>);
  if (typeof value.result === "string") return value.result;
  return "";
}

export function extractSessionIDFromEvent(event: TaskEvent) {
  for (const value of [normalizePayload(event.raw), normalizePayload(event.data)]) {
    if (typeof value.session_id === "string" && value.session_id) return value.session_id;
    for (const key of ["sessionId", "acpxRecordId", "acpxSessionId", "agentSessionId"]) {
      if (typeof value[key] === "string" && value[key]) return String(value[key]);
    }
    const message = value.message as Record<string, unknown> | undefined;
    if (message && typeof message.session_id === "string") return message.session_id;
  }
  return "";
}

function mergeToolUse(current: ToolUse | null, next: ToolUse): ToolUse {
  if (!current) return next;
  const nextHasInput = hasToolInput(next);
  return {
    ...current,
    ...next,
    name: next.name || current.name,
    title: next.title || current.title,
    kind: next.kind || current.kind,
    status: next.status || current.status,
    input: nextHasInput ? next.input : current.input,
    rawInput: nextHasInput ? next.rawInput : current.rawInput,
    locations: next.locations?.length ? next.locations : current.locations,
    content: next.content?.length ? next.content : current.content
  };
}

function hasVisibleText(event: TaskEvent) {
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  return Boolean(extractText(data) || extractText(raw) || data.text || data.command || raw.command);
}

function extractToolResultContent(payload: Record<string, unknown>) {
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result")
    .map((item) => String((item as Record<string, unknown>).content || ""))
    .filter(Boolean)
    .join("\n");
}

function sessionMeta(payload: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const key of ["agent"]) {
    if (typeof payload[key] === "string" && payload[key]) rows.push([key, String(payload[key])]);
  }
  return rows;
}

function statusMeta(payload: Record<string, unknown>): [string, string][] {
  const rows = sessionMeta(payload);
  const model = String(payload.model || payload.model_id || "");
  if (model) rows.push(["model", model]);
  const models = modelsFromPayload(payload);
  if (models.length > 0) rows.push(["models", String(models.length)]);
  return rows;
}

function describeACPXRaw(payload: Record<string, unknown>) {
  const update = acpxUpdate(payload);
  const updateType = String(update?.sessionUpdate || "");
  if (updateType === "agent_thought_chunk") return "Agent 正在思考。";
  if (updateType === "available_commands_update") return "Agent 可用命令列表已更新。";
  if (updateType) return `收到 ${updateType}。`;
  return "收到一条协议事件。";
}

function describeMetricEvent(payload: Record<string, unknown>) {
  const update = acpxUpdate(payload);
  const result = payload.result as Record<string, unknown> | undefined;
  const usage = result?.usage as Record<string, unknown> | undefined;
  if (usage) {
    return {
      title: "本轮 Token",
      summary: [
        `输入 ${formatNumber(usage.inputTokens)}`,
        `输出 ${formatNumber(usage.outputTokens)}`,
        `缓存读 ${formatNumber(usage.cachedReadTokens)}`,
        `缓存写 ${formatNumber(usage.cachedWriteTokens)}`,
        `总计 ${formatNumber(usage.totalTokens)}`
      ].join(" / "),
      meta: [] as [string, string][]
    };
  }
  if (update?.cost && typeof update.cost === "object") {
    const cost = update.cost as Record<string, unknown>;
    return {
      title: "上下文用量",
      summary: `上下文 ${formatNumber(update.used)} / ${formatNumber(update.size)}，费用 ${formatCost(cost.amount)} ${String(cost.currency || "")}`.trim(),
      meta: [] as [string, string][]
    };
  }
  if (update?.used || update?.size) {
    return { title: "上下文用量", summary: `上下文 ${formatNumber(update.used)} / ${formatNumber(update.size)}`, meta: [] as [string, string][] };
  }
  if (result?.stopReason) return { title: "本轮结束", summary: `停止原因：${String(result.stopReason)}`, meta: [] as [string, string][] };
  return { title: "运行指标", summary: "运行指标已更新。", meta: [] as [string, string][] };
}

function isSkillRead(name: string, input: Record<string, unknown>) {
  const target = toolTarget(input).toLowerCase();
  return name.toLowerCase().includes("read") && target.endsWith("skill.md");
}

function isSkillTool(name: string, input: Record<string, unknown>) {
  const target = toolTarget(input).toLowerCase();
  return name.toLowerCase().includes("skill") || target.includes("/skills/") || target.includes(".agents/skills") || target.includes(".codex/skills");
}

function skillNameFromInput(input: Record<string, unknown>) {
  const target = toolTarget(input);
  const parts = target.split("/").filter(Boolean);
  const idx = parts.findIndex((part) => part === "skills");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  if (target.endsWith("SKILL.md") && parts.length >= 2) return parts[parts.length - 2];
  return "Skill";
}

function eventPayload(event: TaskEvent) {
  const raw = normalizePayload(event.raw);
  return Object.keys(raw).length ? raw : normalizePayload(event.data);
}

function acpxUpdate(payload: Record<string, unknown>) {
  const params = payload.params as Record<string, unknown> | undefined;
  return params?.update as Record<string, unknown> | undefined;
}

function timelineKey(event: TaskEvent, id: string | undefined, index: number) {
  return `${event.task_id || "task"}:${event.event_id || id || "item"}:${index}`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : "";
}

export function formatNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "-";
}

export function formatCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "-";
}
