package dev.pocketstudio.mobile

import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID
import java.util.concurrent.TimeUnit

class PocketApi {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()

    private fun request(profile: ConnectionProfile, path: String) = Request.Builder()
        .url(profile.serverUrl.trimEnd('/') + path)
        .header("Authorization", "Bearer ${profile.token}")
        .build()

    fun state(profile: ConnectionProfile): ServerState = client.newCall(request(profile, "/api/state"))
        .execute().use { response -> decode(response) }

    fun projects(profile: ConnectionProfile): List<Project> = client.newCall(request(profile, "/api/project/list"))
        .execute().use { response -> decode(response) }

    fun projectConversations(profile: ConnectionProfile, project: Project, tasks: List<TaskRecord>): List<TaskRecord> {
        return projectContent(profile, project, tasks).conversations
    }

    fun projectContent(profile: ConnectionProfile, project: Project, tasks: List<TaskRecord>): ProjectContent {
        val state = client.newCall(request(profile, "/api/project/state?project_id=${project.id}"))
            .execute().use { response -> decode<JsonElement>(response) }
        return ProjectContent(projectConversationsFromState(state, project, tasks), projectTerminalsFromState(state, project))
    }

    fun createProjectConversation(profile: ConnectionProfile, project: Project, task: TaskRecord) {
        updateProjectState(profile, project) { state -> addAgentChatToProjectState(state, project, task) }
    }

    fun createProjectTerminal(profile: ConnectionProfile, project: Project, option: TerminalOption): StudioTerminal {
        val terminal = StudioTerminal("term-${UUID.randomUUID()}", option.title, option.value, option.command, project.workspacePath)
        updateProjectState(profile, project) { state -> addTerminalToProjectState(state, project, option, terminal.id) }
        return terminal
    }

    fun writeProjectFile(profile: ConnectionProfile, project: Project, path: String, content: String) {
        val body = buildJsonObject {
            put("project_id", project.id)
            put("path", path)
            put("content", content)
        }.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        client.newCall(request(profile, "/api/project/file/write").newBuilder().post(body).build()).execute().use { response ->
            val result = decode<JsonElement>(response)
            val error = (result as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull
            if (!error.isNullOrBlank()) throw IllegalStateException(error)
        }
    }

    private fun updateProjectState(profile: ConnectionProfile, project: Project, transform: (JsonObject) -> JsonObject) {
        val state = client.newCall(request(profile, "/api/project/state?project_id=${project.id}"))
            .execute().use { response -> decode<JsonElement>(response).jsonObject }
        val body = buildJsonObject {
            put("project_id", project.id)
            put("state", transform(state))
        }.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        val saveRequest = request(profile, "/api/project/state").newBuilder().post(body).build()
        client.newCall(saveRequest).execute().use { response ->
            if (!response.isSuccessful) decode<JsonElement>(response)
        }
    }

    private inline fun <reified T> decode(response: Response): T {
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) throw IllegalStateException(if (response.code == 401 || response.code == 403) "Token 无效" else body.ifBlank { "Server 返回 ${response.code}" })
        return json.decodeFromString(body)
    }

    fun openAgentSocket(
        profile: ConnectionProfile,
        project: Project,
        taskId: String,
        listener: WebSocketListener,
    ): WebSocket {
        val url = agentWebSocketRequestUrl(profile, project, taskId)
        return client.newWebSocket(Request.Builder().url(url).build(), listener)
    }

    fun terminalWebSocketRequestUrl(profile: ConnectionProfile, project: Project, terminal: StudioTerminal): HttpUrl =
        "${profile.serverUrl.trimEnd('/')}/ws/terminal".toHttpUrl().newBuilder()
            .addQueryParameter("project_id", project.id).addQueryParameter("terminal_id", terminal.id)
            .addQueryParameter("command", terminal.command).addQueryParameter("path", terminal.path)
            .addQueryParameter("token", profile.token).build()

    fun envelope(type: String, deviceId: String, payload: JsonObject): String = buildJsonObject {
        put("id", "msg-${UUID.randomUUID()}"); put("type", type); put("version", 1)
        put("timestamp", System.currentTimeMillis() / 1000); put("from", "web")
        putJsonObject("to") { put("device_id", deviceId) }; put("payload", payload)
    }.toString()

    internal fun agentWebSocketRequestUrl(profile: ConnectionProfile, project: Project, taskId: String): HttpUrl =
        "${profile.serverUrl.trimEnd('/')}/ws/agent".toHttpUrl().newBuilder()
            .addQueryParameter("project_id", project.id)
            .addQueryParameter("task_id", taskId)
            .addQueryParameter("token", profile.token)
            .build()

    internal fun projectConversationsFromState(state: JsonElement, project: Project, tasks: List<TaskRecord>): List<TaskRecord> {
        val taskById = tasks.associateBy { it.taskId }
        val tabs = mutableListOf<JsonObject>()
        fun visit(element: JsonElement?) {
            when (element) {
                is JsonArray -> element.forEach(::visit)
                is JsonObject -> {
                    if (element["kind"]?.jsonPrimitive?.contentOrNull == "agent_chat") tabs += element
                    element.values.forEach(::visit)
                }
                else -> Unit
            }
        }
        visit(state.jsonObject["layoutTree"])
        return tabs.mapNotNull { tab ->
            val taskId = tab["agentSessionId"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            if (taskId.isEmpty()) return@mapNotNull null
            val metadata = taskById[taskId]
            val title = tab["title"]?.jsonPrimitive?.contentOrNull
                ?: tab["agentSessionName"]?.jsonPrimitive?.contentOrNull
                ?: metadata?.sessionName
                ?: taskId
            TaskRecord(
                taskId = taskId,
                deviceId = project.deviceId,
                workspacePath = project.workspacePath,
                agent = tab["agentKind"]?.jsonPrimitive?.contentOrNull ?: metadata?.agent.orEmpty(),
                agentRuntime = "direct_acp",
                terminalType = tab["termType"]?.jsonPrimitive?.contentOrNull ?: metadata?.terminalType ?: "bash",
                sessionName = title,
                sessionId = tab["agentResumeSessionId"]?.jsonPrimitive?.contentOrNull ?: metadata?.sessionId.orEmpty(),
                importHistory = tab["agentImportHistory"]?.jsonPrimitive?.booleanOrNull == true,
                prompt = metadata?.prompt.orEmpty(),
                status = metadata?.status.orEmpty(),
                updatedAt = metadata?.updatedAt ?: 0,
            )
        }.distinctBy { it.taskId }
    }

    internal fun projectTerminalsFromState(state: JsonElement, project: Project): List<StudioTerminal> {
        val result = mutableListOf<StudioTerminal>()
        fun visit(element: JsonElement?) {
            when (element) {
                is JsonArray -> element.forEach(::visit)
                is JsonObject -> {
                    if (element["kind"]?.jsonPrimitive?.contentOrNull == "terminal") {
                        val id = element["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        if (id.isNotBlank()) result += StudioTerminal(
                            id, element["title"]?.jsonPrimitive?.contentOrNull ?: "Shell",
                            element["termType"]?.jsonPrimitive?.contentOrNull ?: "bash",
                            element["activeCommand"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                            element["filePath"]?.jsonPrimitive?.contentOrNull ?: project.workspacePath,
                        )
                    }
                    element.values.forEach(::visit)
                }
                else -> Unit
            }
        }
        visit(state.jsonObject["layoutTree"])
        return result.distinctBy { it.id }
    }

    internal fun addAgentChatToProjectState(state: JsonObject, project: Project, task: TaskRecord): JsonObject {
        val tabId = "chat-${UUID.randomUUID()}"
        val tab = buildJsonObject {
            put("id", tabId); put("kind", "agent_chat"); put("title", task.sessionName)
            put("termType", "bash"); put("activeCommand", ""); put("titleSource", "initial")
            put("agentKind", task.agent); put("agentSessionId", task.taskId)
            put("agentRuntime", "direct_acp"); put("agentImportHistory", false)
            put("projectId", project.id); put("filePath", project.workspacePath)
        }
        return appendTabToProjectState(state, tab)
    }

    internal fun addTerminalToProjectState(state: JsonObject, project: Project, option: TerminalOption, tabId: String = "term-${UUID.randomUUID()}"): JsonObject {
        val tab = buildJsonObject {
            put("id", tabId); put("kind", "terminal"); put("title", option.title)
            put("termType", option.value); put("activeCommand", option.command); put("titleSource", "initial")
            put("projectId", project.id); put("filePath", project.workspacePath)
        }
        return appendTabToProjectState(state, tab)
    }

    private fun appendTabToProjectState(state: JsonObject, tab: JsonObject): JsonObject {
        val tabId = tab.getValue("id").jsonPrimitive.content
        fun append(element: JsonElement): Pair<JsonElement, Boolean> {
            val node = element as? JsonObject ?: return element to false
            if (node["type"]?.jsonPrimitive?.contentOrNull == "panel") {
                val tabs = node["tabs"]?.jsonArray ?: JsonArray(emptyList())
                return JsonObject(node + mapOf("tabs" to JsonArray(tabs + tab), "activeTabId" to JsonPrimitive(tabId))) to true
            }
            val children = node["children"] as? JsonArray ?: return element to false
            var inserted = false
            val nextChildren = children.map { child ->
                if (inserted) child else append(child).also { inserted = it.second }.first
            }
            return JsonObject(node + ("children" to JsonArray(nextChildren))) to inserted
        }
        val layout = state["layoutTree"]
        val (nextLayout, inserted) = layout?.let(::append) ?: (JsonNull to false)
        val finalLayout = if (inserted) nextLayout else buildJsonObject {
            put("type", "panel"); put("id", "panel-${UUID.randomUUID()}")
            put("tabs", JsonArray(listOf(tab))); put("activeTabId", tabId); put("focus", true)
        }
        return JsonObject(state + ("layoutTree" to finalLayout))
    }
}
