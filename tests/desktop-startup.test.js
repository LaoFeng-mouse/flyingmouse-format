const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { createOfficeReadiness } = require("../office-readiness");

async function startDesktop({ serverFailure } = {}) {
  const events = [];
  const state = createOfficeReadiness();
  let finishPreparation;
  const handlers = new Map();
  const pending = new Promise((resolve) => { finishPreparation = resolve; });
  const app = {
    getPath: () => "C:/test-user", getVersion: () => "test", isPackaged: true,
    whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
    on: (name, listener) => handlers.set(name, listener),
    quit: () => events.push("quit"), disableHardwareAcceleration() {}, setAppUserModelId() {},
    commandLine: { hasSwitch: () => false, getSwitchValue: () => "", appendSwitch() {} }
  };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      events.push("window");
      assert.equal(options.webPreferences.sandbox, true);
      this.webContents = new EventEmitter();
      this.webContents.session = { setProxy: async () => { events.push("direct"); }, closeAllConnections: async () => {} };
    }
    isDestroyed() { return false; }
    loadURL() { events.push("load"); }
  }
  const logger = { setLogFile() {}, getLogFile: () => "C:/test-user/debug.log", info() {}, error() {} };
  const overrides = {
    electron: { app, BrowserWindow: Window, shell: {}, ipcMain: { handle() {} },
      dialog: { showErrorBox: (_title, detail) => events.push({ errorDialog: detail }) } },
    "./logger": logger,
    "./desktop-shutdown": { ...require("../desktop-shutdown"), captureRuntimeIdentity: async () => ({}) },
    "./office-readiness": state,
    "./store-engine-cache": {
      resolveOfficeEnginesRoot: require("../store-engine-cache").resolveOfficeEnginesRoot,
      resolveWritableEngineBundle: ({ enginesRoot }) => {
        assert.equal(enginesRoot, path.join("C:/test-user", "FMF", "e"));
        return { path: "C:/writable/soffice.com", bundleName: `lo-${"1".repeat(32)}` };
      },
      prepareWritableEngineBundleAsync: async ({ enginesRoot, bundleName }) => {
        assert.equal(enginesRoot, path.join("C:/test-user", "FMF", "e"));
        assert.equal(bundleName, `lo-${"1".repeat(32)}`, "helper must use the same destination selected before server configuration");
        events.push("prepare"); return pending;
      }
    },
    "./runtime-paths": { resolveRuntimePaths: () => ({ ffmpeg: "ffmpeg", libreoffice: "C:/readonly/soffice.com",
      pdftoppm: "pdftoppm", tessdata: "tessdata" }) },
    "./server": { startServer: async () => {
      events.push("server");
      assert.equal(state.getOfficeState().status, "pending");
      if (serverFailure) throw new Error(serverFailure);
      return { server: { listening: true }, url: "http://127.0.0.1:5555" };
    } }
  };
  const appRoot = path.join(__dirname, "..");
  const context = {
    __dirname: appRoot, console: { log() {}, error() {} }, setImmediate,
    process: { argv: [], env: { LOCALAPPDATA: "C:/test-user" }, windowsStore: true,
      resourcesPath: "C:/readonly", platform: "win32", pid: 123, on() {} },
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name]
      : name.startsWith("./") ? require(path.join(appRoot, name)) : require(name)
  };
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, "electron-main.js"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { events, state, finishPreparation, context };
}

test("Store desktop creates its window before Office copy and keeps running after preparation failure", async () => {
  const { events, state, finishPreparation, context } = await startDesktop();
  assert.deepEqual(events, ["server", "window", "direct", "prepare", "load"]);
  assert.equal(context.process.env.FLYINGMOUSE_LIBREOFFICE_PATH, "C:/writable/soffice.com");
  assert.equal(state.getOfficeState().status, "pending");
  finishPreparation({ source: "bundled", path: "C:/readonly/soffice.com", reason: "disk full" });
  await state.startOfficePreparation();
  assert.equal(state.getOfficeState().status, "failed");
  assert.equal(events.includes("quit"), false);
});

test("fatal desktop boot error shows the diagnostic log location before exit", async () => {
  const { events } = await startDesktop({ serverFailure: "address unavailable" });
  assert.equal(events[0], "server");
  assert.match(events[1].errorDialog, /debug\.log/);
  assert.match(events[1].errorDialog, /address unavailable/);
  assert.equal(events[2], "quit");
  assert.equal(events.includes("prepare"), false);
});

test("Store config keeps the future writable destination before its entry exists", () => {
  const appRoot = path.join(__dirname, "..");
  const exported = { exports: {} };
  const pendingPath = path.join(osTempRoot(), "not-copied-yet", "soffice.com");
  assert.equal(fs.existsSync(pendingPath), false);
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, "config.js"), "utf8"), {
    __dirname: appRoot, module: exported, exports: exported.exports, process,
    require: name => name === "./office-readiness" ? { getOfficeState: () => ({ status: "pending", path: pendingPath }) }
      : name.startsWith("./") ? require(path.join(appRoot, name)) : require(name)
  });
  assert.equal(exported.exports.LIBREOFFICE_PATH, pendingPath);
});

function osTempRoot() { return require("node:os").tmpdir(); }
