package dev.pocketstudio.mobile

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import okhttp3.*
import java.io.ByteArrayOutputStream
import java.util.UUID

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val api = PocketApi()
    private val store = ProfileStore(application)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(AppState(profile = store.load(), chatFontSize = store.loadChatFontSize()))
    val state = _state.asStateFlow()
    private var socket: WebSocket? = null
    private val pendingMessages = mutableListOf<String>()
    private val loadingChatImagePaths = mutableSetOf<String>()

    init {
        val profile = _state.value.profile
        if (profile.serverUrl.isNotBlank() && profile.token.isNotBlank()) login()
    }

    fun updateProfile(server: String, token: String) = update { copy(profile = ConnectionProfile(server, token), error = "") }
    fun setChatFontSize(value: Float) {
        store.saveChatFontSize(value)
        update { copy(chatFontSize = value.coerceIn(12f, 20f)) }
    }

    fun login() = launchNetwork {
        val profile = _state.value.profile.copy(serverUrl = normalizeServer(_state.value.profile.serverUrl))
        require(profile.serverUrl.isNotBlank() && profile.token.isNotBlank()) { "请填写 Server 地址和 Token" }
        val serverState = api.state(profile)
        val projects = api.projects(profile)
        store.save(profile)
        update { copy(screen = Screen.Devices, profile = profile, serverState = serverState, projects = projects, loading = false) }
    }

    fun refresh() = launchNetwork {
        val serverState = api.state(_state.value.profile)
        val projects = api.projects(_state.value.profile)
        val selectedProject = _state.value.selectedProject
        val content = if (selectedProject != null) api.projectContent(_state.value.profile, selectedProject, serverState.tasks) else null
        update { copy(serverState = serverState, projects = projects, projectConversations = content?.conversations ?: projectConversations, projectTerminals = content?.terminals ?: projectTerminals, loading = false) }
    }

    fun selectDevice(device: Device) = update { copy(screen = Screen.Projects, selectedDevice = device, selectedProject = null) }
    fun selectProject(project: Project) {
        update { copy(screen = Screen.Conversations, selectedProject = project, selectedTask = null, selectedTerminal = null, projectConversations = emptyList(), projectTerminals = emptyList(), chatImageData = emptyMap()) }
        launchNetwork {
            val content = api.projectContent(_state.value.profile, project, _state.value.serverState.tasks)
            update { copy(projectConversations = content.conversations, projectTerminals = content.terminals, loading = false) }
        }
    }

    fun openConversation(task: TaskRecord) {
        update { copy(screen = Screen.Chat, selectedTask = task, taskEvents = emptyList(), chatItems = emptyList(), chatImageData = emptyMap(), loading = true, error = "") }
        connect(task)
    }

    fun newTerminal(option: TerminalOption) {
        val project = _state.value.selectedProject ?: return
        update { copy(loading = true, error = "") }
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { api.createProjectTerminal(_state.value.profile, project, option) } }
                .onSuccess { terminal -> update { copy(projectTerminals = projectTerminals + terminal, loading = false) }; openTerminal(terminal) }
                .onFailure { update { copy(loading = false, error = "创建终端失败：${it.message.orEmpty()}") } }
        }
    }

    fun openTerminal(terminal: StudioTerminal) {
        socket?.close(1000, "switch to terminal")
        update { copy(screen = Screen.Terminal, selectedTerminal = terminal, terminalOutput = "", connected = false, loading = true, error = "") }
    }

    fun terminalOpened() = update { copy(connected = true, loading = false, error = "") }
    fun terminalClosed() = update { copy(connected = false, loading = false) }
    fun terminalError(message: String) = update { copy(connected = false, loading = false, error = message) }
    fun terminalUrl(): String {
        val project = _state.value.selectedProject ?: return ""
        val terminal = _state.value.selectedTerminal ?: return ""
        return api.terminalWebSocketRequestUrl(_state.value.profile, project, terminal).toString()
            .replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
    }

    fun uploadTerminalImage(uri: Uri, onUploaded: (String) -> Unit) {
        val current = _state.value
        val terminal = current.selectedTerminal ?: return
        if (current.selectedProject == null) return
        update { copy(loading = true, error = "") }
        scope.launch {
            runCatching { uploadProjectImage(uri, "pasted_image") }.onSuccess { attachment ->
                update { copy(loading = false) }
                val command = terminal.command.lowercase()
                onUploaded(if (command.contains("claude") || command.contains("agy") || command.contains("kilo")) "/image ./${attachment.path}" else "./${attachment.path}")
            }.onFailure { error ->
                update { copy(loading = false, error = "图片上传失败：${error.message.orEmpty()}") }
            }
        }
    }

    fun uploadChatImage(uri: Uri, onUploaded: (ChatAttachment) -> Unit) {
        if (_state.value.selectedProject == null) return
        update { copy(loading = true, error = "") }
        scope.launch {
            runCatching { uploadProjectImage(uri, "chat_image") }
                .onSuccess { attachment ->
                    update { copy(loading = false, chatImageData = chatImageData + (attachment.path to attachment.dataUrl)) }
                    onUploaded(attachment)
                }
                .onFailure { error -> update { copy(loading = false, error = "图片上传失败：${error.message.orEmpty()}") } }
        }
    }

    fun showError(message: String) = update { copy(error = message) }

    private suspend fun uploadProjectImage(uri: Uri, prefix: String): ChatAttachment = withContext(Dispatchers.IO) {
        val current = _state.value
        val project = current.selectedProject ?: throw IllegalStateException("未选择项目")
        val resolver = getApplication<Application>().contentResolver
        val originalMimeType = resolver.getType(uri).orEmpty().substringBefore(';').lowercase().ifBlank { "image/png" }
        require(originalMimeType.startsWith("image/")) { "请选择图片文件" }
        val originalBytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("无法读取图片")
        require(originalBytes.size <= 50 shl 20) { "原始图片不能超过 50 MiB" }
        val (bytes, mimeType) = normalizeACPImage(originalBytes, originalMimeType)
        require(bytes.size <= 20 shl 20) { "发送图片不能超过 20 MiB" }
        val extension = when (mimeType.lowercase()) {
            "image/jpeg", "image/jpg" -> "jpg"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            else -> "png"
        }
        val filename = "${prefix}_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.$extension"
        val dataUrl = "data:$mimeType;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}"
        api.writeProjectFile(current.profile, project, filename, dataUrl)
        ChatAttachment(name = filename, path = filename, mimeType = mimeType, dataUrl = dataUrl)
    }

    private fun normalizeACPImage(bytes: ByteArray, originalMimeType: String): Pair<ByteArray, String> {
        val mimeType = if (originalMimeType == "image/jpg") "image/jpeg" else originalMimeType
        if (mimeType in setOf("image/jpeg", "image/png", "image/webp", "image/gif")) {
            return bytes to mimeType
        }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalStateException("当前图片格式无法转换，请选择 JPEG、PNG、WebP 或 GIF")
        return try {
            val output = ByteArrayOutputStream()
            val targetMimeType = if (bitmap.hasAlpha()) "image/png" else "image/jpeg"
            val format = if (targetMimeType == "image/png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
            val quality = if (targetMimeType == "image/png") 100 else 92
            check(bitmap.compress(format, quality, output)) { "图片转换失败" }
            output.toByteArray() to targetMimeType
        } finally {
            bitmap.recycle()
        }
    }

    fun newConversation(agent: String) {
        val project = _state.value.selectedProject ?: return
        val task = TaskRecord(
            taskId = "task-${UUID.randomUUID()}", deviceId = project.deviceId, workspacePath = project.workspacePath,
            agent = agent, agentRuntime = "direct_acp", terminalType = "bash", sessionName = "新对话",
            status = "created", updatedAt = System.currentTimeMillis() / 1000,
        )
        update { copy(screen = Screen.Chat, selectedTask = task, projectConversations = listOf(task) + projectConversations, taskEvents = emptyList(), chatItems = emptyList(), chatImageData = emptyMap(), error = "") }
        connect(task)
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { api.createProjectConversation(_state.value.profile, project, task) } }
                .onFailure { update { copy(error = "对话已创建，但保存到项目失败：${it.message.orEmpty()}") } }
        }
    }

    private fun connect(task: TaskRecord) {
        socket?.close(1000, "switch conversation")
        pendingMessages.clear()
        val current = _state.value
        val project = current.selectedProject ?: return
        socket = api.openAgentSocket(current.profile, project, task.taskId, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!_state.value.isActiveConversation(task.taskId)) {
                    webSocket.close(1000, "conversation no longer active")
                    return
                }
                update { if (isActiveConversation(task.taskId)) copy(connected = true, error = "") else this }
                webSocket.send(api.envelope("session.create", project.deviceId, buildJsonObject {
                    put("task_id", task.taskId); put("workspace_path", project.workspacePath)
                    put("agent", task.agent); put("agent_runtime", "direct_acp"); put("session_name", task.sessionName)
                    if (task.sessionId.isNotBlank()) put("resume_session_id", task.sessionId)
                    if (task.importHistory) put("import_history", true)
                }))
                synchronized(pendingMessages) {
                    pendingMessages.forEach(webSocket::send)
                    pendingMessages.clear()
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) = handleMessage(text, task.taskId)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = update {
                if (isActiveConversation(task.taskId)) copy(connected = false, loading = false, error = t.message ?: "对话连接失败") else this
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = update {
                if (isActiveConversation(task.taskId)) copy(connected = false, loading = false) else this
            }
        })
    }

    private fun handleMessage(text: String, expectedTaskId: String) {
        runCatching {
            val root = Json.parseToJsonElement(text).jsonObject
            when (root["type"]?.jsonPrimitive?.content) {
                "task.event" -> {
                    val event = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<TaskEvent>(root.getValue("payload"))
                    if (event.taskId != expectedTaskId) return@runCatching
                    val eventAttachments = taskEventAttachments(event)
                    val inlineImageData = eventAttachments
                        .filter { it.dataUrl.isNotBlank() }
                        .associate { it.path to it.dataUrl }
                    update {
                        if (!isActiveConversation(expectedTaskId)) return@update this
                        val events = mergeTaskEvents(taskEvents, listOf(event))
                        copy(
                            taskEvents = events,
                            chatItems = buildChatItems(events),
                            chatImageData = chatImageData + inlineImageData,
                            loading = if (event.eventType == "session.created") false else loading,
                            running = when {
                                event.eventType == "task.started" -> true
                                isTerminalTaskEvent(event.eventType) -> false
                                else -> running
                            },
                        )
                    }
                    loadChatImages(expectedTaskId, eventAttachments)
                }
                "server.error" -> update {
                    if (isActiveConversation(expectedTaskId)) copy(
                        error = root["payload"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull ?: "Agent 通信失败",
                        loading = false,
                        running = false,
                    ) else this
                }
            }
        }.onFailure { error -> Log.w("PocketStudio", "Ignoring malformed agent event", error) }
    }

    fun sendPrompt(prompt: String, attachments: List<ChatAttachment> = emptyList()) {
        val text = prompt.trim().ifEmpty { if (attachments.isNotEmpty()) "请查看附件" else return }
        val task = _state.value.selectedTask ?: return
        val project = _state.value.selectedProject ?: return
        val turnId = "turn-${UUID.randomUUID()}"
        update {
            val localEvent = localUserPromptEvent(task.taskId, turnId, text, taskEvents, attachments)
            val events = mergeTaskEvents(taskEvents, listOf(localEvent))
            val inlineImageData = attachments.filter { it.dataUrl.isNotBlank() }.associate { it.path to it.dataUrl }
            copy(
                taskEvents = events,
                chatItems = buildChatItems(events),
                chatImageData = chatImageData + inlineImageData,
                running = true,
            )
        }
        val message = api.envelope(
            "task.dispatch",
            project.deviceId,
            taskDispatchPayload(task, project, turnId, text, attachments),
        )
        if (_state.value.connected) {
            if (socket?.send(message) != true) update { copy(error = "连接已断开，请返回后重新进入对话", running = false) }
        } else {
            synchronized(pendingMessages) { pendingMessages += message }
        }
    }

    fun stop() {
        val task = _state.value.selectedTask ?: return; val project = _state.value.selectedProject ?: return
        socket?.send(api.envelope("task.stop", project.deviceId, buildJsonObject { put("task_id", task.taskId); put("reason", "user_requested") }))
    }

    private fun loadChatImages(taskId: String, attachments: List<ChatAttachment>) {
        val current = _state.value
        val project = current.selectedProject ?: return
        val missing = attachments.filter { attachment ->
            attachment.path.isNotBlank() &&
                attachment.dataUrl.isBlank() &&
                current.chatImageData[attachment.path].isNullOrBlank() &&
                synchronized(loadingChatImagePaths) { loadingChatImagePaths.add(attachment.path) }
        }
        missing.forEach { attachment ->
            scope.launch {
                try {
                    val dataUrl = withContext(Dispatchers.IO) {
                        api.readProjectImage(_state.value.profile, project, attachment.path)
                    }
                    update {
                        if (isActiveConversation(taskId)) {
                            copy(chatImageData = chatImageData + (attachment.path to dataUrl))
                        } else {
                            this
                        }
                    }
                } catch (error: Throwable) {
                    Log.w("PocketStudio", "Unable to load chat image ${attachment.path}: ${error.message}")
                } finally {
                    synchronized(loadingChatImagePaths) { loadingChatImagePaths.remove(attachment.path) }
                }
            }
        }
    }

    fun back() {
        when (_state.value.screen) {
            Screen.Login -> Unit
            Screen.Devices -> update { copy(screen = Screen.Login) }
            Screen.Projects -> update { copy(screen = Screen.Devices) }
            Screen.Conversations -> update { copy(screen = Screen.Projects) }
            Screen.Chat -> { socket?.close(1000, "leave chat"); update { copy(screen = Screen.Conversations, connected = false, running = false) } }
            Screen.Terminal -> update { copy(screen = Screen.Conversations, connected = false, loading = false) }
        }
    }

    private fun normalizeServer(value: String): String = value.trim().trimEnd('/').let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }
    private fun launchNetwork(block: suspend () -> Unit) { update { copy(loading = true, error = "") }; scope.launch { runCatching { withContext(Dispatchers.IO) { block() } }.onFailure { update { copy(loading = false, error = it.message ?: "网络请求失败") } } } }
    private fun update(block: AppState.() -> AppState) { _state.update(block) }
    private fun AppState.isActiveConversation(taskId: String) = screen == Screen.Chat && selectedTask?.taskId == taskId
    override fun onCleared() { socket?.cancel(); scope.cancel() }
}

internal fun taskDispatchPayload(
    task: TaskRecord,
    project: Project,
    turnId: String,
    prompt: String,
    attachments: List<ChatAttachment>,
): JsonObject = buildJsonObject {
    put("task_id", task.taskId)
    put("turn_id", turnId)
    put("workspace_path", project.workspacePath)
    put("agent", task.agent)
    put("agent_runtime", "direct_acp")
    put("session_name", task.sessionName)
    put("prompt", prompt)
    if (attachments.isNotEmpty()) putJsonArray("attachments") {
        attachments.forEach { attachment -> add(buildJsonObject {
            put("type", attachment.type)
            put("name", attachment.name)
            put("path", attachment.path)
            put("mime_type", attachment.mimeType)
        }) }
    }
}
