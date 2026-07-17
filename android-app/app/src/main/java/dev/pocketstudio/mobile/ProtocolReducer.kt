package dev.pocketstudio.mobile

import kotlinx.serialization.json.*

private fun TaskEvent.metadata(): JsonObject? = (data ?: raw)?.let { runCatching { it.jsonObject }.getOrNull() }
private fun JsonObject.text(key: String) = when (val value = get(key)) {
    is JsonPrimitive -> value.contentOrNull
    null -> null
    else -> value.toString()
}
private fun TaskEvent.number(vararg keys: String): Long? = keys.firstNotNullOfOrNull { metadata()?.text(it)?.toLongOrNull() }
private fun TaskEvent.turnIndex() = number("acpx_turn_index", "acpxTurnIndex")
private fun TaskEvent.logicalSequence(): Long? {
    number("_seq")?.let { return it }
    if (turnIndex() != null && eventType == "user.prompt") return 1
    return sequence.takeIf { it > 0 }
}
private fun TaskEvent.stableKey(): String {
    val key = metadata()?.text("acpx_event_key") ?: metadata()?.text("acpxEventKey")
    return key?.trim()?.takeIf { it.isNotEmpty() }?.let { "acpx:$it" }.orEmpty()
}
private fun TaskEvent.turnId() = metadata()?.text("turn_id").orEmpty()
private fun TaskEvent.streamId() = metadata()?.text("stream_id").orEmpty()
private fun TaskEvent.toolId(): String {
    val meta = metadata()
    return listOf("toolCallId", "tool_call_id", "tool_use_id", "id").firstNotNullOfOrNull { meta?.text(it)?.trim()?.takeIf(String::isNotEmpty) }
        ?: eventId
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
                merged[duplicate] = event.copy(sequence = maxOf(old.sequence, event.sequence), timestamp = old.timestamp)
                continue
            }
        }
        merged += event
    }
    return merged
}

private fun eventRank(type: String) = when (type) { "user.prompt" -> 0; "task.started" -> 1; else -> 2 }

internal fun sortTaskEventsForDisplay(events: List<TaskEvent>): List<TaskEvent> = events.withIndex().sortedWith { left, right ->
    val a = left.value
    val b = right.value
    val aTurn = a.turnIndex()
    val bTurn = b.turnIndex()
    if (aTurn != null && bTurn != null && aTurn != bTurn) return@sortedWith aTurn.compareTo(bTurn)
    if ((aTurn == null) != (bTurn == null)) return@sortedWith if (aTurn == null) 1 else -1
    if (aTurn == bTurn && (a.eventType == "user.prompt") != (b.eventType == "user.prompt")) {
        return@sortedWith if (a.eventType == "user.prompt") -1 else 1
    }
    if (a.eventType in setOf("tool.call", "tool.output") && b.eventType in setOf("tool.call", "tool.output") && a.toolId() == b.toolId() && a.eventType != b.eventType) {
        return@sortedWith if (a.eventType == "tool.call") -1 else 1
    }
    val aOrder = a.logicalSequence()
    val bOrder = b.logicalSequence()
    if (aOrder != null && bOrder != null && aOrder != bOrder) return@sortedWith aOrder.compareTo(bOrder)
    if (a.timestamp != b.timestamp) return@sortedWith a.timestamp.compareTo(b.timestamp)
    val rank = eventRank(a.eventType).compareTo(eventRank(b.eventType))
    if (rank != 0) rank else left.index.compareTo(right.index)
}.map { it.value }

internal fun buildChatItems(events: List<TaskEvent>): List<ChatItem> {
    val result = mutableListOf<ChatItem>()
    val streamIndexes = mutableMapOf<String, Int>()
    val signaturesByTurn = mutableMapOf<Long, MutableSet<String>>()
    val toolIndexes = mutableMapOf<String, Int>()

    for (event in sortTaskEventsForDisplay(events)) {
        val meta = event.metadata() ?: continue
        val turn = event.turnIndex() ?: Long.MAX_VALUE
        val order = event.logicalSequence() ?: Long.MAX_VALUE
        val time = event.timestamp.takeIf { it > 0 } ?: Long.MAX_VALUE
        fun item(role: String, text: String, kind: String = "message", title: String = "") =
            ChatItem(event.eventId, role, text, kind, title, turn, order, time)

        when (event.eventType) {
            "user.prompt" -> {
                val prompt = meta.text("prompt")?.trim().orEmpty()
                if (prompt.isNotEmpty() && result.none { it.role == "user" && it.turnIndex == turn && normalize(it.text) == normalize(prompt) }) {
                    result += item("user", prompt)
                }
            }
            "assistant.message", "assistant.thinking" -> {
                val text = meta.text("text").orEmpty()
                if (text.isBlank()) continue
                val streamId = event.streamId()
                val streamKey = if (streamId.isNotEmpty()) "${event.eventType}:$streamId" else ""
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
                val toolId = event.toolId()
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

internal fun localUserPromptEvent(taskId: String, turnId: String, prompt: String, events: List<TaskEvent>): TaskEvent {
    val turn = (events.mapNotNull { it.turnIndex() }.maxOrNull() ?: -1) + 1
    val now = System.currentTimeMillis() / 1000
    return TaskEvent(
        taskId = taskId,
        eventId = "local-user.prompt-$turnId",
        eventType = "user.prompt",
        source = "web",
        sequence = now,
        timestamp = now,
        data = buildJsonObject {
            put("prompt", prompt); put("turn_id", turnId); put("acpx_turn_index", turn)
            put("acpx_event_key", "turn:$turn:user.prompt:0")
        },
    )
}

internal fun isTerminalTaskEvent(type: String) = type in setOf(
    "task.completed", "turn.completed", "task.failed", "turn.failed", "task.stopped", "task.killed",
)
