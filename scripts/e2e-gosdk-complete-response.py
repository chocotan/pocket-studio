#!/usr/bin/env python3

import json
import os
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


PAGE_URL = os.environ.get("POCKET_E2E_PAGE_URL", "http://127.0.0.1:5174")
SERVER_URL = os.environ.get("POCKET_E2E_SERVER_URL", "http://127.0.0.1:18090")
TOKEN = os.environ.get("POCKET_E2E_TOKEN", "gosdk_e2e_token")
EXPECTED = "FIRST|MIDDLE|FINAL"
PROMPT = os.environ.get("POCKET_E2E_PROMPT", "return the deterministic response")
SCREENSHOT = Path("/tmp/e2e-gosdk-complete-response.png")
FAILURE_SCREENSHOT = Path("/tmp/e2e-gosdk-complete-response-failure.png")
RESPONSE_TIMEOUT_MS = int(os.environ.get("POCKET_E2E_RESPONSE_TIMEOUT_MS", "30000"))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    console_errors = []
    websocket_frames = []
    sent_commands = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    def record_websocket(websocket):
        def record_frame(payload):
            try:
                envelope = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                return
            if envelope.get("type") == "task.event":
                event = envelope.get("payload") or {}
                if event.get("event_type") in {
                    "user.prompt", "assistant.thinking", "assistant.message",
                    "task.completed", "task.failed",
                }:
                    websocket_frames.append(event)

        websocket.on("framereceived", record_frame)

        def record_sent_frame(payload):
            try:
                envelope = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                return
            if envelope.get("type") in {"session.create", "task.dispatch"}:
                sent_commands.append(envelope)

        websocket.on("framesent", record_sent_frame)

    page.goto(
        f"{PAGE_URL}/studio/?server_url={SERVER_URL}&token={TOKEN}",
        wait_until="networkidle",
    )
    page.get_by_text("gosdk-e2e", exact=False).first.wait_for(timeout=20_000)

    open_button = page.locator("button").filter(has_text="remote-agent").filter(has_text="打开").first
    open_button.click()
    add_button = page.locator('button[title*="新建终端、文件浏览器或 AI 助手窗口"]')
    if add_button.count() == 0:
        add_button = page.locator('button[title*="窗口"]')
    add_button.first.wait_for(state="visible", timeout=20_000)
    gosdk_menu = page.get_by_role("button", name="GoSDK会话", exact=True)
    for attempt in range(3):
        add_button.first.click(force=True)
        try:
            gosdk_menu.wait_for(state="visible", timeout=3_000)
            break
        except PlaywrightTimeoutError:
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
    else:
        page.screenshot(path=str(FAILURE_SCREENSHOT), full_page=True)
        raise AssertionError(
            "GoSDK menu did not open after three attempts; "
            f"body={page.locator('body').inner_text()[-3000:]!r}, screenshot={FAILURE_SCREENSHOT}"
        )
    gosdk_menu.click()
    page.wait_for_timeout(500)
    opencode_menu = page.locator("button").filter(has_text="opencode").last
    opencode_menu.wait_for(state="visible", timeout=20_000)
    page.on("websocket", record_websocket)
    opencode_menu.click()

    textarea = page.locator("textarea").last
    textarea.wait_for(state="visible", timeout=20_000)
    textarea.fill(PROMPT)
    textarea.press("Enter")

    try:
        page.locator(".markdown-body", has_text="FINAL").wait_for(timeout=RESPONSE_TIMEOUT_MS)
    except PlaywrightTimeoutError as error:
        replies = page.locator(".markdown-body").all_inner_texts()
        debug = page.evaluate("window.__agent_chat_debug || []")
        page.screenshot(path=str(FAILURE_SCREENSHOT), full_page=True)
        raise AssertionError(
            f"timed out waiting for complete GoSDK reply; replies={replies!r}, "
            f"frames={json.dumps(websocket_frames, ensure_ascii=False)}, "
            f"debug={json.dumps(debug, ensure_ascii=False)}, screenshot={FAILURE_SCREENSHOT}"
        ) from error
    replies = [
        text.strip()
        for text in page.locator(".markdown-body").all_inner_texts()
        if text.strip()
    ]
    if EXPECTED not in replies:
        debug = page.evaluate("window.__agent_chat_debug || []")
        raise AssertionError(
            f"complete GoSDK reply missing; expected={EXPECTED!r}, replies={replies!r}, "
            f"debug={json.dumps(debug, ensure_ascii=False)}"
        )

    page.reload(wait_until="networkidle")
    page.get_by_text("gosdk-e2e", exact=False).first.wait_for(timeout=20_000)
    restored_open_button = page.locator("button").filter(has_text="remote-agent").filter(has_text="打开").first
    if restored_open_button.count() > 0 and restored_open_button.is_visible():
        restored_open_button.click()
    page.locator(".markdown-body", has_text="FINAL").wait_for(timeout=30_000)
    restored_replies = [
        text.strip()
        for text in page.locator(".markdown-body").all_inner_texts()
        if text.strip()
    ]
    restored_session_creates = [
        command for command in sent_commands
        if command.get("type") == "session.create"
    ]
    if EXPECTED not in restored_replies:
        raise AssertionError(f"complete reply missing after reload: {restored_replies!r}")
    if not restored_session_creates or restored_session_creates[-1].get("payload", {}).get("agent_runtime") != "gosdk":
        raise AssertionError(f"reloaded GoSDK tab sent wrong runtime: {restored_session_creates[-3:]!r}")

    page.screenshot(path=str(SCREENSHOT), full_page=True)
    print(json.dumps({
        "expected": EXPECTED,
        "replies": replies,
        "restored_replies": restored_replies,
        "restored_runtime": restored_session_creates[-1]["payload"]["agent_runtime"],
        "frames": websocket_frames,
        "console_errors": console_errors,
        "screenshot": str(SCREENSHOT),
    }, ensure_ascii=False))
    browser.close()
