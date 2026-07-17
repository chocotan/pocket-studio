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
        val newer = event("assistant.message", "new", buildJsonObject { put("text", "new"); put("acpx_turn_index", 2); put("_seq", 2) })
        val older = event("assistant.message", "old", buildJsonObject { put("text", "old"); put("acpx_turn_index", 0); put("_seq", 2) })
        assertEquals(listOf("old", "new"), buildChatItems(listOf(newer, older)).map { it.id })
    }

    @Test fun `local user prompt stays before assistant event in same turn`() {
        val local = localUserPromptEvent("task", "turn-1", "question", emptyList())
        val assistant = event("assistant.message", "answer", buildJsonObject {
            put("text", "answer"); put("acpx_turn_index", 0); put("_seq", 3)
        })
        assertEquals(listOf("user", "assistant"), buildChatItems(listOf(assistant, local)).map { it.role })
    }

    @Test fun `user prompt stays first when assistant sequence starts at zero`() {
        val local = localUserPromptEvent("task", "turn-1", "question", emptyList())
        val assistant = event("assistant.message", "answer", buildJsonObject {
            put("text", "answer"); put("acpx_turn_index", 0); put("_seq", 0)
        })
        val tool = event("tool.call", "tool", buildJsonObject {
            put("name", "shell"); put("acpx_turn_index", 0); put("_seq", 1)
        })
        assertEquals(listOf("user", "assistant", "tool"), buildChatItems(listOf(tool, assistant, local)).map { it.role })
    }

    private fun event(type: String, id: String, data: kotlinx.serialization.json.JsonObject) = TaskEvent(
        taskId = "task-1", eventId = id, eventType = type,
        data = data,
    )
}
