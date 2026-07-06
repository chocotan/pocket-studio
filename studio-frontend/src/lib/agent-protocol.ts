export type AgentProtocolEventKind =
  | "assistant_chunk"
  | "thought"
  | "tool_call"
  | "permission_request"
  | "status";

export type AgentProtocolEvent = {
  kind: AgentProtocolEventKind;
  content: string;
  metadata?: Record<string, unknown>;
};

export type AgentToolCallItem = {
  id: string;
  title: string;
  status?: string;
  kind?: string;
  input?: unknown;
  output?: unknown;
  terminalId?: string;
  createdAt: string;
  completedAt?: string;
};

export type AgentModelInfo = {
  description?: string;
  id: string;
  name?: string;
};

export type AgentModelList = {
  currentModelId?: string;
  models: AgentModelInfo[];
};

export type AgentConfigOptionChoice = {
  description?: string;
  id: string;
  name: string;
};

export type AgentConfigOption = {
  category?: string;
  currentValue?: string;
  description?: string;
  id: string;
  name: string;
  options: AgentConfigOptionChoice[];
};

type AgentEventLike = {
  id: string;
  seq: number;
  kind: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

function getProtocolRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  return getProtocolRecord(record[key]);
}

export function getProtocolText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = getProtocolRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content.map(getProtocolText).join("");
  }
  return "";
}

export function getProtocolSessionUpdate(
  value: unknown
): Record<string, unknown> | null {
  const record = getProtocolRecord(value);
  if (record?.method !== "session/update") {
    return null;
  }
  const params = getNestedRecord(record, "params");
  return params ? getNestedRecord(params, "update") : null;
}

function getPermissionToolCall(value: unknown): Record<string, unknown> | null {
  const record = getProtocolRecord(value);
  const method = String(record?.method || "");
  if (!method.includes("permission")) {
    return null;
  }
  const params = record ? getNestedRecord(record, "params") : null;
  return params ? getNestedRecord(params, "toolCall") : null;
}

function getToolTitle(update: Record<string, unknown> | null) {
  if (!update) {
    return "Tool call";
  }
  return String(
    update.title ||
      update.name ||
      update.toolName ||
      update.tool ||
      update.toolCallId ||
      update.tool_call_id ||
      update.id ||
      "Tool call"
  );
}

export function classifyAgentProtocolEvent(
  value: unknown
): AgentProtocolEvent | null {
  const record = getProtocolRecord(value);
  if (!record) {
    return null;
  }

  const method = String(record.method || "");
  const type = String(record.type || record.event || method);
  const update = getProtocolSessionUpdate(record);

  if (update) {
    const sessionUpdate = String(update.sessionUpdate || "");
    if (sessionUpdate === "agent_message_chunk") {
      return {
        kind: "assistant_chunk",
        content: getProtocolText(update.content),
        metadata: record,
      };
    }
    if (sessionUpdate === "agent_thought_chunk") {
      return {
        kind: "thought",
        content: getProtocolText(update.content),
        metadata: record,
      };
    }
    if (
      sessionUpdate === "tool_call" ||
      sessionUpdate === "tool_call_update" ||
      sessionUpdate.includes("tool")
    ) {
      return {
        kind: "tool_call",
        content: getToolTitle(update),
        metadata: record,
      };
    }
    if (sessionUpdate.includes("permission")) {
      return {
        kind: "permission_request",
        content: getToolTitle(update) || "Agent requested permission.",
        metadata: record,
      };
    }
    if (sessionUpdate === "available_commands_update") {
      const commands = Array.isArray(update.availableCommands)
        ? update.availableCommands.length
        : 0;
      return {
        kind: "status",
        content: commands
          ? `${commands} slash commands available`
          : "Slash commands updated",
        metadata: record,
      };
    }
    if (sessionUpdate === "usage_update") {
      return { kind: "status", content: "Usage updated", metadata: record };
    }
    return {
      kind: "status",
      content: sessionUpdate || method,
      metadata: record,
    };
  }

  const permissionToolCall = getPermissionToolCall(record);
  if (permissionToolCall) {
    return {
      kind: "permission_request",
      content: getToolTitle(permissionToolCall),
      metadata: record,
    };
  }

  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : typeof record.message === "string"
          ? record.message
          : "";

  if (method.includes("permission") || type.includes("permission")) {
    return {
      kind: "permission_request",
      content: content || "Agent requested permission.",
      metadata: record,
    };
  }
  if (type.includes("tool") || record.tool || record.name) {
    return {
      kind: "tool_call",
      content: content || String(record.name || record.tool || "Tool call"),
      metadata: record,
    };
  }
  if (type.includes("thought") || type.includes("reason")) {
    return { kind: "thought", content, metadata: record };
  }
  if (content) {
    return { kind: "assistant_chunk", content, metadata: record };
  }
  if (record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    if (typeof result.stopReason === "string") {
      return {
        kind: "status",
        content: `Agent turn finished: ${result.stopReason}`,
        metadata: record,
      };
    }
    if (result.protocolVersion) {
      return {
        kind: "status",
        content: "Agent protocol initialized",
        metadata: record,
      };
    }
    if (result.models || result.modes) {
      return {
        kind: "status",
        content: "Agent session metadata loaded",
        metadata: record,
      };
    }
    return {
      kind: "status",
      content: "Agent protocol response",
      metadata: record,
    };
  }
  if (method || type) {
    return {
      kind: "status",
      content: method || type || "Agent protocol message",
      metadata: record,
    };
  }
  return null;
}

export function getReadableAssistantChunkFromEvent(event: AgentEventLike) {
  const classified = classifyAgentProtocolEvent(event.metadata);
  if (event.kind === "assistant_chunk") {
    return event.content || classified?.content || "";
  }
  return classified?.kind === "assistant_chunk" ? classified.content : "";
}

export function extractReadableAgentOutput(output: string) {
  const chunks: string[] = [];
  const fallbackLines: string[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const parsed = safeJsonParse(line);
    const record = getProtocolRecord(parsed);
    if (!record) {
      fallbackLines.push(line);
      continue;
    }
    const update = getProtocolSessionUpdate(record);
    if (update?.sessionUpdate === "agent_message_chunk") {
      chunks.push(getProtocolText(update.content));
      continue;
    }
    const classified = classifyAgentProtocolEvent(record);
    if (classified?.kind === "assistant_chunk" && classified.content) {
      chunks.push(classified.content);
    }
  }
  const text = chunks.join("").trim();
  if (text) {
    return text;
  }
  return fallbackLines.join("\n").trim();
}

export function extractReadableMessageContent(content: string) {
  if (!looksLikeJsonProtocolDump(content)) {
    return content;
  }
  return extractReadableAgentOutput(content) || "";
}

export function looksLikeJsonProtocolDump(content: string) {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  return (
    trimmed.includes('"jsonrpc"') ||
    trimmed.includes('"session/update"') ||
    trimmed.includes('"sessionUpdate"')
  );
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function buildAgentToolCallItems(
  events: AgentEventLike[]
): AgentToolCallItem[] {
  const byId = new Map<string, AgentToolCallItem>();

  for (const event of events) {
    const update = getToolUpdateFromEvent(event);
    if (!update) {
      continue;
    }
    const toolId = getToolCallId(update) || event.id;
    const existing = byId.get(toolId);
    const input = getToolInput(update);
    const output = getToolOutput(update);

    // Extract terminal output delta if present
    const meta = getNestedRecord(update, "_meta");
    const terminalDelta = meta
      ? getNestedRecord(meta, "terminal_output_delta")
      : null;
    const deltaData = terminalDelta ? String(terminalDelta.data || "") : "";

    let nextOutput = existing?.output;
    const appendOutput = shouldAppendToolOutput(update);
    if (deltaData) {
      nextOutput = appendToolOutput(existing?.output, deltaData);
    } else if (hasToolValue(output)) {
      if (appendOutput) {
        nextOutput = appendToolOutput(existing?.output, output);
      } else if (typeof existing?.output === "string" && existing.output.trim()) {
        // If we already have terminal output and the new output is just exit_code, append it or keep the terminal output
        if (output && typeof output === "object") {
          const outRecord = output as Record<string, unknown>;
          if (
            (typeof outRecord.exitCode === "number" ||
              typeof outRecord.exit_code === "number") &&
            Object.keys(outRecord).length <= 2
          ) {
            const code = outRecord.exitCode ?? outRecord.exit_code;
            nextOutput = `${existing.output}\n\nCommand exited with code ${code}`;
          } else {
            nextOutput = output;
          }
        } else {
          nextOutput = output;
        }
      } else {
        nextOutput = output;
      }
    }

    const nextStatus = mergeToolStatus(existing?.status, getToolStatus(update));
    const next: AgentToolCallItem = {
      id: toolId,
      title: getToolCardTitle(update, event.content, existing?.title),
      status: nextStatus,
      kind: getToolKind(update) ?? existing?.kind,
      input: hasToolValue(input) ? input : existing?.input,
      output: nextOutput,
      terminalId: getToolTerminalId(update) ?? existing?.terminalId,
      createdAt: existing?.createdAt ?? event.createdAt,
      completedAt: getToolCompletionTime(update, event.createdAt) ?? existing?.completedAt,
    };
    byId.set(toolId, next);
  }

  return Array.from(byId.values()).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

function isTerminalToolStatus(status: unknown) {
  return status === "completed" || status === "success" || status === "failed" || status === "error";
}

function mergeToolStatus(existing?: string, incoming?: string) {
  if (isTerminalToolStatus(existing) && !isTerminalToolStatus(incoming)) {
    return existing;
  }
  return incoming ?? existing;
}

function getToolUpdateFromEvent(
  event: AgentEventLike
): Record<string, unknown> | null {
  const classified = classifyAgentProtocolEvent(event.metadata);
  if (
    classified?.kind === "tool_call" ||
    classified?.kind === "permission_request"
  ) {
    const classifiedUpdate =
      getProtocolSessionUpdate(classified.metadata) ??
      getPermissionToolCall(classified.metadata) ??
      getProtocolRecord(classified.metadata);
    if (classifiedUpdate) {
      return normalizeToolUpdate(classifiedUpdate);
    }
  }

  const sessionUpdate = getProtocolSessionUpdate(event.metadata);
  const sessionUpdateName = String(sessionUpdate?.sessionUpdate || "");
  if (
    sessionUpdate &&
    (sessionUpdateName === "tool_call" ||
      sessionUpdateName === "tool_call_update" ||
      sessionUpdateName.includes("tool"))
  ) {
    return normalizeToolUpdate(sessionUpdate);
  }

  const permissionToolCall = getPermissionToolCall(event.metadata);
  if (permissionToolCall) {
    return normalizeToolUpdate(permissionToolCall);
  }

  if (event.kind === "tool_call" || event.kind === "permission_request") {
    const direct = getProtocolRecord(event.metadata);
    if (direct) {
      const nestedDirect =
        getProtocolSessionUpdate(direct) ??
        getPermissionToolCall(direct) ??
        getNestedRecord(direct, "toolCall") ??
        getNestedRecord(direct, "tool_call");
      return normalizeToolUpdate(nestedDirect ?? direct);
    }
    if (event.content) {
      return normalizeToolUpdate({
        id: event.id,
        status: "completed",
        title: event.content,
      });
    }
  }

  return null;
}

function normalizeToolUpdate(record: Record<string, unknown>) {
  const toolCallId = record.toolCallId || record.tool_call_id;
  return {
    ...record,
    ...(toolCallId ? { toolCallId, tool_call_id: toolCallId } : {}),
  };
}

function getToolCallId(record: Record<string, unknown> | null) {
  if (!record) {
    return "";
  }
  return String(record.toolCallId || record.tool_call_id || record.id || "");
}

function getToolCardTitle(
  record: Record<string, unknown> | null,
  fallback: string,
  existingTitle?: string
) {
  if (!record) {
    return existingTitle || fallback || "工具调用";
  }
  return String(
    record.title ||
      record.name ||
      record.toolName ||
      record.tool ||
      existingTitle ||
      fallback ||
      displayToolKindForTitle(getToolKind(record)) ||
      "工具调用"
  );
}

function displayToolKindForTitle(kind?: string) {
  switch (kind) {
    case "execute":
      return "命令执行";
    case "edit":
      return "文件编辑";
    case "read":
      return "文件读取";
    default:
      return kind || "";
  }
}

function getToolStatus(record: Record<string, unknown> | null) {
  if (!record) {
    return undefined;
  }
  const status = record.status || record.state;
  return typeof status === "string" ? status : undefined;
}

function getToolCompletionTime(
  record: Record<string, unknown> | null,
  eventCreatedAt: string
) {
  const status = getToolStatus(record);
  if (status === "completed" || status === "success" || status === "failed" || status === "error") {
    return eventCreatedAt;
  }
  if (hasToolValue(getToolOutput(record))) {
    return eventCreatedAt;
  }
  return undefined;
}

function shouldAppendToolOutput(record: Record<string, unknown> | null) {
  if (!record) {
    return false;
  }
  if (
    record.append === true ||
    record.isDelta === true ||
    record.is_delta === true
  ) {
    return true;
  }
  return hasToolValue(record.outputDelta) ||
    hasToolValue(record.output_delta) ||
    hasToolValue(record.rawOutputDelta) ||
    hasToolValue(record.raw_output_delta);
}

function getToolKind(record: Record<string, unknown> | null) {
  if (!record) {
    return undefined;
  }
  const kind = record.kind || record.type;
  return typeof kind === "string" ? kind : undefined;
}

function getToolTerminalId(record: Record<string, unknown> | null) {
  if (!record) {
    return undefined;
  }
  const meta = getNestedRecord(record, "_meta");
  const terminalInfo = meta ? getNestedRecord(meta, "terminal_info") : null;
  const terminalDelta = meta
    ? getNestedRecord(meta, "terminal_output_delta")
    : null;
  const terminalExit = meta ? getNestedRecord(meta, "terminal_exit") : null;
  const direct =
    record.terminalId ??
    record.terminal_id ??
    terminalInfo?.terminal_id ??
    terminalInfo?.terminalId ??
    terminalDelta?.terminal_id ??
    terminalDelta?.terminalId ??
    terminalExit?.terminal_id ??
    terminalExit?.terminalId;
  if (typeof direct === "string" && direct) {
    return direct;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const contentRecord = getProtocolRecord(item);
      const terminalId =
        contentRecord?.terminalId ?? contentRecord?.terminal_id;
      if (typeof terminalId === "string" && terminalId) {
        return terminalId;
      }
    }
  }
  return undefined;
}

function getToolInput(record: Record<string, unknown> | null): unknown {
  if (!record) {
    return undefined;
  }
  const explicitInput =
    record.rawInput ??
    record.raw_input ??
    record.input ??
    record.args ??
    record.arguments ??
    record.command ??
    record.params;
  if (hasToolValue(explicitInput)) {
    return explicitInput;
  }

  const locations = normalizeToolLocations(record.locations);
  if (locations) {
    return locations.length === 1
      ? { path: locations[0] }
      : { paths: locations };
  }

  const titleInput = parseToolTitleInput(record.title);
  if (titleInput) {
    return titleInput;
  }

  return undefined;
}

function normalizeToolLocations(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  const paths = value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = getProtocolRecord(item);
      return typeof record?.path === "string" ? record.path : "";
    })
    .filter(Boolean);
  return paths.length ? paths : null;
}

function parseToolTitleInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  const searchMatch = value.match(/^Search for '(.+)' in (.+)$/);
  if (searchMatch) {
    return { query: searchMatch[1], path: searchMatch[2] };
  }
  return undefined;
}

function getToolOutput(record: Record<string, unknown> | null): unknown {
  if (!record) {
    return undefined;
  }
  for (const key of [
    "rawOutputDelta",
    "raw_output_delta",
    "outputDelta",
    "output_delta",
    "rawOutput",
    "raw_output",
    "output",
    "result",
  ]) {
    const output = simplifyToolOutput(record[key]);
    if (hasToolValue(output)) {
      return output;
    }
  }

  const content = simplifyToolOutput(record.content);
  if (isToolResultContent(content)) {
    return content;
  }
  return undefined;
}

function isToolResultContent(value: unknown) {
  if (!hasToolValue(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value !== "object") {
    return true;
  }
  const record = value as Record<string, unknown>;
  return !(record.type === "terminal" || record.terminalId);
}

function simplifyToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const simplified = value.map(simplifyToolOutput).filter(hasToolValue);
    if (simplified.every((item) => typeof item === "string")) {
      return simplified.join("\n");
    }
    return simplified.length ? simplified : undefined;
  }
  const record = getProtocolRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.formatted_output === "string") {
    return record.formatted_output || undefined;
  }
  if (typeof record.formattedOutput === "string") {
    return record.formattedOutput || undefined;
  }
  if (record.content === "[read output suppressed]") {
    return undefined;
  }
  if (record.type === "terminal" || record.terminalId) {
    return undefined;
  }
  if (record.type === "content" && record.content) {
    return simplifyToolOutput(record.content);
  }
  if (record.type === "text" || typeof record.text === "string") {
    return getProtocolText(record);
  }
  if (record.type === "diff") {
    return {
      kind:
        record._meta && typeof record._meta === "object"
          ? (record._meta as Record<string, unknown>).kind
          : undefined,
      newText: typeof record.newText === "string" ? record.newText : null,
      oldText: typeof record.oldText === "string" ? record.oldText : null,
      path: record.path,
      type: "diff",
    };
  }
  if (typeof record.output === "string") {
    return record.output;
  }
  if (typeof record.result === "string") {
    return record.result;
  }
  if (typeof record.error === "string") {
    return record.error;
  }
  if (
    typeof record.exit_code === "number" ||
    typeof record.exitCode === "number"
  ) {
    return record;
  }
  if (
    record.content === "[read output suppressed]" &&
    Object.keys(record).length === 1
  ) {
    return undefined;
  }
  return record;
}

function appendToolOutput(existing: unknown, delta: unknown) {
  const existingText = toolOutputText(existing);
  const deltaText = toolOutputText(delta);
  if (!existingText) {
    return hasToolValue(deltaText) ? deltaText : delta;
  }
  if (!deltaText) {
    return existing;
  }
  return existingText + deltaText;
}

function toolOutputText(value: unknown): string {
  const simplified = simplifyToolOutput(value);
  if (typeof simplified === "string") {
    return simplified;
  }
  if (!hasToolValue(simplified)) {
    return "";
  }
  try {
    return JSON.stringify(simplified, null, 2);
  } catch {
    return String(simplified);
  }
}

export function hasToolValue(value: unknown) {
  return !(
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function extractAgentModelsFromEvents(
  events: AgentEventLike[]
): AgentModelList {
  const sorted = [...events].sort((left, right) => right.seq - left.seq);
  for (const event of sorted) {
    const models = getModelsRecordFromMetadata(event.metadata);
    if (!models) {
      continue;
    }
    const normalized = normalizeAgentModelList(models);
    if (normalized.models.length > 0) {
      return normalized;
    }
  }
  return { models: [] };
}

export function extractAgentConfigOptionsFromEvents(
  events: AgentEventLike[]
): AgentConfigOption[] {
  const sorted = [...events].sort((left, right) => right.seq - left.seq);
  for (const event of sorted) {
    const options = getConfigOptionsFromMetadata(event.metadata);
    if (options.length > 0) {
      return options;
    }
  }
  return [];
}

export function extractAgentModelsFromStatus(value: unknown): AgentModelList {
  const record = getProtocolRecord(value);
  if (!record) {
    return { models: [] };
  }

  const directModels = getModelsRecordFromMetadata(record);
  if (directModels) {
    return normalizeAgentModelList(directModels);
  }

  const availableModels = Array.isArray(record.availableModels)
    ? record.availableModels
    : Array.isArray(record.available_models)
      ? record.available_models
      : [];
  if (availableModels.length === 0) {
    return { models: [] };
  }

  const currentModelId =
    typeof record.model === "string"
      ? record.model
      : typeof record.currentModelId === "string"
        ? record.currentModelId
        : typeof record.current_model_id === "string"
          ? record.current_model_id
          : undefined;

  return normalizeAgentModelList({
    availableModels,
    currentModelId,
  });
}

function getConfigOptionsFromMetadata(
  metadata: Record<string, unknown> | undefined
): AgentConfigOption[] {
  const record = getProtocolRecord(metadata);
  const result = record ? getNestedRecord(record, "result") : null;
  const resultOptions = normalizeAgentConfigOptions(
    result?.configOptions ?? result?.config_options
  );
  if (resultOptions.length > 0) {
    return resultOptions;
  }
  return normalizeAgentConfigOptions(record?.configOptions ?? record?.config_options);
}

function getModelsRecordFromMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  const record = getProtocolRecord(metadata);
  const result = record ? getNestedRecord(record, "result") : null;
  const resultModels = result ? getNestedRecord(result, "models") : null;
  if (resultModels) {
    return resultModels;
  }
  const resultConfigModel = getModelConfigOption(result);
  if (resultConfigModel) {
    return resultConfigModel;
  }
  const directModels = record ? getNestedRecord(record, "models") : null;
  if (directModels) {
    return directModels;
  }
  if (
    record &&
    (Array.isArray(record.availableModels) ||
      Array.isArray(record.available_models))
  ) {
    return {
      availableModels: Array.isArray(record.availableModels)
        ? record.availableModels
        : record.available_models,
      currentModelId:
        typeof record.model === "string"
          ? record.model
          : typeof record.currentModelId === "string"
            ? record.currentModelId
            : record.current_model_id,
    };
  }
  const acpx = record ? getNestedRecord(record, "acpx") : null;
  if (acpx && Array.isArray(acpx.available_models)) {
    return {
      availableModels: acpx.available_models,
      currentModelId: acpx.current_model_id,
    };
  }
  const configModel = getModelConfigOption(record);
  if (configModel) {
    return configModel;
  }
  return null;
}

function normalizeAgentConfigOptions(value: unknown): AgentConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeAgentConfigOption)
    .filter((option): option is AgentConfigOption => Boolean(option));
}

function normalizeAgentConfigOption(value: unknown): AgentConfigOption | null {
  const record = getProtocolRecord(value);
  if (!record) {
    return null;
  }
  const id = String(record.id || record.configId || record.config_id || "").trim();
  if (!id) {
    return null;
  }
  const options = Array.isArray(record.options)
    ? record.options
    : Array.isArray(record.availableValues)
      ? record.availableValues
      : Array.isArray(record.available_values)
        ? record.available_values
        : [];
  const normalizedOptions = options
    .map(normalizeAgentConfigOptionChoice)
    .filter((option): option is AgentConfigOptionChoice => Boolean(option));
  if (normalizedOptions.length === 0) {
    return null;
  }
  return {
    category: typeof record.category === "string" ? record.category : undefined,
    currentValue:
      typeof record.currentValue === "string"
        ? record.currentValue
        : typeof record.current_value === "string"
          ? record.current_value
          : normalizedOptions[0].id,
    description: typeof record.description === "string" ? record.description : undefined,
    id,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof record.label === "string"
          ? record.label
          : id,
    options: normalizedOptions,
  };
}

function normalizeAgentConfigOptionChoice(value: unknown): AgentConfigOptionChoice | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, name: id } : null;
  }
  const record = getProtocolRecord(value);
  if (!record) {
    return null;
  }
  const id = String(record.id || record.value || record.name || "").trim();
  if (!id) {
    return null;
  }
  return {
    description: typeof record.description === "string" ? record.description : undefined,
    id,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof record.label === "string"
          ? record.label
          : id,
  };
}

function getModelConfigOption(
  record: Record<string, unknown> | null
): Record<string, unknown> | null {
  const configOptions = record && Array.isArray(record.configOptions)
    ? record.configOptions
    : record && Array.isArray(record.config_options)
      ? record.config_options
      : [];
  for (const option of configOptions) {
    const optionRecord = getProtocolRecord(option);
    if (!optionRecord) {
      continue;
    }
    const category = String(optionRecord.category || "").toLowerCase();
    const id = String(optionRecord.id || optionRecord.configId || optionRecord.config_id || "");
    if (category === "model" || id === "model") {
      return optionRecord;
    }
  }
  return null;
}

function normalizeAgentModelList(
  models: Record<string, unknown>
): AgentModelList {
  const availableModels = Array.isArray(models.availableModels)
    ? models.availableModels
    : Array.isArray(models.available_models)
      ? models.available_models
      : Array.isArray(models.options)
        ? models.options
        : [];
  const normalized = availableModels
    .map(normalizeAgentModelInfo)
    .filter((model): model is AgentModelInfo => Boolean(model));
  if (normalized.length === 0) {
    return { models: [] };
  }

  const currentModelId =
    typeof models.currentModelId === "string"
      ? models.currentModelId
      : typeof models.current_model_id === "string"
        ? models.current_model_id
        : typeof models.currentValue === "string"
          ? models.currentValue
          : typeof models.current_value === "string"
            ? models.current_value
            : normalized[0].id;

  return { currentModelId, models: normalized };
}

function normalizeAgentModelInfo(value: unknown): AgentModelInfo | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, name: id } : null;
  }
  const record = getProtocolRecord(value);
  if (!record) {
    return null;
  }
  const id = String(
    record.modelId ||
      record.model_id ||
      record.id ||
      record.value ||
      record.name ||
      ""
  ).trim();
  if (!id) {
    return null;
  }
  return {
    description:
      typeof record.description === "string" ? record.description : undefined,
    id,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof record.label === "string"
          ? record.label
          : id,
  };
}
