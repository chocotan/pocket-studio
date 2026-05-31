const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  syncDaemonConfig(config) {
    return ipcRenderer.invoke("daemon:sync-config", config);
  },
  switchToLocalMode() {
    return ipcRenderer.invoke("app:local-mode");
  },
});
