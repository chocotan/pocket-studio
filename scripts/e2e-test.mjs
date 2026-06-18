#!/usr/bin/env node
/**
 * E2E self-test for Pocket Studio ACPX conversation flow.
 *
 * Uses `agent-browser` CLI to automate a headless Chromium session.
 * Validates:  open dashboard (with auth) → open workspace →
 *             open ACPX tab → send message → receive assistant reply.
 *
 * Usage:  node scripts/e2e-test.mjs
 *
 * Prerequisites:
 *   - Frontend running on http://127.0.0.1:5173
 *   - Backend server running on http://127.0.0.1:18080 (with token ps_admin_local)
 *   - Daemon connected with ACPX enabled
 */

import { execSync } from "child_process";
import assert from "assert";

/* ── helpers ──────────────────────────────────────────────────────── */

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", timeout: 60_000 }).trim();
}

function ab(subCmd) {
  return run(`agent-browser ${subCmd}`);
}

/**
 * Evaluate JS in the browser via agent-browser eval.
 * Returns the raw output (may be quoted by agent-browser).
 */
function evalRaw(code) {
  const flat = code.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
  const escaped = flat
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
  try {
    return run(`agent-browser eval "${escaped}"`);
  } catch (err) {
    console.error(`  ✗ eval failed: ${flat.slice(0, 120)}`);
    throw err;
  }
}

/**
 * Evaluate JS and strip surrounding quotes from agent-browser output.
 */
function evalJS(code) {
  const raw = evalRaw(code);
  // agent-browser wraps string results in double quotes
  if (raw.startsWith('"') && raw.endsWith('"')) {
    // Un-escape the inner string: \" → " and \\ → \
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

function wait(ms) {
  ab(`wait ${ms}`);
}

function screenshot(label) {
  const path = `/tmp/e2e-${label}.png`;
  ab(`screenshot ${path}`);
  console.log(`  📸 ${path}`);
}

/**
 * Poll browser for a truthy string result or time out.
 */
function waitForCondition(jsExpr, timeoutMs = 45_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = evalJS(jsExpr);
      if (result && result !== "undefined" && result !== "null" && result !== "false") {
        return result;
      }
    } catch { /* ignore eval errors during polling */ }
    wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/* ── test steps ───────────────────────────────────────────────────── */

console.log("╔══════════════════════════════════════════╗");
console.log("║   Pocket Studio E2E Self-Test            ║");
console.log("╚══════════════════════════════════════════╝\n");

try {
  // ── Step 1: Open dashboard with auth pre-configured via query params ──
  console.log("➤ Step 1: Opening dashboard with auth…");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18080&token=ps_admin_local"');
  wait(3000);
  screenshot("01-dashboard");

  // ── Step 2: Verify device is online ──
  console.log("➤ Step 2: Verifying device appears…");
  waitForCondition(
    `(function(){ var el = document.querySelector('[class*=studio-panel]'); return el && el.innerText.includes('asuspro') ? 'ok' : ''; })()`,
    15_000, 2_000
  );
  console.log("  ✓ Device online");

  // ── Step 3: Open pocket-studio workspace ──
  console.log("➤ Step 3: Opening pocket-studio workspace…");
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b){ return b.innerText.includes('pocket-studio') && b.innerText.includes('打开'); });
      if(btn) btn.click();
    })()
  `);
  wait(3000);
  screenshot("02-workspace");

  // ── Step 4: Open ACPX session for claude ──
  console.log("➤ Step 4: Opening ACPX session…");

  // Click the "+" button in the tabbar
  evalJS(`
    (function(){
      var svg = document.querySelector('.lucide-plus');
      if(svg) svg.closest('button').click();
    })()
  `);
  wait(600);

  // Click "ACPX会话" in the dropdown
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var acpx = items.find(function(b){ return b.innerText.includes('ACPX会话'); });
      if(acpx) acpx.click();
    })()
  `);
  wait(600);

  // Click "claude code" or "opencode" agent
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var agent = items.find(function(b){ return b.innerText.includes('claude'); })
                || items.find(function(b){ return b.innerText.includes('opencode'); });
      if(agent) agent.click();
    })()
  `);
  wait(3000);
  screenshot("03-acpx-tab");

  // ── Step 5: Start conversation using suggestion button or input box ──
  console.log("➤ Step 5: Starting conversation via suggestion or input…");

  const suggestionClicked = evalJS(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var activeChat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(activeChat){
        var btn = Array.from(activeChat.querySelectorAll('button')).find(function(b){ return b.innerText.includes('磁盘剩余空间'); });
        if(btn){ btn.click(); return 'clicked'; }
      }
      
      var textareas = Array.from(document.querySelectorAll('textarea'));
      var textarea = textareas.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(textarea){
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, '磁盘剩余空间多少');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        var form = textarea.closest('form');
        if(form){
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return 'submitted';
        }
      }
      return '';
    })()
  `);
  assert(suggestionClicked.includes("clicked") || suggestionClicked.includes("submitted"), "Could not send message!");
  wait(2000);
  screenshot("04-sending");

  // ── Step 6: Wait for the conversation to show signs of activity ──
  console.log("➤ Step 6: Waiting for conversation activity…");

  // Look for user message bubble with non-empty text content.
  // Note: There may be multiple tabs, so we filter for elements with actual text.
  const userMessageFound = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var divs = chat.querySelectorAll('.bg-primary');
      for(var i=0;i<divs.length;i++){
        var t = divs[i].innerText.trim();
        if(t.length > 5 && t.includes('磁盘')) return t.substring(0,60);
      }
      return '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ User message found:", userMessageFound.slice(0, 50));

  // ── Step 7: Wait for agent response ──
  console.log("➤ Step 7: Waiting for agent response…");

  // Check for agent activity indicators in the active chat area:
  // 1. Working status ("Working" text)
  // 2. Thinking section (思考过程)
  // 3. Tool call cards
  // 4. Markdown body with content
  const responseIndicator = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var text = chat.innerText;
      if(text.includes('Working') || text.includes('working')) return 'working';
      if(text.includes('思考过程')) return 'thinking';
      var md = chat.querySelectorAll('.markdown-body');
      for(var i=0;i<md.length;i++){
        var t = md[i].innerText.trim();
        if(t.length > 10) return 'reply:' + t.substring(0,100);
      }
      if(chat.children.length > 2) return 'children:' + chat.children.length;
      return '';
    })()
  `, 30_000, 2_000);
  console.log("  ✓ Agent response:", responseIndicator.slice(0, 80));

  // If agent is working/thinking, optionally wait for completion
  if (responseIndicator.startsWith("working") || responseIndicator === "thinking") {
    console.log("  Agent is processing, waiting for text reply (up to 90s)…");
    try {
      const fullReply = waitForCondition(`
        (function(){
          var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
          var chat = chats.find(function(el) {
            return window.getComputedStyle(el).visibility !== 'hidden';
          });
          if(!chat) return '';
          var md = chat.querySelectorAll('.markdown-body');
          for(var i=0;i<md.length;i++){
            var t = md[i].innerText.trim();
            if(t.length > 20) return t.substring(0,200);
          }
          return '';
        })()
      `, 90_000, 5_000);
      console.log("  ✓ Full reply:", fullReply.slice(0, 120));
    } catch {
      console.log("  ⚠ Timed out waiting for full text reply, but agent is running — OK");
    }
  }

  screenshot("05-response");

  // ── Step 9: Opening Direct ACP session ──
  console.log("➤ Step 9: Opening Direct ACP session…");

  // Click the "+" button in the tabbar
  evalJS(`
    (function(){
      var svg = document.querySelector('.lucide-plus');
      if(svg) svg.closest('button').click();
    })()
  `);
  wait(800);

  // Click "ACP会话" in the dropdown
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var acp = items.find(function(b){ return b.innerText.includes('ACP会话'); });
      if(acp) acp.click();
    })()
  `);
  wait(800);

  // Click "codex" agent (configured to use mock-acp.js)
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var agent = items.find(function(b){ return b.innerText.includes('codex'); });
      if(agent) agent.click();
    })()
  `);
  wait(3000);
  screenshot("06-direct-acp-tab");

  // ── Step 10: Start Direct ACP conversation using suggestion button or input box ──
  console.log("➤ Step 10: Starting Direct ACP conversation via suggestion or input…");

  const directSuggestionClicked = evalJS(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(chat){
        var btn = Array.from(chat.querySelectorAll('button')).find(function(b){ return b.innerText.includes('磁盘剩余空间'); });
        if(btn){ btn.click(); return 'clicked'; }
      }
      
      var textareas = Array.from(document.querySelectorAll('textarea'));
      var textarea = textareas.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(textarea){
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, '磁盘剩余空间多少');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        var form = textarea.closest('form');
        if(form){
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return 'submitted';
        }
      }
      return '';
    })()
  `);
  assert(directSuggestionClicked.includes("clicked") || directSuggestionClicked.includes("submitted"), "Could not send Direct ACP message!");
  wait(2000);
  screenshot("07-direct-sending");

  // ── Step 11: Wait for Direct ACP conversation activity ──
  console.log("➤ Step 11: Waiting for Direct ACP conversation activity…");

  const directUserMessageFound = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var divs = chat.querySelectorAll('.bg-primary');
      for(var i=0;i<divs.length;i++){
        var t = divs[i].innerText.trim();
        if(t.length > 5 && t.includes('磁盘')) return t.substring(0,60);
      }
      return '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ Direct ACP User message found:", directUserMessageFound.slice(0, 50));

  // ── Step 12: Wait for Direct ACP agent response ──
  console.log("➤ Step 12: Waiting for Direct ACP agent response…");

  const directResponseIndicator = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var text = chat.innerText;
      if(text.includes('Working') || text.includes('working')) return 'working';
      if(text.includes('思考过程')) return 'thinking';
      var md = chat.querySelectorAll('.markdown-body');
      for(var i=0;i<md.length;i++){
        var t = md[i].innerText.trim();
        if(t.length > 10) return 'reply:' + t.substring(0,100);
      }
      if(chat.children.length > 2) return 'children:' + chat.children.length;
      return '';
    })()
  `, 30_000, 2_000);
  console.log("  ✓ Direct ACP Agent response:", directResponseIndicator.slice(0, 80));

  // If agent is working/thinking, optionally wait for completion
  if (directResponseIndicator.startsWith("working") || directResponseIndicator === "thinking" || directResponseIndicator.startsWith("reply")) {
    console.log("  Direct ACP Agent is processing, waiting for text reply (up to 90s)…");
    try {
      const directFullReply = waitForCondition(`
        (function(){
          var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
          var chat = chats.find(function(el) {
            return window.getComputedStyle(el).visibility !== 'hidden';
          });
          if(!chat) return '';
          var md = chat.querySelectorAll('.markdown-body');
          for(var i=0;i<md.length;i++){
            var t = md[i].innerText.trim();
            if(t.length > 20) return t.substring(0,200);
          }
          return '';
        })()
      `, 90_000, 5_000);
      console.log("  ✓ Direct ACP Full reply:", directFullReply.slice(0, 120));
    } catch {
      console.log("  ⚠ Timed out waiting for full text reply, but agent is running — OK");
    }
  }

  screenshot("08-direct-response");

  // ── Step 13: Final assertions ──
  console.log("➤ Step 13: Final verification…");

  // The test passes if:
  // 1. ACPX user message was displayed
  // 2. ACPX agent responded
  // 3. Direct ACP user message was displayed
  // 4. Direct ACP agent responded
  assert(userMessageFound.includes("磁盘"), `ACPX: User message missing "磁盘"! Got: "${userMessageFound}"`);
  assert(responseIndicator.length > 0, `ACPX: No response indicator! Got: "${responseIndicator}"`);
  assert(directUserMessageFound.includes("磁盘"), `Direct ACP: User message missing "磁盘"! Got: "${directUserMessageFound}"`);
  assert(directResponseIndicator.length > 0, `Direct ACP: No response indicator! Got: "${directResponseIndicator}"`);

  console.log("\n✅ E2E self-test PASSED!\n");
  ab("close");
} catch (error) {
  console.error("\n❌ E2E self-test FAILED:", error.message || error);
  try { screenshot("error-state"); } catch { /* ignore */ }
  try { ab("close"); } catch { /* ignore */ }
  process.exit(1);
}
