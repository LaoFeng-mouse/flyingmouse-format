const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flyingMouseFormat", {
  getSettings() {
    return ipcRenderer.invoke("get-settings");
  },
  updateSettings(patch) {
    return ipcRenderer.invoke("update-settings", patch);
  },
  migrateLegacySettings(legacy) {
    return ipcRenderer.invoke("migrate-legacy-settings", legacy);
  },
  exportDiagnostics() {
    return ipcRenderer.invoke("export-diagnostics");
  },
  saveConvertedFile(payload) {
    return ipcRenderer.invoke("save-converted-file", payload);
  },
  saveConvertedFiles(payload) {
    return ipcRenderer.invoke("save-converted-files", payload);
  },
  log(level, message) {
    return ipcRenderer.invoke("log-event", { level, message });
  },
  getAppVersion() {
    return ipcRenderer.invoke("get-app-version");
  },
  checkForUpdates() {
    return ipcRenderer.invoke("check-for-updates");
  },
  onUpdateStatus(callback) {
    ipcRenderer.on("update-status", (_event, status) => callback(status));
  }
});
