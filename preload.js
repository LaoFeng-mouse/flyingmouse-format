const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flyingMouseFormat", {
  saveConvertedFile(payload) {
    return ipcRenderer.invoke("save-converted-file", payload);
  },
  saveConvertedFiles(payload) {
    return ipcRenderer.invoke("save-converted-files", payload);
  },
  log(level, message) {
    return ipcRenderer.invoke("log-event", { level, message });
  }
});
