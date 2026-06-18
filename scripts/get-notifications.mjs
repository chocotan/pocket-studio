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

  console.log("Clicking workspace...");
  run(`agent-browser eval "(function(){ var btns = Array.from(document.querySelectorAll('button')); var btn = btns.find(function(b){ return b.innerText.includes('pocket-studio') && b.innerText.includes('打开'); }); if(btn) btn.click(); })()"`);
  ab('wait 3000');

  console.log("Opening notifications center...");
  run(`agent-browser eval "(function(){ var btn = document.querySelector('.studio-notification-button'); if(btn) btn.click(); })()"`);
  ab('wait 1000');
  ab('screenshot /tmp/notifications-open.png');

  console.log("Extracting notifications text...");
  const text = run(`agent-browser eval "(function(){ var items = Array.from(document.querySelectorAll('.absolute.right-0.top-9 button')); return items.map(function(item) { return item.innerText.replace(/\\n/g, ' | '); }).join('\\n'); })()"`);
  console.log("Notifications:");
  console.log(text);

  ab('close');
} catch (err) {
  console.error("Failed:", err.message);
  try { ab('close'); } catch {}
}
