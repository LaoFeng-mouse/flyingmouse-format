(function startDesktop() {
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const saveDownload = require("./save-download");
const storeEngineCache = require("./store-engine-cache");
const officeReadiness = require("./office-readiness");
const { saveConvertedResult } = require("./save-converted-result");
const { chooseConvertedSavePath } = require("./save-dialog");
const {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
} = require("./electron-security");
const logger = require("./logger");
const { buildDiagnosticsReport } = require("./diagnostics");
const { discoverSkillRoots, installAgentSkill } = require("./agent-skill-installer");
const { resolveRuntimePaths } = require("./runtime-paths");
const { createDesktopRecovery } = require("./desktop-recovery");
const ownedTasks = require("./owned-tasks");
const { createDesktopShutdown, captureRuntimeIdentity, cleanupOwnedRuntime } = require("./desktop-shutdown");
const {
  mergeLegacySettings,
  readLastSaveDirectory,
  readSettings,
  updateSettings,
  writeLastSaveDirectory
} = require("./settings-store");

let mainWindow = null;
let desktopRecovery = null;
let server = null;
let serverUrl = "";
let serverRuntime = null;
let runtimeOwner;
const desktopShutdown = createDesktopShutdown({
  app, log,
  stopTasks: () => ownedTasks.stopAll(),
  closeServer: () => { server?.close(); server?.closeAllConnections?.(); },
  closeWindows: () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); },
  cleanup: () => cleanupOwnedRuntime(runtimeOwner)
});
const cliMarkerIndex = process.argv.indexOf("--cli");
const cliMode = cliMarkerIndex >= 0;
let settingsPath;
let startupPath = "userData";

try {
  // Electron can replace an unusable --user-data-dir with its default before
  // this module runs. Validate the original switch before touching that fallback.
  if (app.commandLine.hasSwitch("user-data-dir")) {
    const requestedProfile = app.commandLine.getSwitchValue("user-data-dir");
    if (!requestedProfile) {
      throw Object.assign(new Error("--user-data-dir requires a directory path."), { code: "EINVAL", path: "--user-data-dir" });
    }
    startupPath = path.resolve(requestedProfile);
    fs.mkdirSync(startupPath, { recursive: true });
    if (path.resolve(app.getPath("userData")) !== startupPath) app.setPath("userData", startupPath);
  }
  startupPath = app.getPath("userData");
  settingsPath = path.join(startupPath, "settings.json");
  startupPath = path.join(startupPath, "debug.log");
  // Server and renderer-forwarded messages share this profile's log.
  logger.setLogFile(startupPath);
  process.env.FLYINGMOUSE_LOG_FILE = logger.getLogFile();
} catch (error) {
  const detail = `无法准备配置或日志目录；应用已停止启动，未切换到备用配置。\nCould not prepare the selected profile or log directory. Startup stopped without switching to another profile.\n\n${error?.path || startupPath}\n${error?.code || "STARTUP_PROFILE_ERROR"}: ${error?.message || error}`;
  console.error(detail);
  try {
    if (!cliMode) dialog.showErrorBox("飞鼠格式启动失败 / FlyingMouse Format could not start", detail);
  } finally {
    app.exit(1);
  }
  return;
}

function log(message, error) {
  if (error) {
    logger.error(message, error);
  } else {
    logger.info(message);
  }
}

function finishCli(code) {
  // CLI owns its own workspace in cli.js, but Store preparation may still be
  // running after a command that did not need Office. Stop that helper too.
  createDesktopShutdown({ app, log, exitCode: code, releaseLock: false,
    stopTasks: () => ownedTasks.stopAll(), closeServer: () => {}, cleanup: () => {}
  }).beforeQuit();
}

function createWindow(url) {
  if (desktopShutdown.isStopping()) return;
  log(`Creating window for ${url}`);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "FlyingMouse Format",
    backgroundColor: "#f6f3ee",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (process.platform === "win32" && app.isPackaged && !process.windowsStore) {
    const launcher = currentCliLauncher().executable;
    mainWindow.setAppDetails({
      appId: "com.flyingmouse.format",
      appIconPath: launcher,
      relaunchCommand: `"${launcher}"`,
      relaunchDisplayName: "FlyingMouse Format"
    });
  }

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (isTrustedRendererUrl(navigationUrl, serverUrl)) return;
    event.preventDefault();
    log("Blocked renderer navigation");
  });
  desktopRecovery = createDesktopRecovery({ window: mainWindow, url, dialog, shell,
    log, logPath: logger.getLogFile() });
  void desktopRecovery.start();
  mainWindow.on("closed", () => {
    log("Main window closed");
    mainWindow = null;
    desktopRecovery = null;
  });
}

ipcMain.handle("renderer-ready", (event) => {
  assertTrustedIpc(event);
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Rejected interface readiness sender.");
  }
  desktopRecovery?.markReady();
});

ipcMain.handle("get-app-version", (event) => {
  assertTrustedIpc(event);
  return app.getVersion();
});

// MSIX/Store installs (C:\Program Files\WindowsApps\...) are read-only to the app.
// LibreOfficePortable cannot initialize from a read-only install dir and fails with
// "installation could not be completed". Copy the engine bundle once to a writable
// per-user location and run from there. Dev / non-Store installs already run from a
// writable resources dir, so they skip this entirely.
// Select the eventual writable path before config/server modules are loaded.
// Copy and validation run in a worker after the window is created; the server
// advertises a pending Office engine and awaits readiness only for Office work.
function configureWritableLibreOfficeForStore(bundledSofficePath) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const enginesRoot = storeEngineCache.resolveOfficeEnginesRoot(localAppData);
  const options = {
    bundledBundle: path.join(process.resourcesPath || "", "libreoffice"),
    bundledSofficePath,
    enginesRoot,
    log
  };
  const destination = storeEngineCache.resolveWritableEngineBundle(options);
  officeReadiness.configureOfficePreparation({
    path: destination.path,
    prepare: async () => {
      const result = await storeEngineCache.prepareWritableEngineBundleAsync({ ...options, bundleName: destination.bundleName });
      if (result.source === "bundled") log(`Writable Office engine unavailable: ${result.reason}`);
      else log(`Writable Office engine ready (${result.source}): ${result.path}`);
      return result;
    }
  });
  return destination.path;
}

function configureRuntime() {
  // 每个进程独立的临时工作目录。旧版固定用同一个 %TEMP%\flyingmouse-format-runtime，
  // 双开实例时各自 server 会在同目录互相清掉对方的产物（cleanupOldFiles 按 mtime 删），
  // 并共享 downloads 登记表之外的文件——本机日志实证过两实例并行（2026-08-25）。
  // 以 pid 为后缀后各实例完全隔离，互不干扰。
  // CLI owns a fresh child workspace and disposes it before app.exit; preserve
  // an explicit caller-owned parent until that lifecycle has initialized it.
  if (!cliMode) process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(os.tmpdir(), `flyingmouse-format-runtime-${process.pid}`);
  const runtimePaths = resolveRuntimePaths({ resourcesPath: process.resourcesPath });
  process.env.FLYINGMOUSE_FFMPEG_PATH = runtimePaths.ffmpeg;
  if (process.windowsStore) {
    // Store/MSIX install dir is read-only; LibreOfficePortable can't initialize there.
    process.env.FLYINGMOUSE_LIBREOFFICE_PATH = configureWritableLibreOfficeForStore(runtimePaths.libreoffice);
  } else {
    process.env.FLYINGMOUSE_LIBREOFFICE_PATH = runtimePaths.libreoffice;
  }
  process.env.FLYINGMOUSE_PDFTOPPM_PATH = runtimePaths.pdftoppm;
  process.env.FLYINGMOUSE_TESSDATA_PATH = runtimePaths.tessdata;
  const pandoc = path.join(process.resourcesPath || __dirname, "pandoc", process.platform === "win32" ? "pandoc.exe" : "pandoc");
  if (app.isPackaged && fs.existsSync(pandoc)) process.env.FLYINGMOUSE_PANDOC_PATH = pandoc;
  if (runtimePaths.docstructureEngine) process.env.FLYINGMOUSE_DOCSTRUCTURE_ENGINE_PATH = runtimePaths.docstructureEngine;
  else delete process.env.FLYINGMOUSE_DOCSTRUCTURE_ENGINE_PATH;
  if (runtimePaths.docstructureModels) process.env.FLYINGMOUSE_DOCSTRUCTURE_MODEL_DIR = runtimePaths.docstructureModels;
  else delete process.env.FLYINGMOUSE_DOCSTRUCTURE_MODEL_DIR;
  if (runtimePaths.avs3Decoder) process.env.FLYINGMOUSE_AVS3_DECODER_PATH = runtimePaths.avs3Decoder;
  else delete process.env.FLYINGMOUSE_AVS3_DECODER_PATH;
  log(`Runtime dir: ${process.env.FLYINGMOUSE_RUNTIME_DIR}`);
  log(`FFmpeg path: ${process.env.FLYINGMOUSE_FFMPEG_PATH}`);
  log(`AV3A decoder path: ${process.env.FLYINGMOUSE_AVS3_DECODER_PATH || "unavailable"}`);
  log(`LibreOffice path: ${process.env.FLYINGMOUSE_LIBREOFFICE_PATH}`);
  log(`Poppler path: ${process.env.FLYINGMOUSE_PDFTOPPM_PATH}`);
}

async function boot() {
  if (desktopShutdown.isStopping()) return;
  log("Boot started");
  // 单实例锁：禁止双开（旧版允许并行，两份 server 共享同一 runtime 目录，会互删产物）。
  // 第二个实例直接退出，聚焦已有窗口。
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    log("Another FlyingMouse Format instance is running; quitting this one");
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (desktopShutdown.isStopping()) return;
    log("Second instance launched; focusing existing window");
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  configureRuntime();
  runtimeOwner = await captureRuntimeIdentity({ runtimeDir: process.env.FLYINGMOUSE_RUNTIME_DIR });
  if (desktopShutdown.isStopping()) { await cleanupOwnedRuntime(runtimeOwner); return; }
  serverRuntime = require("./server");

  const started = await serverRuntime.startServer(0);
  server = started.server;
  if (desktopShutdown.isStopping()) { server.close(); server.closeAllConnections?.(); return; }
  serverUrl = started.url;
  console.log(`FlyingMouse Format started at ${started.url}`);
  log(`Server started at ${started.url}`);
  createWindow(started.url);
  // Worker-based preparation allows both rendering and non-Office conversion
  // while a first Store launch copies and validates the engine.
  void officeReadiness.startOfficePreparation();
}

function bundledSkillSource() {
  return path.join(app.getAppPath(), "agent-skill", "flyingmouse-format");
}

function currentCliLauncher() {
  const bootstrap = path.join(path.dirname(process.execPath), "FlyingMouse Format.exe");
  return {
    executable: app.isPackaged && process.platform === "win32" && fs.existsSync(bootstrap)
      ? bootstrap : process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()]
  };
}

ipcMain.handle("inspect-agent-skill-targets", async (event) => {
  assertTrustedIpc(event);
  const targets = await discoverSkillRoots();
  return { targets };
});

ipcMain.handle("install-agent-skill", async (event, payload) => {
  assertTrustedIpc(event);
  const discovered = await discoverSkillRoots();
  const requested = new Set(Array.isArray(payload?.targetIds) ? payload.targetIds.map(String) : []);
  const roots = discovered.filter((item) => requested.has(item.id));
  if (!roots.length) return { canceled: false, installed: [], failed: [] };

  const targetNames = roots.map((item) => `${item.name}: ${item.path}`).join("\n");
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["接入 / Connect", "取消 / Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "接入 Agent / Connect to Agent",
    message: "将安装或更新 FlyingMouse Format skill",
    detail: `应用会把轻量 skill 写入以下已存在的目录，并记录当前程序的 CLI 路径：\n\n${targetNames}`,
    noLink: true
  });
  if (confirmation.response !== 0) return { canceled: true };
  return installAgentSkill({
    sourceDir: bundledSkillSource(),
    roots,
    launcher: currentCliLauncher()
  });
});

// P1（2026-09-10 复核，最高危）：旧实现失败时 `rm(destination)` 删的是用户选择
// 的最终路径——404（写流未创建）也走这条，导致「保存失败误删已有文件」。
// 下载落盘逻辑抽到 save-download.js：只写随机 .partial，完整校验后 rename 发布，
// 失败只清本次临时文件，destination 永远不被删除。重定向信任校验由这里注入。
function downloadToFile(url, destination, options = {}) {
  return saveDownload.downloadToFile(url, destination, {
    ...options,
    log,
    resolveRedirect: trustedDownloadUrl
  });
}

function assertTrustedIpc(event) {
  if (!isTrustedRendererUrl(event.senderFrame?.url, serverUrl)) {
    throw new Error("拒绝来自非本地页面的保存请求。");
  }
}

function trustedDownloadUrl(value) {
  const resolved = resolveTrustedDownloadUrl(value, serverUrl);
  if (!resolved) throw new Error("下载地址无效或已被拒绝。");
  return resolved;
}

function uniqueDestination(directory, fileName) {
  const parsed = path.parse(path.basename(fileName || "converted-file"));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let counter = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

ipcMain.handle("get-settings", async (event) => {
  assertTrustedIpc(event);
  return readSettings(settingsPath);
});

ipcMain.handle("update-settings", async (event, patch) => {
  assertTrustedIpc(event);
  return updateSettings(settingsPath, patch);
});

ipcMain.handle("migrate-legacy-settings", async (event, legacy) => {
  assertTrustedIpc(event);
  return mergeLegacySettings(settingsPath, legacy);
});

function packageType() {
  if (!app.isPackaged) return "development";
  if (process.windowsStore) return "microsoft-store-appx";
  if (process.platform === "darwin") return "github-dmg";
  return "github-nsis";
}

ipcMain.handle("export-diagnostics", async (event) => {
  assertTrustedIpc(event);
  const lastSaveDirectory = await readLastSaveDirectory(settingsPath, app.getPath("downloads"));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出诊断报告 / Export diagnostics",
    defaultPath: path.join(lastSaveDirectory, "FlyingMouse-Format-diagnostics.txt"),
    buttonLabel: "保存 / Save"
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const logText = await fs.promises.readFile(logger.getLogFile(), "utf8").catch(() => "");
  const engines = serverRuntime?.getToolDiagnostics
    ? await serverRuntime.getToolDiagnostics()
    : {};
  const report = buildDiagnosticsReport({
    appVersion: app.getVersion(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    packageType: packageType(),
    noStdioInit: app.commandLine.hasSwitch("no-stdio-init"),
    engines,
    logText,
    userHome: os.homedir(),
    environment: process.env
  });
  const stagedReport = saveDownload.partialPathFor(result.filePath);
  try {
    await fs.promises.writeFile(stagedReport, report, { encoding: "utf8", flag: "wx" });
    await saveDownload.publishDownloadedFile(stagedReport, result.filePath, { log });
  } finally {
    // A failed report write must not truncate an existing user-selected file.
    await fs.promises.rm(stagedReport, { force: true })
      .catch((error) => log("Failed to remove staged diagnostics report", error));
  }
  await writeLastSaveDirectory(settingsPath, path.dirname(result.filePath))
    .catch((error) => log("Failed to remember diagnostics directory", error));
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("save-converted-file", async (event, payload) => {
  assertTrustedIpc(event);
  const fileName = path.basename(String(payload?.fileName || "converted-file"));
  const absoluteUrl = trustedDownloadUrl(payload?.downloadUrl);
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const lastSaveDirectory = await readLastSaveDirectory(settingsPath, app.getPath("downloads"));
  const result = await chooseConvertedSavePath({
    dialog, window: mainWindow, directory: lastSaveDirectory, fileName
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await saveConvertedResult({ downloadUrl: absoluteUrl, fileName, assets }, result.filePath,
    { download: downloadToFile, resolveUrl: trustedDownloadUrl, log, overwrite: result.overwrite });
  await writeLastSaveDirectory(settingsPath, path.dirname(result.filePath))
    .catch((error) => log("Failed to remember save directory", error));
  log(`Saved converted file: ${result.filePath}`);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("save-converted-files", async (event, payload) => {
  assertTrustedIpc(event);
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!files.length) {
    return { canceled: true };
  }

  const trustedFiles = files.map((item) => ({
    fileName: path.basename(String(item?.fileName || "converted-file")),
    downloadUrl: trustedDownloadUrl(item?.downloadUrl),
    assets: Array.isArray(item?.assets) ? item.assets : []
  }));

  const lastSaveDirectory = await readLastSaveDirectory(settingsPath, app.getPath("downloads"));

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择保存转换文件的文件夹",
    defaultPath: lastSaveDirectory,
    buttonLabel: "保存到这里",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true };
  }

  const directory = result.filePaths[0];
  const saved = [];
  const failed = [];

  for (const item of trustedFiles) {
    let destination;
    try {
      destination = uniqueDestination(directory, item.fileName);
      await saveConvertedResult(item, destination, { download: downloadToFile, resolveUrl: trustedDownloadUrl, log, overwrite: false });
      saved.push(destination);
    } catch (error) {
      // 逐项容错：一个文件失败不再打断队列（旧实现整个 IPC reject，后续文件全部不落盘）。
      // 失败已由 downloadToFile 记录到 debug.log，这里一并汇总返回给渲染器展示。
      failed.push({ name: item.fileName, reason: error instanceof Error ? error.message : String(error) });
      log(`Save batch item failed: ${item.fileName}`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (saved.length) {
    await writeLastSaveDirectory(settingsPath, directory)
      .catch((error) => log("Failed to remember save directory", error));
  }

  return { canceled: false, directory, savedCount: saved.length, failed, files: saved };
});

// Renderer forwards uncaught errors / console diagnostics here so they land
// in the same debug.log as server and main-process events.
ipcMain.handle("log-event", (event, payload) => {
  assertTrustedIpc(event);
  const level = String(payload?.level || "info").toLowerCase();
  const message = String(payload?.message || "");
  if (!message) return;
  if (level === "error") {
    logger.error(`[renderer] ${message}`);
  } else if (level === "warn") {
    logger.warn(`[renderer] ${message}`);
  } else {
    logger.info(`[renderer] ${message}`);
  }
});

// 本地工具类应用，纯 HTML/CSS 界面，禁用硬件加速可省 GPU 进程约 40-80MB 内存
// （必须在 app ready 之前调用）
app.disableHardwareAcceleration();
// 限制主进程 V8 老生代堆上限，避免内存随使用缓慢增长；转换大文件走原生
// 模块（sharp/ffmpeg/LibreOffice 子进程），不受此限制影响。
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=1024");

if (process.platform === "win32" && !process.windowsStore) {
  app.setAppUserModelId("com.flyingmouse.format");
}

process.on("uncaughtException", (error) => log("Uncaught exception", error));
process.on("unhandledRejection", (error) => log("Unhandled rejection", error));

if (cliMode) {
  app.whenReady().then(async () => {
    configureRuntime();
    void officeReadiness.startOfficePreparation();
    const { runCli } = require("./cli");
    const code = await runCli(process.argv.slice(cliMarkerIndex + 1));
    finishCli(code);
  }).catch((error) => {
    log("CLI boot failed", error);
    console.error(error);
    finishCli(1);
  });
} else {
  app.whenReady().then(boot).catch((error) => {
    log("Boot failed", error);
    console.error(error);
    dialog.showErrorBox("飞鼠格式启动失败 / FlyingMouse Format could not start",
      `应用未能启动，请保留以下日志并检查安装是否完整。\nThe app could not start. Keep this log and check that installation completed.\n\n${logger.getLogFile()}\n\n${error?.message || error}`);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (cliMode) return;
  log("All windows closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!cliMode && !desktopShutdown.isStopping() && !mainWindow && server?.listening) {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 5177;
    serverUrl = `http://127.0.0.1:${port}`;
    createWindow(serverUrl);
  }
});

app.on("before-quit", (event) => {
  if (cliMode) return;
  log("Before quit");
  desktopShutdown.beforeQuit(event);
});

app.on("web-contents-created", (_event, contents) => {
  if (cliMode) return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      setImmediate(() => {
        shell.openExternal(url).catch((error) => log("External URL failed", error));
      });
    } else {
      log("Blocked external URL");
    }
    return { action: "deny" };
  });
});
})();
