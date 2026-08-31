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
const { discoverSkillRoots, installAgentSkill } = require("./agent-skill-installer");
const { resolveRuntimePaths } = require("./runtime-paths");
const { zipDirectory } = require("./zip-util");
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
const cliMarkerIndex = process.argv.indexOf("--cli");
const cliMode = cliMarkerIndex >= 0;

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
  // 满血版禁用自动更新（2026-08-20）：build.publish 曾指向公开合规版仓库，
  // 若启用会检查到合规版 v0.6.2 并 autoDownload + autoInstallOnAppQuit，
  // 退出时自动把满血版（含解锁模块）覆盖成合规版。
  // updater 保持 null → check-for-updates IPC 返回 unavailable。
  return;
  if (!app.isPackaged || process.windowsStore) return;
  // mac（github-dmg）：Release 没有 latest-mac.yml 资产，检查更新必 404；不启用
  if (process.platform === "darwin") return;
  // win7 Legacy 构建（Electron 22）：latest.yml 指向标准版（Electron 43）安装包，
  // Win7 装不上（PE 头要求 Win10+），自动更新会坑掉 win7 用户；不启用
  if (Number(process.versions.electron.split(".")[0]) < 30) return;
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

ipcMain.handle("get-app-version", (event) => {
  assertTrustedIpc(event);
  return app.getVersion();
});

ipcMain.handle("check-for-updates", async (event) => {
  assertTrustedIpc(event);
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

// MSIX/Store installs (C:\Program Files\WindowsApps\...) are read-only to the app.
// LibreOfficePortable cannot initialize from a read-only install dir and fails with
// "installation could not be completed". Copy the engine bundle once to a writable
// per-user location and run from there. Dev / non-Store installs already run from a
// writable resources dir, so they skip this entirely.
function ensureWritableLibreOfficeForStore(bundledSofficePath) {
  try {
    const bundledBundle = path.join(process.resourcesPath || "", "libreoffice");
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const destBundle = path.join(localAppData, "FlyingMouseFormat", "engines", "libreoffice");
    const destSoffice = path.join(destBundle, "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
    if (fs.existsSync(destSoffice)) return destSoffice;
    fs.mkdirSync(path.dirname(destBundle), { recursive: true });
    log(`Extracting LibreOffice engine to writable location: ${destBundle}`);
    fs.cpSync(bundledBundle, destBundle, { recursive: true });
    if (fs.existsSync(destSoffice)) return destSoffice;
  } catch (error) {
    log("LibreOffice writable-engine extraction failed; using bundled path", error);
  }
  return bundledSofficePath;
}

function configureRuntime() {
  // 每个进程独立的临时工作目录。旧版固定用同一个 %TEMP%\flyingmouse-format-runtime，
  // 双开实例时各自 server 会在同目录互相清掉对方的产物（cleanupOldFiles 按 mtime 删），
  // 并共享 downloads 登记表之外的文件——本机日志实证过两实例并行（2026-08-25）。
  // 以 pid 为后缀后各实例完全隔离，互不干扰。
  process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(os.tmpdir(), `flyingmouse-format-runtime-${process.pid}`);
  const runtimePaths = resolveRuntimePaths({ resourcesPath: process.resourcesPath });
  process.env.FLYINGMOUSE_FFMPEG_PATH = runtimePaths.ffmpeg;
  if (process.windowsStore) {
    // Store/MSIX install dir is read-only; LibreOfficePortable can't initialize there.
    process.env.FLYINGMOUSE_LIBREOFFICE_PATH = ensureWritableLibreOfficeForStore(runtimePaths.libreoffice);
  } else {
    process.env.FLYINGMOUSE_LIBREOFFICE_PATH = runtimePaths.libreoffice;
  }
  process.env.FLYINGMOUSE_PDFTOPPM_PATH = runtimePaths.pdftoppm;
  process.env.FLYINGMOUSE_TESSDATA_PATH = runtimePaths.tessdata;
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
    log("Second instance launched; focusing existing window");
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  configureRuntime();
  serverRuntime = require("./server");

  const started = await serverRuntime.startServer(0);
  server = started.server;
  serverUrl = started.url;
  console.log(`FlyingMouse Format started at ${started.url}`);
  log(`Server started at ${started.url}`);
  setupAutoUpdater();
  createWindow(started.url);
}

function bundledSkillSource() {
  return path.join(app.getAppPath(), "agent-skill", "flyingmouse-format");
}

function currentCliLauncher() {
  return {
    executable: process.execPath,
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

// 下载空闲超时：60 秒内 socket 无任何数据视为断链（大文件持续传输会不断重置该计时）。
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;

// 保存链路必须可诊断：任何失败都写 debug.log，并删掉残缺文件，避免用户拿到
// 一个"看起来存在但打不开"的半截产物（2026-08-31 实测：服务端中途断链时旧实现
// promise 永挂、界面无任何反馈，磁盘留 64KB 残片）。
function downloadToFile(url, destination) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      const wrapped = error instanceof Error ? error : new Error(String(error));
      log(`Save failed: ${destination}`, wrapped);
      fs.promises.rm(destination, { force: true })
        .catch((cleanupError) => log(`Failed to remove partial file: ${destination}`, cleanupError))
        .finally(() => reject(wrapped));
    };

    const request = client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let redirectedUrl;
        try {
          redirectedUrl = trustedDownloadUrl(new URL(response.headers.location, url).toString());
        } catch (error) {
          fail(error);
          return;
        }
        settled = true;
        downloadToFile(redirectedUrl, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        // 产物登记表过期（server.js cleanupOldFiles，见 config.js PRODUCT_EXPIRY_MS），
        // 404 是最常见的失败，直接给可行动的提示，不要甩一个裸状态码给用户。
        fail(new Error(response.statusCode === 404
          ? "保存失败：转换产物已过期，请重新转换后再保存。"
          : `保存失败：下载服务返回 ${response.statusCode}`));
        return;
      }

      const expectedBytes = Number(response.headers["content-length"]);
      let receivedBytes = 0;
      response.on("data", (chunk) => { receivedBytes += chunk.length; });
      response.on("error", (error) => fail(error));
      response.on("aborted", () => fail(new Error("保存失败：下载连接被中断，文件未完整写入。")));

      const file = fs.createWriteStream(destination);
      file.on("error", (error) => fail(error));
      file.on("finish", () => {
        file.close((closeError) => {
          if (closeError) {
            fail(closeError);
            return;
          }
          if (Number.isFinite(expectedBytes) && expectedBytes > 0 && receivedBytes !== expectedBytes) {
            fail(new Error(`保存失败：文件不完整（已写入 ${receivedBytes} 字节，期望 ${expectedBytes} 字节）。`));
            return;
          }
          if (settled) return;
          settled = true;
          log(`Saved converted file: ${destination} (${receivedBytes} bytes)`);
          resolve();
        });
      });
      response.pipe(file);
    });

    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`保存失败：下载超时（${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒无数据），文件未完整写入。`));
    });
    request.on("error", (error) => fail(error));
  });
}

// md 转换产物带图片外置目录时，把 assets 清单里的图片下载到
// `<md所在目录>/<下载名basename>.assets/`，与 md 内相对引用（./xxx.assets/...）对应。
async function downloadAssetsToMdSidecar(assets, mdDestination) {
  if (!Array.isArray(assets) || !assets.length) return;
  const mdDir = path.dirname(mdDestination);
  const mdBasename = path.basename(mdDestination, path.extname(mdDestination)) || "document";
  const assetsDir = path.join(mdDir, `${mdBasename}.assets`);
  await fs.promises.mkdir(assetsDir, { recursive: true });
  for (const asset of assets) {
    const name = path.basename(String(asset?.name || ""));
    if (!name) continue;
    let absoluteUrl;
    try {
      absoluteUrl = trustedDownloadUrl(asset?.url);
    } catch (error) {
      log("Rejected md asset URL", error);
      continue;
    }
    try {
      await downloadToFile(absoluteUrl, path.join(assetsDir, name));
    } catch (error) {
      log(`Failed to download md asset: ${name}`, error);
    }
  }
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
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
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
  // md 转换产物带图片外置目录时，把图片下载到 md 同目录的 <下载名>.assets/，
  // 保证 md 里的相对图片引用（./xxx.assets/...）可用。
  await downloadAssetsToMdSidecar(assets, result.filePath);
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
      await downloadToFile(item.downloadUrl, destination);
      await downloadAssetsToMdSidecar(item.assets, destination);
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

ipcMain.handle("compress-folder", async (event, payload) => {
  assertTrustedIpc(event);
  const level = Math.min(9, Math.max(0, Number.isFinite(Number(payload?.compressionLevel)) ? Number(payload.compressionLevel) : 6));

  const openResult = await dialog.showOpenDialog(mainWindow, {
    title: "选择要压缩的文件夹",
    buttonLabel: "选择这个文件夹",
    properties: ["openDirectory"]
  });
  const folderPath = openResult.filePaths?.[0];
  if (openResult.canceled || !folderPath) {
    return { canceled: true };
  }

  const lastSaveDirectory = await readLastSaveDirectory(settingsPath, app.getPath("downloads"));
  const folderName = path.basename(folderPath) || "folder";
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: "保存压缩包",
    defaultPath: path.join(lastSaveDirectory, `${folderName}.zip`),
    buttonLabel: "保存",
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  const fileCount = await zipDirectory(folderPath, saveResult.filePath, level);
  await writeLastSaveDirectory(settingsPath, path.dirname(saveResult.filePath))
    .catch((error) => log("Failed to remember save directory", error));

  return { canceled: false, filePath: saveResult.filePath, fileCount };
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

if (cliMode) {
  app.whenReady().then(async () => {
    configureRuntime();
    const { runCli } = require("./cli");
    const code = await runCli(process.argv.slice(cliMarkerIndex + 1));
    app.exit(code);
  }).catch((error) => {
    log("CLI boot failed", error);
    console.error(error);
    app.exit(1);
  });
} else {
  app.whenReady().then(boot).catch((error) => {
    log("Boot failed", error);
    console.error(error);
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
  if (!cliMode && !mainWindow && server?.listening) {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 5177;
    serverUrl = `http://127.0.0.1:${port}`;
    createWindow(serverUrl);
  }
});

app.on("before-quit", () => {
  if (cliMode) return;
  log("Before quit");
  if (server?.listening) {
    server.close();
  }
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
