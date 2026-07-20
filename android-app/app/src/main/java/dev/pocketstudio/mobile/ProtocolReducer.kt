package dev.pocketstudio.mobile

import kotlinx.serialization.json.*

private fun JsonElement.metadataObject(): JsonObject? = when (this) {
    is JsonObject -> this
    is JsonPrimitive -> contentOrNull?.let { value ->
        runCatching { Json.parseToJsonElement(value).jsonObject }.getOrNull()
    }
    else -> null
}
private fun TaskEvent.metadataSources() = listOfNotNull(data?.metadataObject(), raw?.metadataObject())
private fun TaskEvent.metadata(): JsonObject? = metadataSources().firstOrNull()
private fun JsonObject.text(key: String) = when (val value = get(key)) {
    is JsonPrimitive -> value.contentOrNull
    null -> null
    else -> value.toString()
}
private fun TaskEvent.text(vararg keys: String): String? = metadataSources().firstNotNullOfOrNull { source ->
    keys.firstNotNullOfOrNull { source.text(it) }
}
private fun TaskEvent.number(vararg keys: String): Long? = text(*keys)?.toLongOrNull()
private fun TaskEvent.turnIndex() = number("acpx_turn_index", "acpxTurnIndex")
private fun TaskEvent.logicalSequence(): Long? {
    number("_seq")?.let { return it }
    if (turnIndex() != null && eventType == "user.prompt" && source == "web") return 1
    if (turnIndex() != null && isTerminalTaskEvent(eventType)) return Long.MAX_VALUE
    return sequence.takeIf { it > 0 }
}
private fun TaskEvent.stableKey(): String {
    val key = text("acpx_event_key", "acpxEventKey")
    return key?.trim()?.takeIf { it.isNotEmpty() }?.let { "acpx:$it" }.orEmpty()
}
private fun TaskEvent.turnId() = text("turn_id", "turnId").orEmpty()
private fun TaskEvent.streamId() = text("stream_id").orEmpty()
private fun TaskEvent.toolId(): String {
    return text("toolCallId", "tool_call_id", "tool_use_id", "id")?.trim()?.takeIf(String::isNotEmpty)
        ?: eventId
}

internal fun taskEventAttachments(event: TaskEvent): List<ChatAttachment> {
    return event.metadataSources().firstNotNullOfOrNull { source ->
        val attachments = source["attachments"] as? JsonArray ?: return@firstNotNullOfOrNull null
        attachments.mapNotNull { value ->
            val item = value as? JsonObject ?: return@mapNotNull null
            val path = item["path"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val type = item["type"]?.jsonPrimitive?.contentOrNull ?: "image"
            if (path.isEmpty() || type != "image") return@mapNotNull null
            ChatAttachment(
                type = "image",
                name = item["name"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
                    ?: path.substringAfterLast('/'),
                path = path,
                mimeType = item["mime_type"]?.jsonPrimitive?.contentOrNull
                    ?: item["mimeType"]?.jsonPrimitive?.contentOrNull
                    ?: "image/png",
                dataUrl = item["data_url"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
        }
    }.orEmpty()
}

private fun TaskEvent.withFallbackAttachments(previous: TaskEvent): TaskEvent {
    if (taskEventAttachments(this).isNotEmpty()) return this
    val previousMetadata = previous.metadata() ?: return this
    val attachments = previousMetadata["attachments"] ?: return this
    val currentMetadata = metadata() ?: return this
    return copy(data = JsonObject(currentMetadata + ("attachments" to attachments)))
}

internal fun mergeTaskEvents(previous: List<TaskEvent>, incoming: List<TaskEvent>): List<TaskEvent> {
    val merged = previous.toMutableList()
    for (event in incoming) {
        val byId = merged.indexOfFirst { it.eventId == event.eventId }
        if (byId >= 0) {
            val old = merged[byId]
            merged[byId] = event.copy(sequence = maxOf(old.sequence, event.sequence), timestamp = maxOf(old.timestamp, event.timestamp))
            continue
        }
        val stableKey = event.stableKey()
        val byStableKey = if (stableKey.isNotEmpty()) merged.indexOfFirst { it.stableKey() == stableKey } else -1
        if (byStableKey >= 0) {
            val old = merged[byStableKey]
            val replace = event.eventType in setOf("tool.call", "tool.output") ||
                (event.eventType in setOf("assistant.message", "assistant.thinking") && event.streamId().isNotEmpty())
            if (replace) merged[byStableKey] = event.copy(eventId = old.eventId, sequence = old.sequence, timestamp = old.timestamp)
            continue
        }
        if (event.eventType == "user.prompt" && event.turnId().isNotEmpty()) {
            val duplicate = merged.indexOfFirst { it.eventType == "user.prompt" && it.turnId() == event.turnId() }
            if (duplicate >= 0) {
                val old = merged[duplicate]
                merged[duplicate] = event.withFallbackAttachments(old).copy(
                    sequence = maxOf(old.sequence, event.sequence),
                    timestamp = old.timestamp,
                )
                continue
            }
        }
        merged += event
    }
    return merged
}

private fun eventRank(type: String) = when (type) { "user.prompt" -> 0; "task.started" -> 1; else -> 2 }

private fun hasCompleteIndexedTurnAnchors(events: List<TaskEvent>): Boolean {
    val anchors = events.filter { it.eventType == "user.prompt" || it.eventType == "task.started" || isTerminalTaskEvent(it.eventType) }
    return anchors.isNotEmpty() && anchors.all { it.turnIndex() != null }
}

internal fun sortTaskEventsForDisplay(events: List<TaskEvent>): List<TaskEvent> {
    val useIndexedTurnOrder = hasCompleteIndexedTurnAnchors(events)
    return events.withIndex().sortedWith { left, right ->
        val a = left.value
        val b = right.value
        val aTurn = a.turnIndex()
        val bTurn = b.turnIndex()
        if (useIndexedTurnOrder && aTurn != null && bTurn != null && aTurn != bTurn) return@sortedWith aTurn.compareTo(bTurn)
        if (useIndexedTurnOrder && (aTurn == null) != (bTurn == null)) return@sortedWith if (aTurn == null) 1 else -1
        if (a.eventType in setOf("tool.call", "tool.output") && b.eventType in setOf("tool.call", "tool.output") && a.toolId() == b.toolId() && a.eventType != b.eventType) {
            return@sortedWith if (a.eventType == "tool.call") -1 else 1
        }
        if (useIndexedTurnOrder && (aTurn == null) == (bTurn == null)) {
            val aOrder = a.logicalSequence()
            val bOrder = b.logicalSequence()
            if (aOrder != null && bOrder != null && aOrder != bOrder) return@sortedWith aOrder.compareTo(bOrder)
        }
        if (!useIndexedTurnOrder && a.sequence > 0 && b.sequence > 0 && a.sequence != b.sequence) {
            return@sortedWith a.sequence.compareTo(b.sequence)
        }
        if (a.timestamp != b.timestamp) return@sortedWith a.timestamp.compareTo(b.timestamp)
        val rank = eventRank(a.eventType).compareTo(eventRank(b.eventType))
        if (rank != 0) return@sortedWith rank
        if (!a.eventId.startsWith("local-") && !b.eventId.startsWith("local-") && a.sequence != b.sequence) {
            return@sortedWith a.sequence.compareTo(b.sequence)
        }
        left.index.compareTo(right.index)
    }.map { it.value }
}

internal fun buildChatItems(events: List<TaskEvent>): List<ChatItem> {
    val result = mutableListOf<ChatItem>()
    val streamIndexes = mutableMapOf<String, Int>()
    val signaturesByTurn = mutableMapOf<Long, MutableSet<String>>()
    val toolIndexes = mutableMapOf<String, Int>()
    var nextUnindexedTurn = Long.MIN_VALUE
    var activeTurn = Long.MIN_VALUE

    for (event in sortTaskEventsForDisplay(events)) {
        val meta = event.metadata() ?: continue
        val indexedTurn = event.turnIndex()
        if (event.eventType == "user.prompt") {
            activeTurn = indexedTurn ?: (++nextUnindexedTurn)
        } else if (indexedTurn != null) {
            activeTurn = indexedTurn
        }
        val turn = indexedTurn ?: activeTurn
        val order = event.logicalSequence() ?: Long.MAX_VALUE
        val time = event.timestamp.takeIf { it > 0 } ?: Long.MAX_VALUE
        fun item(
            role: String,
            text: String,
            kind: String = "message",
            title: String = "",
            attachments: List<ChatAttachment> = emptyList(),
        ) = ChatItem(event.eventId, role, text, kind, title, turn, order, time, attachments)

        when (event.eventType) {
            "user.prompt" -> {
                val prompt = meta.text("prompt")?.trim().orEmpty()
                if (prompt.isNotEmpty() && result.none { it.role == "user" && it.turnIndex == turn && normalize(it.text) == normalize(prompt) }) {
                    result += item("user", prompt, attachments = taskEventAttachments(event))
                }
            }
            "assistant.message", "assistant.thinking" -> {
                val text = meta.text("text").orEmpty()
                if (text.isBlank()) continue
                val streamId = event.streamId()
                val streamKey = if (streamId.isNotEmpty()) "$turn:${event.eventType}:$streamId" else ""
                if (streamKey.isNotEmpty()) {
                    val index = streamIndexes[streamKey]
                    if (index == null) {
                        streamIndexes[streamKey] = result.size
                        result += item("assistant", text)
                    } else {
                        val old = result[index]
                        result[index] = old.copy(text = if (meta["append"]?.jsonPrimitive?.booleanOrNull == true) old.text + text else text)
                    }
                } else {
                    val signature = normalize(text)
                    val signatures = signaturesByTurn.getOrPut(turn) { mutableSetOf() }
                    if (signatures.add(signature)) {
                        val last = result.lastOrNull()
                        if (last?.role == "assistant" && last.turnIndex == turn && text.startsWith(last.text)) result[result.lastIndex] = last.copy(text = text)
                        else result += item("assistant", text)
                    }
                }
            }
            "tool.call", "tool.output", "permission.request" -> {
                val toolId = "$turn:${event.toolId()}"
                val existing = toolIndexes[toolId]
                val title = meta.text("title") ?: meta.text("name") ?: "工具调用"
                val details = meta.text("output") ?: meta.text("result") ?: meta.text("input") ?: meta.text("arguments").orEmpty()
                if (existing == null) {
                    toolIndexes[toolId] = result.size
                    result += item("tool", details, "tool", title)
                } else {
                    val old = result[existing]
                    result[existing] = old.copy(
                        title = if (old.title == "工具调用" && title != "工具调用") title else old.title,
                        text = if (details.isNotBlank()) details else old.text,
                    )
                }
            }
        }
    }
    return result
}

private fun normalize(text: String) = text.trim().replace(Regex("\\s+"), " ")

internal fun localUserPromptEvent(
    taskId: String,
    turnId: String,
    prompt: String,
    events: List<TaskEvent>,
    attachments: List<ChatAttachment> = emptyList(),
): TaskEvent {
    val nextSequence = (events.maxOfOrNull { it.sequence } ?: 0) + 1
    val now = System.currentTimeMillis() / 1000
    return TaskEvent(
        taskId = taskId,
        eventId = "local-user.prompt-$turnId",
        eventType = "user.prompt",
        source = "web",
        sequence = nextSequence,
        timestamp = now,
        data = buildJsonObject {
            put("prompt", prompt); put("turn_id", turnId)
            if (attachments.isNotEmpty()) putJsonArray("attachments") {
                attachments.forEach { attachment -> add(buildJsonObject {
                    put("type", attachment.type)
                    put("name", attachment.name)
                    put("path", attachment.path)
                    put("mime_type", attachment.mimeType)
                    if (attachment.dataUrl.isNotBlank()) put("data_url", attachment.dataUrl)
                }) }
            }
        },
    )
}

internal fun isTerminalTaskEvent(type: String) = type in setOf(
    "task.completed", "turn.completed", "task.failed", "turn.failed", "task.stopped", "task.killed",
)
