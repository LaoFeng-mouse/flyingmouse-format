const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("feishuFormat", {
  saveConvertedFile(payload) {
    return ipcRenderer.invoke("save-converted-file", payload);
  },
  saveConvertedFiles(payload) {
    return ipcRenderer.invoke("save-converted-files", payload);
  }
});
