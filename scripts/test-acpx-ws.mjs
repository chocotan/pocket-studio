// Global WebSocket is directly available in Node.js 22+

const wsUrl = "ws://127.0.0.1:18080/ws/acpx?task_id=mytest&token=ps_admin_local";
console.log("Connecting to:", wsUrl);

const ws = new globalThis.WebSocket(wsUrl);

ws.onopen = () => {
  console.log("WebSocket connected!");

  const sessionCreate = {
    id: "msg-test-create",
    type: "session.create",
    version: 1,
    timestamp: Math.floor(Date.now() / 1000),
    from: "web",
    to: { device_id: "dev_local" },
    payload: {
      task_id: "mytest",
      workspace_path: "/home/choco/Downloads/pocket-studio",
      agent: "opencode",
      agent_runtime: "acpx",
      session_name: "mytest"
    }
  };

  console.log("Sending session.create...");
  ws.send(JSON.stringify(sessionCreate));

  setTimeout(() => {
    const taskDispatch = {
      id: "msg-test-dispatch",
      type: "task.dispatch",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: "dev_local" },
      payload: {
        task_id: "mytest",
        workspace_path: "/home/choco/Downloads/pocket-studio",
        agent: "opencode",
        agent_runtime: "acpx",
        prompt: "hello",
        resume_session_id: "mytest",
        session_name: "mytest"
      }
    };

    console.log("Sending task.dispatch...");
    ws.send(JSON.stringify(taskDispatch));
  }, 1000);
};

ws.onmessage = (event) => {
  console.log("Received WebSocket message:", event.data);
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
};

ws.onclose = (event) => {
  console.log(`WebSocket closed: code=${event.code}, reason=${event.reason}`);
  process.exit(0);
};

// Auto exit after 15 seconds
setTimeout(() => {
  console.log("Timeout reached, closing...");
  ws.close();
}, 15000);
