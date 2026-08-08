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
const { readLastSaveDirectory, writeLastSaveDirectory } = require("./settings-store");

let mainWindow = null;
let server = null;
let serverUrl = "";
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

function bundledFfmpegPath() {
  const resourcesPath = process.resourcesPath || "";
  return path.join(resourcesPath, "ffmpeg", "ffmpeg.exe");
}

function bundledAvs3DecoderPath() {
  const resourcesPath = process.resourcesPath || "";
  return path.join(resourcesPath, "avs3", "avs3RM0Decoder.exe");
}

function bundledLibreOfficePath() {
  const resourcesPath = process.resourcesPath || "";
  return path.join(resourcesPath, "libreoffice", "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
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

async function boot() {
  log("Boot started");
  process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(os.tmpdir(), "flyingmouse-format-runtime");
  process.env.FLYINGMOUSE_FFMPEG_PATH = bundledFfmpegPath();
  process.env.FLYINGMOUSE_AVS3_DECODER_PATH = bundledAvs3DecoderPath();
  process.env.FLYINGMOUSE_LIBREOFFICE_PATH = bundledLibreOfficePath();
  log(`Runtime dir: ${process.env.FLYINGMOUSE_RUNTIME_DIR}`);
  log(`FFmpeg path: ${process.env.FLYINGMOUSE_FFMPEG_PATH}`);
  log(`AV3A decoder path: ${process.env.FLYINGMOUSE_AVS3_DECODER_PATH}`);
  log(`LibreOffice path: ${process.env.FLYINGMOUSE_LIBREOFFICE_PATH}`);
  const { startServer } = require("./server");

  const started = await startServer(0);
  server = started.server;
  serverUrl = started.url;
  console.log(`FlyingMouse Format started at ${started.url}`);
  log(`Server started at ${started.url}`);
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
