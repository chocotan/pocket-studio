#!/usr/bin/env python3

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


PAGE_URL = os.environ.get("POCKET_E2E_PAGE_URL", "http://127.0.0.1:5180")
SERVER_URL = os.environ.get("POCKET_E2E_SERVER_URL", "http://127.0.0.1:18100")
TOKEN = os.environ.get("POCKET_E2E_TOKEN", "gosdk_tools_e2e_token")
DEVICE_NAME = os.environ.get("POCKET_E2E_DEVICE_NAME", "gosdk-tools-e2e")
SCREENSHOT = Path("/tmp/e2e-gosdk-tool-display.png")
AGENT_SCREENSHOT = Path("/tmp/e2e-gosdk-agent-smoke.png")
TIMEOUT_MS = int(os.environ.get("POCKET_E2E_RESPONSE_TIMEOUT_MS", "180000"))
SMOKE_AGENTS = [
    agent.strip()
    for agent in os.environ.get("POCKET_E2E_SMOKE_AGENTS", "claude,pi,codex,qwen").split(",")
    if agent.strip()
]


def event_data(event):
    data = event.get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, str):
        try:
            parsed = json.loads(data)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    console_errors = []
    task_events = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    def record_websocket(websocket):
        def record_frame(payload):
            try:
                envelope = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                return
            if envelope.get("type") == "task.event":
                task_events.append(envelope.get("payload") or {})

        websocket.on("framereceived", record_frame)

    page.on("websocket", record_websocket)
    page.goto(
        f"{PAGE_URL}/studio/?server_url={SERVER_URL}&token={TOKEN}",
        wait_until="networkidle",
    )
    page.get_by_text(DEVICE_NAME, exact=False).first.wait_for(timeout=30_000)
    page.locator("button").filter(has_text="remote-agent").filter(has_text="打开").first.click()

    add_button = page.locator('button[title*="新建终端、文件浏览器或 AI 助手窗口"]')
    page.wait_for_timeout(1_000)
    if add_button.count() == 0 or not add_button.first.is_visible():
        page.locator('button[title^="悬浮窗口模式"]').click()
    add_button.first.wait_for(state="visible", timeout=30_000)
    add_button.first.click(force=True)
    page.get_by_role("button", name="GoSDK会话", exact=True).click()

    for label in ["claude code", "pi", "codex", "qwen code"]:
        page.locator("button").filter(has_text=label).last.wait_for(state="visible", timeout=10_000)

    page.locator("button").filter(has_text="opencode").last.click()
    textarea = page.locator("textarea").last
    textarea.wait_for(state="visible", timeout=30_000)
    active_panel = textarea.locator("xpath=ancestor::div[contains(@class, 'group/window')][1]")

    def send_and_wait(prompt, tool_selector):
        textarea.fill(prompt)
        textarea.press("Enter")
        tool_selector.wait_for(state="visible", timeout=TIMEOUT_MS)
        active_panel.locator('textarea[placeholder^="给 GoSDK"]').wait_for(state="visible", timeout=TIMEOUT_MS)
        prompt_messages = active_panel.locator("div.rounded-xl.bg-primary").filter(has_text=prompt)
        if prompt_messages.count() != 1:
            raise AssertionError(f"prompt rendered {prompt_messages.count()} times: {prompt!r}")

    command_card = active_panel.locator("button").filter(has_text="执行命令").filter(has_text="df").last
    send_and_wait("磁盘剩余空间多少", command_card)
    command_card.click()
    active_panel.get_by_text("Filesystem", exact=False).last.wait_for(state="visible", timeout=30_000)

    search_header = active_panel.locator("button").filter(has_text="搜索网页").first
    send_and_wait("来点马斯克新闻", search_header)
    search_header.click(force=True)
    search_query_text = active_panel.get_by_text("search_query", exact=False)
    if search_query_text.count() == 0 or not search_query_text.last.is_visible():
        search_detail = active_panel.locator("button").filter(has_text="搜索网页").filter(has_text="马斯克").last
        if search_detail.count() == 0:
            search_detail = active_panel.locator("button").filter(has_text="搜索网页").filter(has_text="Elon").last
        search_detail.click(force=True)
    search_query_text.last.wait_for(state="visible", timeout=30_000)

    tool_outputs = [event_data(event) for event in task_events if event.get("event_type") == "tool.output"]
    disk_events = [
        data for data in tool_outputs
        if isinstance(data.get("input"), dict) and "df" in str(data["input"].get("command", ""))
    ]
    news_events = [
        data for data in tool_outputs
        if isinstance(data.get("input"), dict)
        and any(term in str(data["input"].get("search_query", "")) for term in ["马斯克", "Elon Musk"])
    ]
    if not disk_events:
        raise AssertionError(f"complete disk command event missing: {tool_outputs!r}")
    if not disk_events[-1].get("output"):
        raise AssertionError(f"disk command output missing: {disk_events[-1]!r}")
    if not news_events:
        raise AssertionError(f"complete web search event missing: {tool_outputs!r}")
    terminal_news_events = [
        data for data in news_events
        if data.get("status") in {"completed", "failed", "error"} and data.get("output")
    ]
    if not terminal_news_events:
        raise AssertionError(f"terminal web search output missing: {news_events!r}")
    final_news_event = terminal_news_events[-1]
    relevant_console_errors = [
        error for error in console_errors
        if "cannot be a descendant of" not in error and "cannot contain a nested" not in error
    ]
    if relevant_console_errors:
        raise AssertionError(f"browser console errors: {relevant_console_errors!r}")

    page.screenshot(path=str(SCREENSHOT), full_page=True)
    all_agent_labels = {
        "claude": "claude code",
        "pi": "pi",
        "codex": "codex",
        "qwen": "qwen code",
    }
    unknown_agents = [agent for agent in SMOKE_AGENTS if agent not in all_agent_labels]
    if unknown_agents:
        raise AssertionError(f"unknown smoke agents: {unknown_agents!r}")
    agent_labels = {agent: all_agent_labels[agent] for agent in SMOKE_AGENTS}
    agent_replies = {}
    for agent, label in agent_labels.items():
        add_button.first.click(force=True)
        page.get_by_role("button", name="GoSDK会话", exact=True).click()
        page.locator("button").filter(has_text=label).last.click()
        agent_textarea = page.locator("textarea").last
        agent_textarea.wait_for(state="visible", timeout=30_000)
        agent_panel = agent_textarea.locator("xpath=ancestor::div[contains(@class, 'group/window')][1]")
        agent_textarea.fill("只回复字符串 GOSDK_SMOKE_OK，不要调用工具")
        agent_textarea.press("Enter")
        reply = agent_panel.locator(".markdown-body", has_text="GOSDK_SMOKE_OK").last
        reply.wait_for(state="visible", timeout=TIMEOUT_MS)
        agent_panel.locator('textarea[placeholder^="给 GoSDK"]').wait_for(state="visible", timeout=TIMEOUT_MS)
        prompt_messages = agent_panel.locator("div.rounded-xl.bg-primary").filter(has_text="只回复字符串 GOSDK_SMOKE_OK，不要调用工具")
        if prompt_messages.count() != 1:
            raise AssertionError(f"{agent} prompt rendered {prompt_messages.count()} times")
        agent_replies[agent] = reply.inner_text().strip()

    page.screenshot(path=str(AGENT_SCREENSHOT), full_page=True)
    print(json.dumps({
        "disk_command": disk_events[-1]["input"]["command"],
        "disk_status": disk_events[-1].get("status"),
        "news_query": final_news_event["input"]["search_query"],
        "news_status": final_news_event.get("status"),
        "supported_agents": list(agent_labels),
        "agent_replies": agent_replies,
        "console_errors": relevant_console_errors,
        "ignored_dashboard_warnings": len(console_errors) - len(relevant_console_errors),
        "screenshot": str(SCREENSHOT),
        "agent_screenshot": str(AGENT_SCREENSHOT),
    }, ensure_ascii=False))
    browser.close()
