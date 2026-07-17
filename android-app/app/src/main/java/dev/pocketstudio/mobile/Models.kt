package dev.pocketstudio.mobile

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable data class Workspace(val id: String, val name: String, val path: String)
@Serializable data class AgentCapability(val name: String, val label: String)
data class TerminalOption(val value: String, val label: String, val title: String, val command: String)
data class StudioTerminal(val id: String, val title: String, val type: String, val command: String, val path: String)
data class ChatAttachment(val type: String = "image", val name: String, val path: String, val mimeType: String)
data class ProjectContent(val conversations: List<TaskRecord>, val terminals: List<StudioTerminal>)
@Serializable data class Device(
    val id: String, val name: String, val status: String = "online",
    val agents: List<AgentCapability> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    @SerialName("last_seen_at") val lastSeenAt: Long = 0,
)
@Serializable data class TaskRecord(
    @SerialName("task_id") val taskId: String,
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("workspace_path") val workspacePath: String = "",
    val agent: String = "",
    @SerialName("agent_runtime") val agentRuntime: String = "",
    @SerialName("terminal_type") val terminalType: String = "bash",
    @SerialName("session_name") val sessionName: String = "",
    @SerialName("session_id") val sessionId: String = "",
    val importHistory: Boolean = false,
    val prompt: String = "", val status: String = "",
    @SerialName("updated_at") val updatedAt: Long = 0,
)
@Serializable data class ServerState(
    val devices: List<Device> = emptyList(),
    val tasks: List<TaskRecord> = emptyList(),
)
@Serializable data class Project(
    val id: String, val name: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("workspace_path") val workspacePath: String,
)
@Serializable data class TaskEvent(
    @SerialName("task_id") val taskId: String,
    @SerialName("event_id") val eventId: String,
    @SerialName("event_type") val eventType: String,
    val source: String = "", val sequence: Long = 0,
    val timestamp: Long = 0, val data: JsonElement? = null, val raw: JsonElement? = null,
)

data class ConnectionProfile(val serverUrl: String = "", val token: String = "")
data class ChatItem(
    val id: String,
    val role: String,
    val text: String,
    val kind: String = "message",
    val title: String = "",
    val turnIndex: Long = Long.MAX_VALUE,
    val logicalSequence: Long = Long.MAX_VALUE,
    val timestamp: Long = Long.MAX_VALUE,
)
enum class Screen { Login, Devices, Projects, Conversations, Chat, Terminal }

data class AppState(
    val screen: Screen = Screen.Login,
    val profile: ConnectionProfile = ConnectionProfile(),
    val serverState: ServerState = ServerState(),
    val projects: List<Project> = emptyList(),
    val projectConversations: List<TaskRecord> = emptyList(),
    val projectTerminals: List<StudioTerminal> = emptyList(),
    val selectedDevice: Device? = null,
    val selectedProject: Project? = null,
    val selectedTask: TaskRecord? = null,
    val selectedTerminal: StudioTerminal? = null,
    val taskEvents: List<TaskEvent> = emptyList(),
    val chatItems: List<ChatItem> = emptyList(),
    val loading: Boolean = false,
    val connected: Boolean = false,
    val running: Boolean = false,
    val chatFontSize: Float = 14f,
    val terminalOutput: String = "",
    val error: String = "",
)

private val TerminalOptions = listOf(
    TerminalOption("bash", "普通终端", "Shell", ""),
    TerminalOption("claude", "Claude Code", "Claude Code", "claude"),
    TerminalOption("codex", "Codex", "Codex", "codex"),
    TerminalOption("opencode", "OpenCode", "OpenCode", "opencode"),
    TerminalOption("kilo", "Kilo Code", "Kilo Code", "kilo"),
    TerminalOption("pi", "Pi", "Pi", "pi"),
    TerminalOption("agy", "Antigravity", "Antigravity", "agy"),
    TerminalOption("qwen", "Qwen Code", "Qwen Code", "qwen"),
    TerminalOption("kimi", "Kimi", "Kimi", "kimi"),
    TerminalOption("copilot", "GitHub Copilot", "GitHub Copilot", "copilot"),
    TerminalOption("cursor", "Cursor Agent", "Cursor Agent", "cursor-agent"),
    TerminalOption("openclaw", "OpenClaw", "OpenClaw", "openclaw"),
)

internal fun availableTerminalOptions(device: Device?): List<TerminalOption> {
    val capabilities = device?.agents.orEmpty().map { capabilityName(it.name) }.toSet()
    return TerminalOptions.filter { option -> option.value == "bash" || capabilityName(option.value) in capabilities }
}

private fun capabilityName(value: String): String = when (val name = value.trim().lowercase().replace("_", "-")) {
    "claude-code" -> "claude"
    "kilo", "kilo-code" -> "kilocode"
    "agy" -> "antigravity"
    "cursor-agent" -> "cursor"
    "github-copilot" -> "copilot"
    "open-claw" -> "openclaw"
    else -> name
}
