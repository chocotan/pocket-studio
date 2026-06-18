console.log("=== INIT SCRIPT EXECUTING ===");
if (!window.__ws_hooked) {
  window.__ws_hooked = true;
  window.__ws_log = [];
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const socket = new OriginalWebSocket(url, protocols);
    const logEntry = { url: url, sent: [], received: [], errors: [] };
    window.__ws_log.push(logEntry);
    const originalSend = socket.send;
    socket.send = function(data) {
      logEntry.sent.push(data);
      return originalSend.apply(this, arguments);
    };
    socket.addEventListener('message', (event) => {
      logEntry.received.push(event.data);
    });
    socket.addEventListener('error', (event) => {
      logEntry.errors.push('error event');
    });
    socket.addEventListener('close', (event) => {
      logEntry.errors.push('closed code: ' + event.code + ', reason: ' + event.reason);
    });
    return socket;
  };
  // Copy static properties so application readyState checks work correctly
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
}
