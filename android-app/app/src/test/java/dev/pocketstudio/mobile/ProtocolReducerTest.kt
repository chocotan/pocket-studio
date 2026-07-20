package dev.pocketstudio.mobile

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.*
import org.junit.Test

class ProtocolReducerTest {
    @Test fun `same stable event key does not duplicate restored history`() {
        val history = event("assistant.message", "history-id", buildJsonObject {
            put("text", "完成了"); put("acpx_turn_index", 0); put("acpx_event_key", "turn:0:assistant.message:0")
        })
        val live = event("assistant.message", "live-id", buildJsonObject {
            put("text", "完成了"); put("acpx_turn_index", 0); put("acpx_event_key", "turn:0:assistant.message:0")
        })
        assertEquals(1, mergeTaskEvents(listOf(history), listOf(live)).size)
    }

    @Test fun `same turn semantic assistant duplicate renders once`() {
        val first = event("assistant.message", "a", buildJsonObject { put("text", "完成了"); put("acpx_turn_index", 0) })
        val duplicate = event("assistant.message", "b", buildJsonObject { put("text", "完成了"); put("acpx_turn_index", 0) })
        assertEquals(listOf("完成了"), buildChatItems(listOf(first, duplicate)).map { it.text })
    }

    @Test fun `stream updates compact by stream id`() {
        val first = event("assistant.message", "a", buildJsonObject { put("text", "部分"); put("stream_id", "s"); put("acpx_turn_index", 0) })
        val complete = event("assistant.message", "b", buildJsonObject { put("text", "完整回答"); put("stream_id", "s"); put("acpx_turn_index", 0) })
        assertEquals(listOf("完整回答"), buildChatItems(listOf(first, complete)).map { it.text })
    }

    @Test fun `tool call and output render as one collapsed item`() {
        val call = event("tool.call", "call", buildJsonObject { put("name", "read_file"); put("tool_call_id", "tool-1"); put("acpx_turn_index", 0) })
        val output = event("tool.output", "output", buildJsonObject {
            put("tool_call_id", "tool-1"); put("acpx_turn_index", 0)
            putJsonObject("output") { put("exit_code", 0); put("stdout", "ok") }
        })
        val messages = buildChatItems(listOf(output, call))
        assertEquals(1, messages.size)
        assertEquals("tool", messages.single().kind)
        assertEquals("read_file", messages.single().title)
        assertTrue(messages.single().text.contains("exit_code"))
    }

    @Test fun `only real terminal events finish a turn`() {
        assertTrue(isTerminalTaskEvent("turn.completed"))
        assertTrue(isTerminalTaskEvent("task.failed"))
        assertFalse(isTerminalTaskEvent("metric.updated"))
        assertFalse(isTerminalTaskEvent("assistant.message"))
    }

    @Test fun `server state ignores future fields`() {
        val decoded = Json { ignoreUnknownKeys = true }.decodeFromString<ServerState>("""{"devices":[],"tasks":[],"future":true}""")
        assertTrue(decoded.devices.isEmpty())
        assertTrue(decoded.tasks.isEmpty())
    }

    @Test fun `websocket request keeps https for okhttp upgrade`() {
        val url = PocketApi().agentWebSocketRequestUrl(
            ConnectionProfile("https://studio.example.com/", "secret token"),
            Project("project-1", "Project", "device-1", "/workspace"),
            "task-1",
        )
        assertEquals("https", url.scheme)
        assertEquals("/ws/agent", url.encodedPath)
        assertEquals("project-1", url.queryParameter("project_id"))
        assertEquals("secret token", url.queryParameter("token"))
    }

    @Test fun `task dispatch includes selected image attachments`() {
        val task = TaskRecord(
            taskId = "task-1",
            agent = "codex",
            sessionName = "Image chat",
        )
        val project = Project("project-1", "Project", "device-1", "/workspace")
        val attachment = ChatAttachment(
            name = "photo.jpg",
            path = "photo.jpg",
            mimeType = "image/jpeg",
            dataUrl = "data:image/jpeg;base64,ignored-by-protocol",
        )

        val payload = taskDispatchPayload(task, project, "turn-1", "describe this", listOf(attachment))
        val sent = payload.getValue("attachments").jsonArray.single().jsonObject

        assertEquals("image", sent.getValue("type").jsonPrimitive.content)
        assertEquals("photo.jpg", sent.getValue("path").jsonPrimitive.content)
        assertEquals("image/jpeg", sent.getValue("mime_type").jsonPrimitive.content)
        assertFalse("inline preview data must not inflate websocket dispatch", "data_url" in sent)
    }

    @Test fun `user prompt chat item retains image attachments`() {
        val attachment = ChatAttachment(
            name = "photo.png",
            path = "photo.png",
            mimeType = "image/png",
            dataUrl = "data:image/png;base64,cHJldmlldw==",
        )
        val event = localUserPromptEvent("task-1", "turn-1", "describe this", emptyList(), listOf(attachment))
        val item = buildChatItems(listOf(event)).single()

        assertEquals("user", item.role)
        assertEquals(listOf(attachment), item.attachments)
    }

    @Test fun `project conversations come only from nested agent chat panels`() {
        val state = Json.parseToJsonElement("""{
          "layoutTree":{"type":"split","children":[
            {"type":"panel","tabs":[
              {"kind":"terminal","id":"term-1"},
              {"kind":"agent_chat","title":"修复登录","agentKind":"codex","agentSessionId":"task-panel","agentResumeSessionId":"provider-1"}
            ]},
            {"type":"panel","tabs":[{"kind":"file_viewer","id":"file-1"}]}
          ]}}
        """)
        val tasks = listOf(
            TaskRecord("task-panel", "device-1", "/workspace", "codex", updatedAt = 20),
            TaskRecord("task-history-only", "device-1", "/workspace", "codex", updatedAt = 30),
        )
        val result = PocketApi().projectConversationsFromState(state, Project("project-1", "Project", "device-1", "/workspace"), tasks)
        assertEquals(listOf("task-panel"), result.map { it.taskId })
        assertEquals("修复登录", result.single().sessionName)
        assertEquals("provider-1", result.single().sessionId)
    }

    @Test fun `web panel title wins over provider session name`() {
        val state = Json.parseToJsonElement("""{"layoutTree":{"type":"panel","tabs":[{
          "kind":"agent_chat","title":"磁盘检查","agentSessionName":"019f-id","agentSessionId":"task-1","agentKind":"codex"
        }]}}""")
        val result = PocketApi().projectConversationsFromState(state, Project("p", "P", "d", "/w"), emptyList())
        assertEquals("磁盘检查", result.single().sessionName)
        assertEquals("bash", result.single().terminalType)
    }

    @Test fun `conversation reads terminal type from agent chat panel`() {
        val state = Json.parseToJsonElement("""{"layoutTree":{"type":"panel","tabs":[{
          "kind":"agent_chat","title":"PowerShell 对话","agentSessionId":"task-1","agentKind":"codex","termType":"powershell"
        }]}}""")
        val result = PocketApi().projectConversationsFromState(state, Project("p", "P", "d", "/w"), emptyList())
        assertEquals("powershell", result.single().terminalType)
    }

    @Test fun `new conversation is appended as an agent chat panel`() {
        val state = Json.parseToJsonElement("""{"layoutTree":{"type":"panel","id":"panel-1","tabs":[{
          "id":"term-1","kind":"terminal","title":"Shell"
        }],"activeTabId":"term-1"},"layoutMode":"grid"}""").jsonObject
        val task = TaskRecord("task-new", "device-1", "/workspace", "codex", sessionName = "新对话")
        val next = PocketApi().addAgentChatToProjectState(state, Project("project-1", "Project", "device-1", "/workspace"), task)
        val panel = next.getValue("layoutTree").jsonObject
        val tabs = panel.getValue("tabs").jsonArray
        assertEquals(2, tabs.size)
        assertEquals("task-new", tabs.last().jsonObject["agentSessionId"]?.jsonPrimitive?.content)
        assertEquals("agent_chat", tabs.last().jsonObject["kind"]?.jsonPrimitive?.content)
        assertEquals("grid", next["layoutMode"]?.jsonPrimitive?.content)
    }

    @Test fun `terminal menu mirrors device capabilities`() {
        val device = Device("device-1", "Machine", agents = listOf(
            AgentCapability("claude-code", "Claude Code"), AgentCapability("kilocode", "Kilo Code"),
        ))
        assertEquals(listOf("bash", "claude", "kilo"), availableTerminalOptions(device).map { it.value })
    }

    @Test fun `new terminal is appended with web layout fields`() {
        val state = Json.parseToJsonElement("""{"layoutTree":{"type":"panel","id":"panel-1","tabs":[],"activeTabId":""}}""").jsonObject
        val option = TerminalOption("codex", "Codex", "Codex", "codex")
        val next = PocketApi().addTerminalToProjectState(state, Project("project-1", "Project", "device-1", "/workspace"), option)
        val panel = next.getValue("layoutTree").jsonObject
        val tab = panel.getValue("tabs").jsonArray.single().jsonObject
        assertEquals("terminal", tab["kind"]?.jsonPrimitive?.content)
        assertEquals("codex", tab["termType"]?.jsonPrimitive?.content)
        assertEquals("codex", tab["activeCommand"]?.jsonPrimitive?.content)
        assertEquals(tab["id"]?.jsonPrimitive?.content, panel["activeTabId"]?.jsonPrimitive?.content)
    }

    @Test fun `existing terminal tabs are selectable`() {
        val state = Json.parseToJsonElement("""{"layoutTree":{"type":"panel","tabs":[{
          "id":"term-existing","kind":"terminal","title":"Codex","termType":"codex","activeCommand":"codex","filePath":"/workspace"
        }]}}""")
        val terminals = PocketApi().projectTerminalsFromState(state, Project("p", "P", "d", "/workspace"))
        assertEquals(listOf("term-existing"), terminals.map { it.id })
        assertEquals("codex", terminals.single().command)
    }

    @Test fun `late imported history sorts before newer turn`() {
        val newerPrompt = event("user.prompt", "new-user", buildJsonObject { put("prompt", "new"); put("acpx_turn_index", 2); put("_seq", 1) }, 11)
        val newerAnswer = event("assistant.message", "new-answer", buildJsonObject { put("text", "new answer"); put("acpx_turn_index", 2); put("_seq", 2) }, 12)
        val olderPrompt = event("user.prompt", "old-user", buildJsonObject { put("prompt", "old"); put("acpx_turn_index", 0); put("_seq", 1) }, 1)
        val olderAnswer = event("assistant.message", "old-answer", buildJsonObject { put("text", "old answer"); put("acpx_turn_index", 0); put("_seq", 2) }, 2)
        assertEquals(
            listOf("old", "old answer", "new", "new answer"),
            buildChatItems(listOf(newerPrompt, newerAnswer, olderPrompt, olderAnswer)).map { it.text },
        )
    }

    @Test fun `unindexed live turns keep transport order instead of grouping by role`() {
        val events = listOf(
            event("assistant.message", "answer-2", buildJsonObject { put("text", "answer 2") }, 4),
            event("user.prompt", "question-2", buildJsonObject { put("prompt", "question 2"); put("turn_id", "turn-2") }, 3),
            event("assistant.message", "answer-1", buildJsonObject { put("text", "answer 1") }, 2),
            event("user.prompt", "question-1", buildJsonObject { put("prompt", "question 1"); put("turn_id", "turn-1") }, 1),
        )
        assertEquals(
            listOf("question 1", "answer 1", "question 2", "answer 2"),
            buildChatItems(events).map { it.text },
        )
    }

    @Test fun `optimistic prompt uses next transport sequence and survives late server echo`() {
        val existing = event("assistant.message", "old-answer", buildJsonObject { put("text", "old") }, 10)
        val attachment = ChatAttachment(
            name = "photo.png",
            path = "photo.png",
            mimeType = "image/png",
            dataUrl = "data:image/png;base64,cHJldmlldw==",
        )
        val local = localUserPromptEvent("task-1", "turn-2", "question", listOf(existing), listOf(attachment))
        val answer = event("assistant.message", "answer", buildJsonObject { put("text", "answer") }, 12)
        val echo = event("user.prompt", "server-user", buildJsonObject {
            put("prompt", "question"); put("turn_id", "turn-2")
        }, 11)
        val merged = mergeTaskEvents(listOf(existing, local, answer), listOf(echo))

        assertEquals(11L, local.sequence)
        assertNull(local.data?.jsonObject?.get("acpx_turn_index"))
        assertEquals(listOf("old", "question", "answer"), buildChatItems(merged).map { it.text })
        assertEquals(listOf(attachment), buildChatItems(merged).first { it.text == "question" }.attachments)
    }

    @Test fun `identical unindexed content remains visible in separate live turns`() {
        val events = listOf(
            event("user.prompt", "question-1", buildJsonObject { put("prompt", "again") }, 1),
            event("assistant.message", "answer-1", buildJsonObject { put("text", "same answer"); put("stream_id", "assistant") }, 2),
            event("user.prompt", "question-2", buildJsonObject { put("prompt", "again") }, 3),
            event("assistant.message", "answer-2", buildJsonObject { put("text", "same answer"); put("stream_id", "assistant") }, 4),
        )

        assertEquals(
            listOf("again", "same answer", "again", "same answer"),
            buildChatItems(events).map { it.text },
        )
    }

    @Test fun `live incremental order matches restored indexed history`() {
        var live = emptyList<TaskEvent>()
        val localOne = localUserPromptEvent("task-1", "turn-1", "question 1", live)
        live = mergeTaskEvents(live, listOf(localOne))
        live = mergeTaskEvents(live, listOf(
            event("assistant.message", "answer-1", buildJsonObject { put("text", "answer 1") }, 2),
            event("user.prompt", "server-question-1", buildJsonObject { put("prompt", "question 1"); put("turn_id", "turn-1") }, 1),
        ))
        val localTwo = localUserPromptEvent("task-1", "turn-2", "question 2", live)
        live = mergeTaskEvents(live, listOf(localTwo))
        live = mergeTaskEvents(live, listOf(
            event("assistant.message", "answer-2", buildJsonObject { put("text", "answer 2") }, 4),
            event("user.prompt", "server-question-2", buildJsonObject { put("prompt", "question 2"); put("turn_id", "turn-2") }, 3),
        ))

        val restored = listOf(
            event("assistant.message", "history-answer-2", buildJsonObject { put("text", "answer 2"); put("acpx_turn_index", 1); put("_seq", 2) }, 4),
            event("user.prompt", "history-question-2", buildJsonObject { put("prompt", "question 2"); put("acpx_turn_index", 1); put("_seq", 1) }, 3),
            event("assistant.message", "history-answer-1", buildJsonObject { put("text", "answer 1"); put("acpx_turn_index", 0); put("_seq", 2) }, 2),
            event("user.prompt", "history-question-1", buildJsonObject { put("prompt", "question 1"); put("acpx_turn_index", 0); put("_seq", 1) }, 1),
        )

        assertEquals(
            buildChatItems(restored).map { it.role to it.text },
            buildChatItems(live).map { it.role to it.text },
        )
    }

    private fun event(type: String, id: String, data: kotlinx.serialization.json.JsonObject, sequence: Long = 0) = TaskEvent(
        taskId = "task-1", eventId = id, eventType = type,
        sequence = sequence, timestamp = sequence, data = data,
    )
}
