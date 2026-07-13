#!/usr/bin/env node
/**
 * Advanced E2E self-test for GoSDK agent conversation, tool calls,
 * page refresh recovery, and daemon restart recovery.
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
  const path = `/tmp/e2e-gosdk-adv-${label}.png`;
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

function closeProjectSwitcher() {
  evalJS(`
    (function(){
      var closeBtn = document.querySelector('.absolute.right-4.top-4') || document.querySelector('[class*="DialogClose"]');
      if (closeBtn) {
        closeBtn.click();
      }
      var btns = Array.from(document.querySelectorAll('button'));
      var closeBtnFallback = btns.find(function(b){ return b.querySelector('.lucide-x') || b.innerText === '✕' || b.getAttribute('aria-label') === 'Close'; });
      if (closeBtnFallback) {
        closeBtnFallback.click();
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
    })()
  `);
  wait(1500);
}

/* ── test steps ───────────────────────────────────────────────────── */

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║   Pocket Studio GoSDK Advanced E2E Self-Test & Recovery    ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

try {
  // ── Step 1: Open dashboard ──
  console.log("➤ Step 1: Opening dashboard with dev auth…");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18081&token=dev_token"');
  wait(4000);

  // ── Step 2: Verify device is online ──
  console.log("➤ Step 2: Verifying device appears…");
  waitForCondition(
    `(function(){ var el = document.querySelector('[class*=studio-panel]'); return el && el.innerText.includes('zto') ? 'ok' : ''; })()`,
    15_000, 2_000
  );
  console.log("  ✓ Device online (zto)");

  // ── Step 3: Open remote-agent workspace ──
  console.log("➤ Step 3: Opening remote-agent workspace…");
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b){ return (b.innerText.includes('remote-agent') || b.innerText.includes('pocket-studio')) && b.innerText.includes('打开'); });
      if(btn) btn.click();
    })()
  `);
  wait(4000);
  closeProjectSwitcher();
  screenshot("01-workspace");

  // ── Step 4: Open GoSDK session for opencode ──
  console.log("➤ Step 4: Opening GoSDK session for opencode…");
  closeProjectSwitcher(); // Safeguard modal close

  // Click the "+" button in the tabbar
  evalJS(`
    (function(){
      var btn = document.querySelector('button[title*="新建终端、文件浏览器或 AI 助手窗口"]') || document.querySelector('button[title*="窗口"]');
      if(btn) btn.click();
    })()
  `);
  wait(1500);

  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var gosdk = items.find(function(b){ return b.innerText.includes('GoSDK会话'); });
      if(gosdk) gosdk.click();
    })()
  `);
  wait(1500);

  evalJS(`
    (function(){
      var items = Array.from(document.querySelectorAll('[role=menuitem], button'));
      var agent = items.find(function(b){ return b.innerText.includes('opencode'); });
      if(agent) agent.click();
    })()
  `);
  wait(4000);
  closeProjectSwitcher(); // Safeguard modal close
  screenshot("02-gosdk-tab");

  // ── Step 5: Send Prompt 1: 磁盘剩余空间多少 ──
  console.log("➤ Step 5: Sending prompt 1: '磁盘剩余空间多少'…");
  closeProjectSwitcher(); // Safeguard modal close
  evalJS(`
    (function(){
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
  wait(4000);
  screenshot("03-first-prompt-sent");

  // ── Step 6: Wait for user bubble and agent response ──
  console.log("➤ Step 6: Waiting for user message and response activity…");
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
        if(t.length > 5 && t.includes('磁盘')) return t;
      }
      return '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ User message found in bubble:", userMessageFound);

  const responseIndicator = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var text = chat.innerText;
      if(text.includes('Working') || text.includes('working') || text.includes('思考') || text.includes('tool')) return 'activity';
      var md = chat.querySelectorAll('.markdown-body');
      if (md.length > 0) return 'replied';
      return '';
    })()
  `, 30_000, 2_000);
  console.log("  ✓ Agent response activity detected:", responseIndicator);
  wait(2000);
  screenshot("04-response-activity");

  // ── Step 7: Test Page Refresh ──
  console.log("➤ Step 7: Reloading page to test history recovery…");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18081&token=dev_token"');
  wait(4000);
  
  // Re-open workspace
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b){ return (b.innerText.includes('remote-agent') || b.innerText.includes('pocket-studio')) && b.innerText.includes('打开'); });
      if(btn) btn.click();
    })()
  `);
  wait(4000);
  closeProjectSwitcher();
  screenshot("05-after-refresh");

  // Verify history contains prompt 1
  const historyRecoveredAfterRefresh = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var text = chat.innerText;
      return text.includes('磁盘剩余空间') ? 'recovered' : '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ History recovery after refresh:", historyRecoveredAfterRefresh);

  // ── Step 8: Test Daemon Restart ──
  console.log("➤ Step 8: Simulating Daemon restart…");
  console.log("  Killing daemon process…");
  run("kill -TERM $(cat /tmp/ps-logs/run/daemon.pid) || true");
  wait(2000);

  console.log("  Starting daemon process again…");
  run("go run ./cmd/daemon -daemon.server.url ws://localhost:18081/ws/daemon -daemon.server.token dev_token -daemon.workspace /home/choco/Downloads/remote-agent > /tmp/ps-logs/daemon.log 2>&1 & echo $! > /tmp/ps-logs/run/daemon.pid");
  wait(6000); // Wait for connection

  console.log("  Reloading page after daemon restart…");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18081&token=dev_token"');
  wait(4000);

  // Re-open workspace
  evalJS(`
    (function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var btn = btns.find(function(b){ return (b.innerText.includes('remote-agent') || b.innerText.includes('pocket-studio')) && b.innerText.includes('打开'); });
      if(btn) btn.click();
    })()
  `);
  wait(4000);
  closeProjectSwitcher();
  screenshot("06-after-daemon-restart");

  // Verify history is still loaded after daemon restart
  const historyRecoveredAfterRestart = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var text = chat.innerText;
      return text.includes('磁盘剩余空间') ? 'recovered' : '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ History recovery after daemon restart:", historyRecoveredAfterRestart);

  // ── Step 9: Send Prompt 2: 来点马斯克新闻 ──
  console.log("➤ Step 9: Sending prompt 2: '来点马斯克新闻' in recovered session…");
  closeProjectSwitcher(); // Safeguard modal close
  evalJS(`
    (function(){
      var textareas = Array.from(document.querySelectorAll('textarea'));
      var textarea = textareas.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(textarea){
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, '来点马斯克新闻');
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
  wait(4000);
  screenshot("07-second-prompt-sent");

  const secondUserMessageFound = waitForCondition(`
    (function(){
      var chats = Array.from(document.querySelectorAll('.select-text.overflow-y-auto'));
      var chat = chats.find(function(el) {
        return window.getComputedStyle(el).visibility !== 'hidden';
      });
      if(!chat) return '';
      var divs = chat.querySelectorAll('.bg-primary');
      for(var i=0;i<divs.length;i++){
        var t = divs[i].innerText.trim();
        if(t.length > 5 && t.includes('马斯克')) return t;
      }
      return '';
    })()
  `, 15_000, 2_000);
  console.log("  ✓ Second prompt user bubble found:", secondUserMessageFound);

  console.log("\n✅ GoSDK Advanced E2E Self-Test & Recovery PASSED!\n");
  ab("close");
} catch (error) {
  console.error("\n❌ GoSDK Advanced E2E Self-Test FAILED:", error.message || error);
  try { screenshot("error-state"); } catch { /* ignore */ }
  try { ab("close"); } catch { /* ignore */ }
  process.exit(1);
}
