import { execSync } from "child_process";
import fs from "fs";

const env = {
  ...process.env,
  AGENT_BROWSER_INIT_SCRIPTS: new URL("./hook-ws.js", import.meta.url).pathname
};

function run(cmd, capture = true) {
  const result = execSync(cmd, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: env,
    stdio: capture ? "pipe" : "ignore"
  });
  return capture ? result.trim() : "";
}
function ab(subCmd, capture = false) {
  return run(`agent-browser ${subCmd}`, capture);
}

try {
  console.log("Opening dashboard...");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18080&token=ps_admin_local"');
  ab('wait 3000');
  ab('screenshot /tmp/opencode-step1.png');

  console.log("Clicking workspace...");
  run(`agent-browser eval "(function(){ var btns = Array.from(document.querySelectorAll('button')); var btn = btns.find(function(b){ return b.innerText.includes('pocket-studio') && b.innerText.includes('打开'); }); if(btn) btn.click(); })()"`, false);
  ab('wait 3000');

  console.log("Clicking + button...");
  run(`agent-browser eval "(function(){ var svg = document.querySelector('.lucide-plus'); if(svg) svg.closest('button').click(); })()"`, false);
  ab('wait 800');

  console.log("Clicking ACPX会话...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var acpx = items.find(function(b){ return b.innerText.includes('ACPX会话'); }); if(acpx) acpx.click(); })()"`, false);
  ab('wait 800');

  console.log("Clicking opencode agent...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var agent = items.find(function(b){ return b.innerText.includes('opencode'); }); if(agent) agent.click(); })()"`, false);
  ab('wait 3000');
  ab('screenshot /tmp/opencode-step2.png');

  console.log("Sending prompt 'hello'...");
  const res = run(`agent-browser eval "(function(){ var textareas = Array.from(document.querySelectorAll('textarea')); var textarea = textareas.find(function(el) { return window.getComputedStyle(el).visibility !== 'hidden'; }); if(textarea){ var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; nativeInputValueSetter.call(textarea, 'hello'); textarea.dispatchEvent(new Event('input', { bubbles: true })); var form = textarea.closest('form'); if(form){ form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return 'submitted'; } } return 'failed'; })()"`);
  console.log("  Prompt send result:", res);
  ab('wait 25000');
  ab('screenshot /tmp/opencode-step3.png');

  const logs = run(`agent-browser eval "JSON.stringify((window.__ws_log || []).map(conn => ({ ...conn, received: conn.received.map(msg => { try { const p = JSON.parse(msg); if (p.payload && p.payload.data) { if (p.payload.data.models) p.payload.data.models.availableModels = ['hidden']; if (p.payload.data.tools) p.payload.data.tools = ['hidden']; } return JSON.stringify(p); } catch(e) { return msg; } }) })), null, 2)"`);
  console.log("=== WS LOGS ===");
  console.log(logs);

  console.log("Extracting Browser Debug logs...");
  const debugLogs = run(`agent-browser eval "JSON.stringify(window.__debug_log || [], null, 2)"`);
  console.log("=== BROWSER DEBUG LOGS ===");
  console.log(debugLogs);

  ab('close');
  console.log("Done!");
} catch (err) {
  console.error("Test failed:", err.message);
  try { ab('close'); } catch {}
}
