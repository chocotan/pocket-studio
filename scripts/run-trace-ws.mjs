import { execSync } from "child_process";

function run(cmd, env = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    env: { ...process.env, ...env }
  }).trim();
}

const env = {
  AGENT_BROWSER_INIT_SCRIPTS: "/home/choco/Downloads/pocket-studio/scripts/hook-ws.js"
};

function ab(subCmd) {
  return run(`agent-browser ${subCmd}`, env);
}

try {
  console.log("Opening dashboard with hook...");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18080&token=ps_admin_local"');
  ab('wait 3000');

  console.log("Clicking workspace...");
  run(`agent-browser eval "(function(){ var btns = Array.from(document.querySelectorAll('button')); var btn = btns.find(function(b){ return b.innerText.includes('pocket-studio') && b.innerText.includes('打开'); }); if(btn) btn.click(); })()"`, env);
  ab('wait 3000');

  console.log("Clicking + button...");
  run(`agent-browser eval "(function(){ var svg = document.querySelector('.lucide-plus'); if(svg) svg.closest('button').click(); })()"`, env);
  ab('wait 800');

  console.log("Clicking ACPX会话...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var acpx = items.find(function(b){ return b.innerText.includes('ACPX会话'); }); if(acpx) acpx.click(); })()"`, env);
  ab('wait 800');

  console.log("Clicking opencode agent...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var agent = items.find(function(b){ return b.innerText.includes('opencode'); }); if(agent) agent.click(); })()"`, env);
  ab('wait 3000');

  console.log("Sending prompt 'hello'...");
  const res = run(`agent-browser eval "(function(){ var textareas = Array.from(document.querySelectorAll('textarea')); var textarea = textareas.find(function(el) { return window.getComputedStyle(el).visibility !== 'hidden'; }); if(textarea){ var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; nativeInputValueSetter.call(textarea, 'hello'); textarea.dispatchEvent(new Event('input', { bubbles: true })); var form = textarea.closest('form'); if(form){ form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return 'submitted'; } } return 'failed'; })()"`, env);
  console.log("  Prompt send result:", res);
  
  console.log("Waiting 15 seconds for agent to respond...");
  ab('wait 15000');
  
  ab('screenshot /tmp/opencode-step3-fresh2.png');

  console.log("Extracting WebSocket logs...");
  const logs = run(`agent-browser eval "JSON.stringify(window.__ws_log, null, 2)"`, env);
  console.log("=== WS LOGS ===");
  console.log(logs);

  ab('close');
  console.log("Done!");
} catch (err) {
  console.error("Test failed:", err.message);
  try { ab('close'); } catch {}
}
