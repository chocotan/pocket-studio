import { execSync } from "child_process";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
function ab(subCmd) {
  return run(`agent-browser ${subCmd}`);
}

try {
  console.log("Opening dashboard...");
  ab('open "http://127.0.0.1:5173/studio/?server_url=http://127.0.0.1:18080&token=ps_admin_local"');
  ab('wait 3000');

  console.log("Injecting WebSocket hook...");
  ab('eval "(function(){\n' +
     '  if (window.__ws_hooked) return;\n' +
     '  window.__ws_hooked = true;\n' +
     '  window.__ws_log = [];\n' +
     '  const OriginalWebSocket = window.WebSocket;\n' +
     '  window.WebSocket = function(url, protocols) {\n' +
     '    const socket = new OriginalWebSocket(url, protocols);\n' +
     '    const logEntry = { url: url, sent: [], received: [], errors: [] };\n' +
     '    window.__ws_log.push(logEntry);\n' +
     '    const originalSend = socket.send;\n' +
     '    socket.send = function(data) {\n' +
     '      logEntry.sent.push(data);\n' +
     '      return originalSend.apply(this, arguments);\n' +
     '    };\n' +
     '    socket.addEventListener(\'message\', (event) => {\n' +
     '      logEntry.received.push(event.data);\n' +
     '    });\n' +
     '    socket.addEventListener(\'error\', (event) => {\n' +
     '      logEntry.errors.push(\'error event\');\n' +
     '    });\n' +
     '    socket.addEventListener(\'close\', (event) => {\n' +
     '      logEntry.errors.push(\'closed code: \' + event.code + \', reason: \' + event.reason);\n' +
     '    });\n' +
     '    return socket;\n' +
     '  };\n' +
     '})()"');

  console.log("Clicking workspace...");
  run(`agent-browser eval "(function(){ var btns = Array.from(document.querySelectorAll('button')); var btn = btns.find(function(b){ return b.innerText.includes('pocket-studio') && b.innerText.includes('打开'); }); if(btn) btn.click(); })()"`);
  ab('wait 3000');

  console.log("Clicking + button...");
  run(`agent-browser eval "(function(){ var svg = document.querySelector('.lucide-plus'); if(svg) svg.closest('button').click(); })()"`);
  ab('wait 800');

  console.log("Clicking ACPX会话...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var acpx = items.find(function(b){ return b.innerText.includes('ACPX会话'); }); if(acpx) acpx.click(); })()"`);
  ab('wait 800');

  console.log("Clicking opencode agent...");
  run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('[role=menuitem], button')); var agent = items.find(function(b){ return b.innerText.includes('opencode'); }); if(agent) agent.click(); })()"`);
  ab('wait 5000');

  console.log("Sending prompt 'hello'...");
  run(`agent-browser eval "(function(){ var textareas = Array.from(document.querySelectorAll('textarea')); var textarea = textareas.find(function(el) { return window.getComputedStyle(el).visibility !== 'hidden'; }); if(textarea){ var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; nativeInputValueSetter.call(textarea, 'hello'); textarea.dispatchEvent(new Event('input', { bubbles: true })); var form = textarea.closest('form'); if(form){ form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return 'submitted'; } } return 'failed'; })()"`);
  ab('wait 8000');

  console.log("Extracting WebSocket logs...");
  const logs = run(`agent-browser eval "JSON.stringify(window.__ws_log, null, 2)"`);
  console.log("=== WS LOGS ===");
  console.log(logs);

  ab('close');
} catch (err) {
  console.error("Test failed:", err.message);
  try { ab('close'); } catch {}
}
