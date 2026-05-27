package server

import "net/http"

func ServeIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(indexHTML))
}

const indexHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PocketStudio</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef1f6;
      --chrome: #ffffff;
      --sidebar: #f7f8fb;
      --panel: #ffffff;
      --panel-2: #f2f4f8;
      --panel-3: #e9edf5;
      --line: #d9dee8;
      --line-strong: #c4cad7;
      --text: #151923;
      --muted: #667085;
      --faint: #8a94a6;
      --accent: #7c3aed;
      --accent-2: #16a36a;
      --accent-soft: rgba(124, 58, 237, .11);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, .08);
      --warn: #b7791f;
      --shadow: 0 18px 45px rgba(24, 35, 66, .10);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      height: 100dvh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }

    button, textarea, input {
      font: inherit;
    }

    button {
      color: inherit;
    }

    .app {
      display: grid;
      grid-template-columns: 184px minmax(420px, 1fr) 340px;
      height: 100dvh;
      min-height: 0;
      overflow: hidden;
      padding: 10px;
      gap: 10px;
    }

    .sidebar, .main, .inspector {
      min-height: 0;
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .sidebar {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      border-radius: 14px;
      overflow: hidden;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--sidebar);
    }

    .brand-mark {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, #8b5cf6, #4f46e5);
      color: white;
      font-weight: 800;
      font-size: 13px;
    }

    .brand-title {
      font-weight: 700;
      line-height: 1.15;
    }

    .brand-subtitle {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }

    .nav-scroll {
      overflow: auto;
      padding: 12px 10px;
    }

    .section {
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }

    .nav-section {
      margin-bottom: 18px;
    }

    .nav-label, h2 {
      margin: 0 0 8px;
      color: var(--faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    .nav-item, .device, .workspace, .task-row {
      width: 100%;
      min-height: 38px;
      display: flex;
      align-items: center;
      gap: 9px;
      border: 1px solid transparent;
      border-radius: 9px;
      background: transparent;
      color: var(--muted);
      padding: 8px 9px;
      text-align: left;
      cursor: pointer;
    }

    .nav-item:hover, .device:hover, .workspace:hover, .task-row:hover {
      background: #eef1f7;
      color: var(--text);
    }

    .device, .workspace, .task-row {
      align-items: flex-start;
      margin-bottom: 7px;
      border-color: var(--line);
      background: #ffffff;
    }

    .device.active, .workspace.active {
      border-color: rgba(139, 92, 246, .55);
      background: var(--accent-soft);
      color: var(--text);
    }

    .item-icon {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: rgba(139, 92, 246, .14);
      color: #6d28d9;
      font-size: 12px;
      font-weight: 700;
    }

    .item-main {
      min-width: 0;
      flex: 1;
    }

    .item-title {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }

    .muted, .item-meta {
      color: var(--muted);
    }

    .item-meta {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
      font-size: 12px;
    }

    .account {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 12px 14px;
      border-top: 1px solid var(--line);
      background: var(--sidebar);
    }

    .avatar {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: #ea580c;
      color: white;
      font-size: 12px;
      font-weight: 800;
    }

    .main {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      border-radius: 14px;
      overflow: hidden;
      background: #f8fafc;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 58px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--chrome);
    }

    .mobile-actions {
      display: none;
      gap: 8px;
      margin-bottom: 8px;
    }

    h1 {
      margin: 0;
      font-size: 14px;
      line-height: 1.25;
      font-weight: 750;
    }

    .subtitle {
      margin: 4px 0 0;
      max-width: 68vw;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: #ffffff;
      font-size: 12px;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--accent-2);
      box-shadow: 0 0 0 3px rgba(34, 197, 94, .14);
    }

    .task-strip {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: #f7f8fb;
      overflow: auto;
    }

    .strip-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: #ffffff;
      font-size: 12px;
      white-space: nowrap;
    }

    .strip-pill strong {
      color: var(--text);
      font-weight: 650;
    }

    .events {
      min-height: 0;
      height: 100%;
      max-height: 100%;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 18px 18px 90px;
    }

    .empty-state {
      height: 100%;
      min-height: 260px;
      display: grid;
      place-items: center;
      color: var(--faint);
      text-align: center;
    }

    .event {
      position: relative;
      max-width: 860px;
      margin: 0 auto 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
    }

    .event.user {
      border-color: rgba(139, 92, 246, .46);
      background: rgba(124, 58, 237, .07);
    }

    .event.error, .event.failed {
      border-color: rgba(239, 68, 68, .46);
      background: var(--danger-soft);
    }

    .event.completed {
      border-color: rgba(34, 197, 94, .42);
    }

    .event-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }

    .event-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--text);
      font-weight: 650;
    }

    .event-badge {
      display: inline-grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      border-radius: 5px;
      background: rgba(139, 92, 246, .16);
      color: #6d28d9;
      font-size: 10px;
      font-weight: 800;
    }

    .event-sequence {
      color: var(--faint);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    pre {
      margin: 0;
      padding: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: #202938;
      background: #f8fafc;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
    }

    .event-body {
      padding: 10px;
    }

    .event-summary {
      margin: 0;
      color: var(--text);
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .event-kv {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 5px 10px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .tool-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .tool-status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--warn);
    }

    .tool-status.done::before { background: var(--accent-2); }
    .tool-status.error::before { background: var(--danger); }

    .tool-section {
      padding: 10px;
      border-top: 1px solid var(--line);
    }

    .tool-section:first-of-type {
      border-top: 0;
    }

    .tool-section-label {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .tool-result-section {
      background: #eefcf5;
      border-top: 1px solid #b7ebd0;
    }

    .tool-result-section.error {
      background: #fff1f2;
      border-top-color: #fecdd3;
    }

    .tool-result-content {
      margin: 0;
      padding: 10px;
      border: 1px solid #b7ebd0;
      border-radius: 7px;
      background: #f8fffb;
      color: #064e3b;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-result-section.error .tool-result-content {
      border-color: #fecdd3;
      background: #fffafa;
      color: #7f1d1d;
    }

    .event-kv code {
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      word-break: break-all;
    }

    .raw-details {
      margin-top: 10px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }

    .raw-details summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
      user-select: none;
    }

    .raw-details pre {
      margin-top: 8px;
      max-height: 320px;
      overflow: auto;
    }

    .composer {
      padding: 12px;
      border-top: 1px solid var(--line);
      background: #ffffff;
    }

    .composer-shell {
      max-width: 920px;
      margin: 0 auto;
      border: 1px solid rgba(139, 92, 246, .38);
      border-radius: 14px;
      background: #ffffff;
      box-shadow: 0 0 0 1px rgba(124, 58, 237, .06), 0 16px 34px rgba(24, 35, 66, .10);
      overflow: hidden;
    }

    textarea {
      width: 100%;
      min-height: 74px;
      max-height: 220px;
      resize: vertical;
      display: block;
      border: 0;
      outline: none;
      padding: 13px 14px;
      color: var(--text);
      background: transparent;
      line-height: 1.5;
    }

    textarea::placeholder {
      color: var(--faint);
    }

    .controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px;
      border-top: 1px solid var(--line);
    }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    input[type="checkbox"] {
      accent-color: var(--accent);
    }

    button.primary, button.danger, button.ghost {
      min-height: 38px;
      border: 1px solid transparent;
      border-radius: 9px;
      padding: 0 13px;
      cursor: pointer;
    }

    button.primary {
      background: linear-gradient(135deg, #8b5cf6, #6d5dfc);
      color: white;
      font-weight: 700;
    }

    button.danger {
      width: 100%;
      background: #dc2626;
      color: white;
      font-weight: 700;
    }

    button.ghost {
      border-color: var(--line);
      background: #ffffff;
      color: var(--text);
    }

    button:disabled {
      opacity: .48;
      cursor: not-allowed;
    }

    .inspector {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      border-radius: 14px;
      overflow: hidden;
    }

    .metric {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 34px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
    }

    .metric span:last-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .activity {
      min-height: 0;
      overflow: auto;
      padding: 14px;
    }

    .activity-line {
      display: flex;
      gap: 9px;
      padding: 8px 0;
      color: var(--muted);
      font-size: 12px;
      border-bottom: 1px solid #edf0f5;
    }

    .activity-line::before {
      content: "";
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      margin-top: 5px;
      border-radius: 999px;
      background: var(--accent);
    }

    @media (max-width: 1080px) {
      .app {
        grid-template-columns: 184px minmax(360px, 1fr);
      }
      .inspector {
        display: none;
        position: fixed;
        z-index: 20;
        top: 10px;
        right: 10px;
        bottom: 10px;
        width: min(88vw, 360px);
      }
      .inspector.open { display: grid; }
      .mobile-actions { display: flex; }
    }

    @media (max-width: 760px) {
      .app {
        display: block;
        height: 100dvh;
        overflow: hidden;
        padding: 0;
      }
      .main {
        height: 100dvh;
        border-radius: 0;
        border: 0;
      }
      .sidebar {
        display: none;
        position: fixed;
        z-index: 20;
        top: 10px;
        bottom: 10px;
        left: 10px;
        width: min(88vw, 330px);
      }
      .sidebar.open { display: grid; }
      .topbar {
        min-height: 70px;
      }
      .task-strip {
        padding: 8px 12px;
      }
      .events {
        padding: 12px 12px 84px;
      }
      .composer {
        padding: 10px;
      }
      .controls {
        align-items: stretch;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside id="sidebar" class="sidebar">
      <div class="brand">
        <div class="brand-mark">PS</div>
        <div>
          <div class="brand-title">PocketStudio</div>
          <div id="conn" class="brand-subtitle">Connecting...</div>
        </div>
      </div>

      <div class="nav-scroll">
        <div class="nav-section">
          <div class="nav-label">概览</div>
          <button class="nav-item"><span class="item-icon">W</span><span class="item-main"><span class="item-title">工作台</span></span></button>
          <button class="nav-item"><span class="item-icon">S</span><span class="item-main"><span class="item-title">会话</span></span></button>
        </div>

        <div class="nav-section">
          <div class="nav-label">设备</div>
          <div id="devices"></div>
        </div>

        <div class="nav-section">
          <div class="nav-label">工作区</div>
          <div id="workspaces"></div>
        </div>

        <div class="nav-section">
          <div class="nav-label">当前会话任务</div>
          <div id="tasks"></div>
        </div>
      </div>

      <div class="account">
        <div class="avatar">LC</div>
        <div class="item-main">
          <span class="item-title">local user</span>
          <span class="item-meta">Claude Code</span>
        </div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="mobile-actions">
            <button class="ghost" onclick="togglePanel('sidebar')">菜单</button>
            <button class="ghost" onclick="togglePanel('inspector')">详情</button>
          </div>
          <h1 id="title">选择设备和工作区</h1>
          <p class="subtitle" id="subtitle">Claude Code</p>
        </div>
        <div class="top-actions">
          <span class="status"><span class="dot"></span><span id="onlineCount">0 online</span></span>
          <button id="topStop" class="ghost" onclick="stopTask()" disabled>停止</button>
        </div>
      </header>

      <section class="task-strip">
        <span class="strip-pill"><strong>Engine</strong> Claude Code</span>
        <span class="strip-pill"><strong>Mode</strong> stream-json</span>
        <span class="strip-pill"><strong>Shell</strong> <span id="shellState">manual</span></span>
        <span class="strip-pill"><strong>Session</strong> <span id="sessionState">new</span></span>
      </section>

      <section id="events" class="events"></section>

      <section class="composer">
        <div class="composer-shell">
          <textarea id="prompt" placeholder="Ctrl+Enter 发送任务给 Claude Code"></textarea>
          <div class="controls">
            <label class="toggle"><input id="autoShell" type="checkbox" onchange="updateShellState()" /> 允许自动 Shell</label>
            <button id="send" class="primary" onclick="dispatchTask()">发送</button>
          </div>
        </div>
      </section>
    </main>

    <aside id="inspector" class="inspector">
      <div class="section">
        <h2>当前任务</h2>
        <div class="metric"><span>Task</span><span id="taskId">-</span></div>
        <div class="metric"><span>Status</span><span id="taskStatus">idle</span></div>
        <div class="metric"><span>Events</span><span id="eventCount">0</span></div>
      </div>
      <div class="section">
        <h2>控制</h2>
        <button id="stop" class="danger" onclick="stopTask()" disabled>Stop Task</button>
      </div>
      <div class="activity">
        <h2>执行流</h2>
        <div id="activity"></div>
      </div>
    </aside>
  </div>

  <script>
    let ws;
    let devices = [];
    let selectedDeviceId = "";
    let selectedWorkspaceId = "";
    let currentTaskId = "";
    let currentStatus = "idle";
    let events = [];
    let tasks = [];
    let taskRecords = new Map();

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/ws/web");
      ws.onopen = () => setConn("Connected");
      ws.onclose = () => { setConn("Disconnected"); setTimeout(connect, 1200); };
      ws.onmessage = (message) => {
        const env = JSON.parse(message.data);
        if (env.type === "server.state") {
          const state = env.payload || {};
          devices = state.devices || [];
          ingestTasks(state.tasks || []);
          renderSidebar();
        } else if (env.type === "task.event") {
          const payload = env.payload || {};
          if (!currentTaskId || payload.task_id === currentTaskId) {
            currentTaskId = payload.task_id;
            mergeTaskEvent(payload);
            const record = taskRecords.get(payload.task_id);
            events = record && record.events ? record.events.slice() : events.concat([payload]);
            currentStatus = statusFromEvent(payload.event_type);
            renderEvents();
            renderInspector(currentStatus);
          }
        } else if (env.type === "server.error") {
          events.push({ event_type: "server.error", data: env.payload });
          currentStatus = "error";
          renderEvents();
          renderInspector(currentStatus);
        }
      };
    }

    function setConn(text) {
      document.getElementById("conn").textContent = text;
    }

    function renderSidebar() {
      document.getElementById("onlineCount").textContent = devices.length + " online";
      const deviceWrap = document.getElementById("devices");
      deviceWrap.innerHTML = "";
      devices.forEach((device) => {
        const btn = document.createElement("button");
        btn.className = "device" + (device.id === selectedDeviceId ? " active" : "");
        btn.innerHTML = "<span class='item-icon'>D</span><span class='item-main'><span class='item-title'>" + escapeHtml(device.name || device.id) + "</span><span class='item-meta'>" + escapeHtml(device.id) + "</span></span>";
        btn.onclick = () => {
          selectedDeviceId = device.id;
          selectedWorkspaceId = (device.workspaces && device.workspaces[0] && device.workspaces[0].id) || "";
          renderSidebar();
          updateTitle();
          closePanels();
        };
        deviceWrap.appendChild(btn);
      });
      if (!selectedDeviceId && devices[0]) {
        selectedDeviceId = devices[0].id;
        selectedWorkspaceId = (devices[0].workspaces && devices[0].workspaces[0] && devices[0].workspaces[0].id) || "";
      }

      const device = devices.find((item) => item.id === selectedDeviceId);
      const workspaceWrap = document.getElementById("workspaces");
      workspaceWrap.innerHTML = "";
      (device && device.workspaces || []).forEach((workspace) => {
        const btn = document.createElement("button");
        btn.className = "workspace" + (workspace.id === selectedWorkspaceId ? " active" : "");
        btn.innerHTML = "<span class='item-icon'>P</span><span class='item-main'><span class='item-title'>" + escapeHtml(workspace.name) + "</span><span class='item-meta'>" + escapeHtml(workspace.path) + "</span></span>";
        btn.onclick = () => { selectedWorkspaceId = workspace.id; renderSidebar(); updateTitle(); closePanels(); };
        workspaceWrap.appendChild(btn);
      });
      if (!workspaceWrap.innerHTML) workspaceWrap.innerHTML = "<p class='muted'>没有工作区</p>";

      const taskWrap = document.getElementById("tasks");
      taskWrap.innerHTML = "";
      tasks.forEach((task) => {
        const record = taskRecords.get(task);
        const row = document.createElement("button");
        row.className = "task-row";
        row.innerHTML = "<span class='item-icon'>T</span><span class='item-main'><span class='item-title'>" + escapeHtml((record && record.prompt) || task) + "</span><span class='item-meta'>" + escapeHtml((record && record.status) || "running") + " · " + escapeHtml(task) + "</span></span>";
        row.onclick = () => { selectTask(task); closePanels(); };
        taskWrap.appendChild(row);
      });
      if (!taskWrap.innerHTML) taskWrap.innerHTML = "<p class='muted'>暂无任务</p>";
      updateTitle();
    }

    function updateTitle() {
      const device = devices.find((item) => item.id === selectedDeviceId);
      const workspace = device && (device.workspaces || []).find((item) => item.id === selectedWorkspaceId);
      document.getElementById("title").textContent = device ? device.name : "选择设备和工作区";
      document.getElementById("subtitle").textContent = workspace ? workspace.path : "Claude Code";
      updateSendButton();
    }

    function dispatchTask() {
      const prompt = document.getElementById("prompt").value.trim();
      const device = devices.find((item) => item.id === selectedDeviceId);
      const workspace = device && (device.workspaces || []).find((item) => item.id === selectedWorkspaceId);
      if (!prompt || !device || !workspace || !ws || ws.readyState !== WebSocket.OPEN) return;
      const parentRecord = currentTaskId ? taskRecords.get(currentTaskId) : null;
      const resumeSessionId = parentRecord && parentRecord.session_id ? parentRecord.session_id : "";
      const parentTaskId = resumeSessionId ? currentTaskId : "";
      const taskId = resumeSessionId && currentTaskId ? currentTaskId : "tsk_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2, 8);
      currentTaskId = taskId;
      currentStatus = "running";
      if (!tasks.includes(taskId)) tasks.unshift(taskId);
      const userEvent = { task_id: taskId, event_type: "user.prompt", data: { prompt }, source: "web" };
      events = resumeSessionId ? events.concat([userEvent]) : [userEvent];
      const existingRecord = taskRecords.get(taskId) || {};
      taskRecords.set(taskId, {
        ...existingRecord,
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: workspace.path,
        prompt,
        parent_task_id: parentTaskId,
        resume_session_id: resumeSessionId,
        session_id: resumeSessionId || existingRecord.session_id,
        status: "running",
        events: events
      });
      renderSidebar();
      renderEvents();
      renderInspector(currentStatus);
      ws.send(JSON.stringify({
        id: "msg_" + Date.now(),
        type: "task.dispatch",
        version: 1,
        timestamp: Math.floor(Date.now() / 1000),
        from: "web",
        to: { device_id: device.id },
        payload: {
          task_id: taskId,
          workspace_id: workspace.id,
          workspace_path: workspace.path,
          agent: "claude_code",
          prompt,
          parent_task_id: parentTaskId,
          resume_session_id: resumeSessionId,
          options: {
            auto_shell: document.getElementById("autoShell").checked,
            allowed_tools: ["file", "bash"],
            timeout_seconds: 3600
          }
        }
      }));
      document.getElementById("prompt").value = "";
      updateSendButton();
    }

    function stopTask() {
      if (!currentTaskId || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        id: "msg_" + Date.now(),
        type: "task.stop",
        version: 1,
        timestamp: Math.floor(Date.now() / 1000),
        from: "web",
        payload: { task_id: currentTaskId, reason: "user_requested" }
      }));
      currentStatus = "stopping";
      renderInspector(currentStatus);
    }

    function renderEvents() {
      const wrap = document.getElementById("events");
      const wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
      wrap.innerHTML = "";
      const timelineItems = buildTimelineItems(events);
      if (!timelineItems.length) {
        wrap.innerHTML = "<div class='empty-state'><div><h1>等待任务</h1><p class='muted'>选择设备和工作区后发送指令</p></div></div>";
        renderActivity();
        return;
      }
      timelineItems.forEach((item) => {
        const div = document.createElement("div");
        div.className = "event " + eventClass(item.event.event_type);
        div.innerHTML = item.kind === "tool" ? renderToolItemHTML(item) : renderEventHTML(item.event, describeEvent(item.event));
        wrap.appendChild(div);
      });
      if (wasAtBottom) wrap.scrollTop = wrap.scrollHeight;
      document.getElementById("eventCount").textContent = events.length;
      renderActivity();
    }

    function buildTimelineItems(sourceEvents) {
      const items = [];
      const toolItems = new Map();
      sourceEvents.forEach((event) => {
        if (!isMainEvent(event)) return;
        const payload = normalizePayload(event.raw);
        if (event.event_type === "tool.call") {
          const toolUse = extractToolUse(payload);
          const id = toolUse.id || toolUse.tool_use_id || event.event_id || "tool-" + items.length;
          const item = { kind: "tool", id, event, call: toolUse, result: null };
          toolItems.set(id, item);
          items.push(item);
          return;
        }
        if (event.event_type === "tool.output" || isToolResultPayload(payload)) {
          const resultID = extractToolResultID(payload);
          const existing = resultID ? toolItems.get(resultID) : null;
          if (existing) {
            existing.result = event;
            return;
          }
          items.push({ kind: "tool", id: resultID || event.event_id, event, call: null, result: event });
          return;
        }
        items.push({ kind: "event", event });
      });
      return items;
    }

    function isMainEvent(event) {
      const type = event.event_type || "";
      if (type === "user.prompt") return true;
      if (type === "assistant.message") return hasVisibleText(event);
      if (type === "tool.call") return true;
      if (type === "tool.output") return true;
      if (type === "task.failed" || type === "task.killed" || type === "server.error") return true;
      if (type === "claude.raw") {
        const payload = normalizePayload(event.raw);
        const rawType = payload.type || payload.subtype || "";
        if (isToolResultPayload(payload)) return true;
        if (rawType === "system" || rawType === "result") return false;
        return hasVisibleText(event);
      }
      return false;
    }

    function hasVisibleText(event) {
      const data = normalizePayload(event.data);
      const raw = normalizePayload(event.raw);
      return Boolean(extractText(data) || extractText(raw) || data.text || data.command || raw.command);
    }

    function ingestTasks(records) {
      records.forEach((record) => {
        if (!record || !record.task_id) return;
        taskRecords.set(record.task_id, record);
      });
      tasks = Array.from(taskRecords.values())
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .map((record) => record.task_id);
      if (!currentTaskId && tasks[0]) selectTask(tasks[0], false);
    }

    function mergeTaskEvent(event) {
      if (!event || !event.task_id) return;
      const record = taskRecords.get(event.task_id) || { task_id: event.task_id, status: "running", events: [] };
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) record.session_id = sessionID;
      record.status = statusFromEvent(event.event_type);
      record.updated_at = Math.floor(Date.now() / 1000);
      record.events = record.events || [];
      if (!isDuplicateEvent(record.events, event)) record.events.push(event);
      taskRecords.set(event.task_id, record);
      if (!tasks.includes(event.task_id)) tasks.unshift(event.task_id);
    }

    function isDuplicateEvent(items, event) {
      if (!event) return false;
      if (event.event_id && items.some((item) => item.event_id === event.event_id)) return true;
      if (event.uuid && items.some((item) => item.uuid === event.uuid)) return true;
      if (event.event_type !== "user.prompt") return false;
      const prompt = normalizePayload(event.data).prompt || "";
      return items.some((item) => item.event_type === "user.prompt" && (normalizePayload(item.data).prompt || "") === prompt);
    }

    function selectTask(taskId, shouldRender = true) {
      currentTaskId = taskId;
      const record = taskRecords.get(taskId);
      currentStatus = (record && record.status) || "running";
      events = (record && record.events) ? record.events.slice() : [];
      if (shouldRender) {
        renderEvents();
        renderInspector(currentStatus);
        renderSidebar();
      }
      updateSendButton();
    }

    function renderActivity() {
      const activity = document.getElementById("activity");
      activity.innerHTML = "";
      events.slice(-12).reverse().forEach((event) => {
        const row = document.createElement("div");
        row.className = "activity-line";
        const view = describeEvent(event);
        row.textContent = view.title + (event.sequence ? " #" + event.sequence : "");
        activity.appendChild(row);
      });
      if (!activity.innerHTML) activity.innerHTML = "<p class='muted'>暂无执行事件</p>";
    }

    function renderInspector(status) {
      document.getElementById("taskId").textContent = currentTaskId || "-";
      document.getElementById("taskStatus").textContent = status || (currentTaskId ? "running" : "idle");
      document.getElementById("stop").disabled = !currentTaskId || status === "stopping" || status === "completed" || status === "failed" || status === "killed";
      document.getElementById("topStop").disabled = document.getElementById("stop").disabled;
      document.getElementById("eventCount").textContent = events.length;
      updateSendButton();
    }

    function updateSendButton() {
      const btn = document.getElementById("send");
      if (!btn) return;
      const record = currentTaskId ? taskRecords.get(currentTaskId) : null;
      btn.textContent = record && record.session_id ? "继续对话" : "发送";
      const sessionState = document.getElementById("sessionState");
      if (sessionState) sessionState.textContent = record && record.session_id ? shortID(record.session_id) : "new";
    }

    function updateShellState() {
      document.getElementById("shellState").textContent = document.getElementById("autoShell").checked ? "auto" : "manual";
    }

    function statusFromEvent(type) {
      if (type === "task.completed") return "completed";
      if (type === "task.failed") return "failed";
      if (type === "task.killed") return "killed";
      if (type === "task.stopping") return "stopping";
      return "running";
    }

    function eventClass(type) {
      if (type === "user.prompt") return "user";
      if (type === "task.failed" || type === "server.error") return "failed";
      if (type === "task.completed") return "completed";
      return "";
    }

    function eventInitial(type) {
      if (!type) return "E";
      const parts = type.split(".");
      return (parts[0][0] || "E").toUpperCase();
    }

    function renderEventHTML(event, view) {
      const meta = view.meta || [];
      const metaHTML = meta.length
        ? "<div class='event-kv'>" + meta.map(([key, value]) => "<span>" + escapeHtml(key) + "</span><code>" + escapeHtml(value) + "</code>").join("") + "</div>"
        : "";
      return "<div class='event-title'><span class='event-name'><span class='event-badge'>" + eventInitial(event.event_type) + "</span>" + escapeHtml(view.title) + "</span><span class='event-sequence'>" + escapeHtml(String(event.sequence || "")) + "</span></div><div class='event-body'><p class='event-summary'>" + escapeHtml(view.summary || "") + "</p>" + metaHTML + "</div>";
    }

    function renderToolItemHTML(item) {
      const callPayload = normalizePayload(item.event.raw);
      const toolUse = item.call || extractToolUse(callPayload);
      const resultPayload = item.result ? normalizePayload(item.result.raw) : {};
      const name = toolUse.name || "tool";
      const input = toolUse.input || {};
      const target = toolTarget(name, input);
      const outputView = item.result ? describeToolOutput(normalizePayload(item.result.data), resultPayload) : null;
      const hasError = Boolean(resultPayload.tool_use_result && (resultPayload.tool_use_result.is_error || resultPayload.tool_use_result.stderr));
      const statusClass = item.result ? (hasError ? "error" : "done") : "";
      const statusText = item.result ? (hasError ? "执行失败" : "执行完成") : "执行中";
      const outputHTML = outputView
        ? "<div class='tool-section tool-result-section " + (hasError ? "error" : "") + "'><p class='tool-section-label'>执行工具结果</p><pre class='tool-result-content'>" + escapeHtml(outputView.summary || "") + "</pre></div>"
        : "";
      const meta = [
        ["工具", name],
        target ? ["目标", target] : null
      ].filter(Boolean);
      const metaHTML = meta.length
        ? "<div class='event-kv'>" + meta.map(([key, value]) => "<span>" + escapeHtml(key) + "</span><code>" + escapeHtml(value) + "</code>").join("") + "</div>"
        : "";
      return "<div class='event-title'><span class='event-name'><span class='event-badge'>T</span>" + escapeHtml(toolTitle(name, input)) + "</span><span class='tool-status " + statusClass + "'>" + statusText + "</span></div><div class='tool-section'><p class='tool-section-label'>执行工具内容</p><p class='event-summary'>" + escapeHtml(toolUseSummary(name, input)) + "</p>" + metaHTML + "</div>" + outputHTML;
    }

    function describeEvent(event) {
      const data = normalizePayload(event.data);
      const raw = normalizePayload(event.raw);
      const payload = raw || data || {};
      const type = event.event_type || "";

      if (isToolResultPayload(payload)) {
        return describeToolOutput(data, payload);
      }
      if (type === "user.prompt") {
        return { title: "用户指令", summary: data.prompt || "" };
      }
      if (type === "task.started") {
        return {
          title: "任务已启动",
          summary: data.args && data.args.includes("--resume") ? "Claude Code 已继续上一段会话。" : "Claude Code 已在目标工作区开始执行。",
          meta: [
            ["工作区", data.workspace || ""],
            ["命令", formatCommand(data.command, data.args)]
          ].filter((item) => item[1])
        };
      }
      if (type === "task.completed") {
        return { title: "任务完成", summary: "Claude Code 已正常退出。", meta: [["退出码", String(data.exit_code ?? 0)]] };
      }
      if (type === "task.failed") {
        return { title: "任务失败", summary: data.message || data.error || "任务执行失败。", meta: data.code ? [["错误码", data.code]] : [] };
      }
      if (type === "task.killed") {
        return { title: "任务已停止", summary: "用户已停止该任务。", meta: data.reason ? [["原因", data.reason]] : [] };
      }
      if (type === "task.stopping") {
        return { title: "正在停止", summary: "正在向 Claude Code 进程发送停止信号。" };
      }
      if (type === "tool.output") {
        return describeToolOutput(data, payload);
      }
      if (type === "tool.call") {
        return describeToolCall(payload);
      }
      if (type === "assistant.message") {
        return { title: "Claude 回复", summary: extractText(payload) || "Claude 返回了一条消息。" };
      }
      if (type === "metric.updated") {
        return describeMetric(payload);
      }
      if (type === "claude.raw") {
        return describeClaudeRaw(payload);
      }
      if (type === "server.error") {
        return { title: "服务端错误", summary: data.message || "服务端返回错误。", meta: data.code ? [["错误码", data.code]] : [] };
      }
      return { title: readableType(type), summary: extractText(payload) || "收到一条事件。", meta: [["类型", type || "unknown"]] };
    }

    function describeToolOutput(data, payload) {
      const result = payload.tool_use_result || {};
      const contentResult = extractToolResultContent(payload);
      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      const text = data.text || stdout || stderr || contentResult || extractText(payload) || "";
      const stream = data.stream || payload.stream || (stderr ? "stderr" : stdout ? "stdout" : "");
      return {
        title: stream === "stderr" || result.is_error ? "工具错误输出" : "工具返回",
        summary: text || "工具返回了输出。",
        meta: [
          stream ? ["流", stream] : null,
          result.interrupted ? ["状态", "interrupted"] : null
        ].filter(Boolean)
      };
    }

    function isToolResultPayload(payload) {
      if (!payload || typeof payload !== "object") return false;
      if (payload.tool_use_result) return true;
      const content = payload.message && payload.message.content;
      return Array.isArray(content) && content.some((item) => item && item.type === "tool_result");
    }

    function extractToolResultContent(payload) {
      const content = payload && payload.message && payload.message.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((item) => item && item.type === "tool_result")
        .map((item) => item.content || "")
        .filter(Boolean)
        .join("\n");
    }

    function extractToolResultID(payload) {
      if (!payload || typeof payload !== "object") return "";
      const content = payload.message && payload.message.content;
      if (Array.isArray(content)) {
        const result = content.find((item) => item && item.type === "tool_result" && item.tool_use_id);
        if (result) return result.tool_use_id;
      }
      return payload.tool_use_id || payload.parent_tool_use_id || "";
    }

    function describeToolCall(payload) {
      const toolUse = extractToolUse(payload);
      const name = toolUse.name || payload.name || payload.tool_name || payload.tool || "tool";
      const input = toolUse.input || payload.input || payload.arguments || payload.params || {};
      const command = typeof input === "string" ? input : (input.command || input.cmd || input.query || "");
      const target = toolTarget(name, input);
      const title = toolTitle(name, input);
      return {
        title,
        summary: command || target || summarizeObject(input, "准备执行工具调用。"),
        meta: [
          ["工具", name],
          target ? ["目标", target] : null
        ].filter(Boolean)
      };
    }

    function extractToolUse(payload) {
      if (!payload || typeof payload !== "object") return {};
      if (payload.name && payload.input) return payload;
      const content = payload.content || (payload.message && payload.message.content);
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && (item.type === "tool_use" || item.name)) return item;
        }
      }
      return {};
    }

    function toolUseSummary(name, input) {
      if (!input || typeof input !== "object") return "";
      return input.command || input.cmd || input.query || input.pattern || input.file_path || input.path || summarizeObject(input, "准备执行工具调用。");
    }

    function toolTitle(name, input) {
      const lower = String(name || "").toLowerCase();
      if (isSkillRead(name, input)) return "阅读 Skill：" + skillNameFromInput(input);
      if (isSkillTool(name, input)) return "调用 Skill：" + skillNameFromInput(input);
      if (lower.includes("bash")) return "执行命令";
      if (lower === "read" || lower.includes("read")) return "读取文件";
      if (lower === "edit" || lower.includes("edit") || lower.includes("write")) return "修改文件";
      if (lower.includes("grep")) return "搜索文本";
      if (lower.includes("glob")) return "查找文件";
      if (lower.includes("todo")) return "更新任务清单";
      return "调用工具：" + name;
    }

    function toolTarget(name, input) {
      if (!input || typeof input !== "object") return "";
      return input.file_path || input.path || input.pattern || input.query || input.command || input.cmd || "";
    }

    function isSkillRead(name, input) {
      const lowerName = String(name || "").toLowerCase();
      const target = String(toolTarget(name, input)).toLowerCase();
      return lowerName.includes("read") && target.endsWith("skill.md");
    }

    function isSkillTool(name, input) {
      const lowerName = String(name || "").toLowerCase();
      const target = String(toolTarget(name, input)).toLowerCase();
      return lowerName.includes("skill") || target.includes("/skills/") || target.includes(".agents/skills") || target.includes(".codex/skills");
    }

    function skillNameFromInput(input) {
      const target = String(toolTarget("", input) || "");
      const parts = target.split("/").filter(Boolean);
      const idx = parts.findIndex((part) => part === "skills");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
      if (target.endsWith("SKILL.md") && parts.length >= 2) return parts[parts.length - 2];
      return "Skill";
    }

    function describeMetric(payload) {
      const cost = payload.total_cost_usd ?? payload.cost_usd ?? payload.cost;
      const tokens = payload.usage || payload.token_usage || payload.tokens;
      return {
        title: "任务指标更新",
        summary: extractText(payload) || "Claude Code 返回了运行指标。",
        meta: [
          cost !== undefined ? ["费用", String(cost)] : null,
          tokens !== undefined ? ["Token", typeof tokens === "string" ? tokens : JSON.stringify(tokens)] : null
        ].filter(Boolean)
      };
    }

    function describeClaudeRaw(payload) {
      const rawType = payload.type || payload.subtype || "raw";
      const text = extractText(payload);
      if (rawType === "system") {
        return { title: "系统事件", summary: "Claude Code 会话元数据已更新。", meta: payload.session_id ? [["Session", shortID(payload.session_id)]] : [] };
      }
      if (rawType === "result") {
        return { title: "执行结果", summary: payload.is_error ? "Claude Code 返回错误结果。" : "Claude Code 返回最终结果。", meta: [
          payload.session_id ? ["Session", shortID(payload.session_id)] : null,
          payload.total_cost_usd !== undefined ? ["费用", String(payload.total_cost_usd)] : null
        ].filter(Boolean) };
      }
      return {
        title: readableClaudeType(rawType),
        summary: text || summarizeObject(payload, "Claude Code 返回了一条结构化事件。"),
        meta: [["Claude 类型", rawType]]
      };
    }

    function extractText(value) {
      if (!value) return "";
      if (typeof value === "string") return value;
      if (typeof value.text === "string") return value.text;
      if (typeof value.message === "string") return value.message;
      if (typeof value.content === "string") return value.content;
      if (Array.isArray(value.content)) {
        return value.content.map((item) => {
          if (typeof item === "string") return item;
          if (item.type === "tool_result") return "";
          if (item.type === "tool_use") return "";
          return item.text || item.content || "";
        }).filter(Boolean).join("\n");
      }
      if (value.message && typeof value.message === "object") return extractText(value.message);
      if (value.result && typeof value.result === "string") return value.result;
      return "";
    }

    function normalizePayload(value) {
      if (!value) return {};
      if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return { text: value }; }
      }
      return value;
    }

    function extractSessionIDFromEvent(event) {
      const candidates = [normalizePayload(event.raw), normalizePayload(event.data)];
      for (const value of candidates) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.session_id === "string" && value.session_id) return value.session_id;
        if (value.message && typeof value.message === "object" && typeof value.message.session_id === "string") return value.message.session_id;
      }
      return "";
    }

    function shortID(value) {
      if (!value) return "";
      return value.length > 12 ? value.slice(0, 8) + "..." : value;
    }

    function readableType(type) {
      return ({
        "tool.output": "工具输出",
        "tool.call": "工具调用",
        "assistant.message": "Claude 回复",
        "metric.updated": "指标更新",
        "claude.raw": "Claude 事件"
      })[type] || (type || "事件");
    }

    function readableClaudeType(type) {
      return ({
        system: "系统事件",
        assistant: "Claude 回复",
        user: "用户消息",
        result: "执行结果",
        tool_use: "工具调用",
        tool_result: "工具结果"
      })[type] || "Claude 事件";
    }

    function formatCommand(command, args) {
      return [command, ...(args || [])].filter(Boolean).join(" ");
    }

    function summarizeObject(value, fallback) {
      if (!value || (typeof value === "object" && !Object.keys(value).length)) return fallback;
      return JSON.stringify(value, null, 2);
    }

    function formatBody(body) {
      if (typeof body === "string") return body;
      return JSON.stringify(body, null, 2);
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
    }

    function togglePanel(id) {
      document.getElementById(id).classList.toggle("open");
    }

    function closePanels() {
      document.getElementById("sidebar").classList.remove("open");
      document.getElementById("inspector").classList.remove("open");
    }

    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        dispatchTask();
      }
    });

    renderEvents();
    updateShellState();
    connect();
  </script>
</body>
</html>`
