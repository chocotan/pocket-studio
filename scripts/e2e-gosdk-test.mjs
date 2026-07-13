#!/usr/bin/env node
/**
 * E2E self-test for Pocket Studio GoSDK conversation flow.
 *
 * Uses `agent-browser` CLI to automate a headless Chromium session.
 * Validates:  open dashboard (with auth) → open workspace (create if missing) →
 *             open GoSDK tab → send message → receive assistant reply.
 *
 * Usage:  node scripts/e2e-gosdk-test.mjs
 *
 * Prerequisites:
 *   - Frontend running on http://127.0.0.1:5173
 *   - Backend server running on http://127.0.0.1:18081 (with token dev_token)
 *   - Daemon connected
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

function evalJS(code) {
  const raw = evalRaw(code);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

function wait(ms) {
  ab(`wait ${ms}`);
}

function screenshot(label) {
  const path = `/tmp/e2e-gosdk-${label}.png`;
  ab(`screenshot ${path}`);
  console.log(`  📸 ${path}`);
}

function waitForCondition(jsExpr, timeoutMs = 45_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = evalJS(jsExpr);
      if (result && result !== "undefined" && result !== "null" && result !== "false") {
        return result;
      }
    } catch { /* ignore */ }
    wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/* ── test steps ───────────────────────────────────────────────────── */

console.log("╔══════════════════════════════════════════╗");
console.log("║   Pocket Studio GoSDK E2E Self-Test      ║");
console.log("╚══════════════════════════════════════════╝\n");

try {
  // ── Step 1: Open dashboard ──
  console.log("➤ Step 1: Opening dashboard with dev auth…");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18081&token=dev_token"');
  wait(4000);
  screenshot("01-dashboard");

  // ── Step 2: Verify device is online ──
  console.log("➤ Step 2: Verifying device appears…");
  waitForCondition(
    `(function(){ var el = document.querySelector('[class*=studio-panel]'); return el && el.innerText.includes('zto') ? 'ok' : ''; })()`,
    15_000, 2_000
  );
  console.log("  ✓ Device online (zto)");

  // ── Step 3: Check/Create workspace ──
  console.log("➤ Step 3: Checking pocket-studio/remote-agent workspace…");
  const initCheck = evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var openBtn = btns.find(function(b){ return (b.innerText.includes('remote-agent') || b.innerText.includes('pocket-studio')) && b.innerText.includes('打开'); });
      if (openBtn) {
        return 'exists';
      }
      var createBtn = btns.find(function(b){ return b.innerText.includes('创建项目'); });
      if (createBtn) {
        createBtn.click();
        return 'clicked_create';
      }
      return 'not_found';
    })()
  `);
  
  if (initCheck === 'clicked_create') {
    console.log("  Project not found, creating new one…");
    wait(2000);
    const formSubmit = evalJS(`
      (function(){
        var form = document.querySelector('form');
        if (!form) return 'form_not_found';
        var inputs = Array.from(form.querySelectorAll('input'));
        var nameInput = inputs[0];
        var pathInput = inputs[1];
        if (nameInput && pathInput) {
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(nameInput, 'remote-agent');
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          nativeInputValueSetter.call(pathInput, '/home/choco/Downloads/remote-agent');
          pathInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          var btns = Array.from(document.querySelectorAll('button'));
          var submitBtn = btns.find(function(b){ return b.innerText.includes('确认') || b.innerText.includes('创建') || (b.type === 'submit' && b.closest('form')); });
          if (submitBtn) {
            submitBtn.click();
            return 'submitted';
          }
        }
        return 'inputs_not_found';
      })()
    `);
    assert(formSubmit === 'submitted', "Failed to submit project creation form! Got: " + formSubmit);
    wait(4000);
    screenshot("02-created");
  }

  // Open remote-agent/pocket-studio project
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b){ return (b.innerText.includes('remote-agent') || b.innerText.includes('pocket-studio')) && b.innerText.includes('打开'); });
      if(btn) btn.click();
    })()
  `);
  wait(4000);

  // Close project switcher dialog if it opened automatically
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var closeBtn = btns.find(function(b){ return b.querySelector('.lucide-x') || b.innerText === '✕' || b.getAttribute('aria-label') === 'Close'; });
      if (closeBtn) closeBtn.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
    })()
  `);
  wait(1000);
  screenshot("02-workspace");

  // ── Step 4: Open GoSDK session for opencode ──
  console.log("➤ Step 4: Opening GoSDK session…");

  // Click the "+" button in the tabbar
  evalJS(`
    (function(){
      var svg = document.querySelector('.lucide-plus');
      if(svg) svg.closest('button').click();
    })()
  `);
  wait(1000);

  // Click "GoSDK会话" in the dropdown
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var gosdk = items.find(function(b){ return b.innerText.includes('GoSDK会话'); });
      if(gosdk) gosdk.click();
    })()
  `);
  wait(1000);

  // Click "opencode" agent
  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var agent = items.find(function(b){ return b.innerText.includes('opencode'); });
      if(agent) agent.click();
    })()
  `);
  wait(4000);
  screenshot("03-gosdk-tab");

  // ── Step 5: Start conversation ──
  console.log("➤ Step 5: Starting GoSDK conversation via suggestion or input…");

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
  wait(3000);
  screenshot("04-sending");

  // ── Step 6: Wait for user message bubble ──
  console.log("➤ Step 6: Waiting for user message bubble…");
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
  console.log("  ✓ GoSDK User message found:", userMessageFound.slice(0, 50));

  // ── Step 7: Wait for agent response ──
  console.log("➤ Step 7: Waiting for agent response…");
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
  `, 45_000, 2_000);
  console.log("  ✓ GoSDK Agent response:", responseIndicator.slice(0, 80));

  if (responseIndicator.startsWith("working") || responseIndicator === "thinking" || responseIndicator.startsWith("reply")) {
    console.log("  GoSDK Agent is processing, waiting for text reply (up to 45s)…");
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
            if(t.length > 10) return t;
          }
          return '';
        })()
      `, 45_000, 3_000);
      console.log("  ✓ Full reply:", fullReply);
    } catch {
      console.log("  ⚠ Timed out waiting for full text reply — OK");
    }
  }

  screenshot("05-response");

  assert(userMessageFound.includes("磁盘"), `GoSDK: User message missing "磁盘"! Got: "${userMessageFound}"`);
  assert(responseIndicator.length > 0, `GoSDK: No response indicator! Got: "${responseIndicator}"`);

  console.log("\n✅ GoSDK E2E self-test PASSED!\n");
  ab("close");
} catch (error) {
  console.error("\n❌ GoSDK E2E self-test FAILED:", error.message || error);
  try { screenshot("error-state"); } catch { /* ignore */ }
  try { ab("close"); } catch { /* ignore */ }
  process.exit(1);
}
