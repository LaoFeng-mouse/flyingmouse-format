const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
} = require("./electron-security");
const logger = require("./logger");
const { buildDiagnosticsReport } = require("./diagnostics");
const { resolveRuntimePaths } = require("./runtime-paths");
const {
  mergeLegacySettings,
  readLastSaveDirectory,
  readSettings,
  updateSettings,
  writeLastSaveDirectory
} = require("./settings-store");

let mainWindow = null;
let server = null;
let serverUrl = "";
let serverRuntime = null;
const settingsPath = path.join(app.getPath("userData"), "settings.json");

// Route all logging (including from server.js and renderer-forwarded IPC
// messages) to a single debug.log in the Electron userData directory.
logger.setLogFile(path.join(app.getPath("userData"), "debug.log"));
process.env.FLYINGMOUSE_LOG_FILE = logger.getLogFile();

function log(message, error) {
  if (error) {
    logger.error(message, error);
  } else {
    logger.info(message);
  }
}

function createWindow(url) {
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

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (isTrustedRendererUrl(navigationUrl, serverUrl)) return;
    event.preventDefault();
    log("Blocked renderer navigation");
  });
  mainWindow.loadURL(url);
  mainWindow.webContents.on("did-finish-load", () => log("Window finished loading"));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => log(`Window failed loading ${code}: ${description}`));
  mainWindow.on("closed", () => {
    log("Main window closed");
    mainWindow = null;
  });
}

// ---- 自动更新（仅 NSIS/GitHub 渠道；微软商店版由商店自行更新）----
let updater = null;

function pushUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", status);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged || process.windowsStore) return;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch (error) {
    log("Auto-updater module unavailable", error);
    return;
  }
  updater.logger = logger;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("error", (error) => {
    log("Auto-update error", error);
    pushUpdateStatus({ status: "error", message: String(error?.message || "") });
  });
  updater.on("update-available", (info) => {
    log(`Auto-update available: ${info?.version}`);
    pushUpdateStatus({ status: "available", version: info?.version || "" });
  });
  updater.on("update-not-available", () => {
    log("Auto-update not available");
    pushUpdateStatus({ status: "upToDate" });
  });
  updater.on("update-downloaded", (info) => {
    log(`Update downloaded: ${info?.version}; will install on quit`);
    pushUpdateStatus({ status: "downloaded", version: info?.version || "" });
  });
  // 启动后静默检查一次（不打扰用户；有更新会走上面的状态推送）
  updater.checkForUpdatesAndNotify().catch((error) => {
    log("Auto-update check failed", error);
  });
}

ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("check-for-updates", async () => {
  if (!updater) {
    return { status: "unavailable" };
  }
  try {
    const result = await updater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      return { status: "available", version: result.updateInfo?.version || "" };
    }
    return { status: "upToDate" };
  } catch (error) {
    log("Manual update check failed", error);
    return { status: "error", message: String(error?.message || "") };
  }
});

async function boot() {
  log("Boot started");
  process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(os.tmpdir(), "flyingmouse-format-runtime");
  const runtimePaths = resolveRuntimePaths({ resourcesPath: process.resourcesPath });
  process.env.FLYINGMOUSE_FFMPEG_PATH = runtimePaths.ffmpeg;
  process.env.FLYINGMOUSE_LIBREOFFICE_PATH = runtimePaths.libreoffice;
  process.env.FLYINGMOUSE_PDFTOPPM_PATH = runtimePaths.pdftoppm;
  process.env.FLYINGMOUSE_TESSDATA_PATH = runtimePaths.tessdata;
  if (runtimePaths.avs3Decoder) process.env.FLYINGMOUSE_AVS3_DECODER_PATH = runtimePaths.avs3Decoder;
  else delete process.env.FLYINGMOUSE_AVS3_DECODER_PATH;
  log(`Runtime dir: ${process.env.FLYINGMOUSE_RUNTIME_DIR}`);
  log(`FFmpeg path: ${process.env.FLYINGMOUSE_FFMPEG_PATH}`);
  log(`AV3A decoder path: ${process.env.FLYINGMOUSE_AVS3_DECODER_PATH || "unavailable"}`);
  log(`LibreOffice path: ${process.env.FLYINGMOUSE_LIBREOFFICE_PATH}`);
  log(`Poppler path: ${process.env.FLYINGMOUSE_PDFTOPPM_PATH}`);
  serverRuntime = require("./server");

  const started = await serverRuntime.startServer(0);
  server = started.server;
  serverUrl = started.url;
  console.log(`FlyingMouse Format started at ${started.url}`);
  log(`Server started at ${started.url}`);
  setupAutoUpdater();
  createWindow(started.url);
}

function downloadToFile(url, destination) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let redirectedUrl;
        try {
          redirectedUrl = trustedDownloadUrl(new URL(response.headers.location, url).toString());
        } catch (error) {
          reject(error);
          return;
        }
        downloadToFile(redirectedUrl, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`保存失败：下载服务返回 ${response.statusCode}`));
        response.resume();
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
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
    engines,
    logText,
    userHome: os.homedir(),
    environment: process.env
  });
  await fs.promises.writeFile(result.filePath, report, "utf8");
  await writeLastSaveDirectory(settingsPath, path.dirname(result.filePath))
    .catch((error) => log("Failed to remember diagnostics directory", error));
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("save-converted-file", async (event, payload) => {
  assertTrustedIpc(event);
  const fileName = path.basename(String(payload?.fileName || "converted-file"));
  const absoluteUrl = trustedDownloadUrl(payload?.downloadUrl);
  const lastSaveDirectory = await readLastSaveDirectory(settingsPath, app.getPath("downloads"));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存转换后的文件",
    defaultPath: path.join(lastSaveDirectory, fileName),
    buttonLabel: "保存"
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await downloadToFile(absoluteUrl, result.filePath);
  await writeLastSaveDirectory(settingsPath, path.dirname(result.filePath))
    .catch((error) => log("Failed to remember save directory", error));
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
    downloadUrl: trustedDownloadUrl(item?.downloadUrl)
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

  for (const item of trustedFiles) {
    const destination = uniqueDestination(directory, item.fileName);
    await downloadToFile(item.downloadUrl, destination);
    saved.push(destination);
  }

  await writeLastSaveDirectory(settingsPath, directory)
    .catch((error) => log("Failed to remember save directory", error));

  return { canceled: false, directory, savedCount: saved.length, files: saved };
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

if (process.platform === "win32") {
  app.setAppUserModelId("com.flyingmouse.format");
}

process.on("uncaughtException", (error) => log("Uncaught exception", error));
process.on("unhandledRejection", (error) => log("Unhandled rejection", error));

app.whenReady().then(boot).catch((error) => {
  log("Boot failed", error);
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  log("All windows closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow && server?.listening) {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 5177;
    serverUrl = `http://127.0.0.1:${port}`;
    createWindow(serverUrl);
  }
});

app.on("before-quit", () => {
  log("Before quit");
  if (server?.listening) {
    server.close();
  }
});

app.on("web-contents-created", (_event, contents) => {
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
