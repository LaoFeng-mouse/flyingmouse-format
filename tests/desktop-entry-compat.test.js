const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_SOURCE = fs.readFileSync(path.join(ROOT, "electron-main.js"), "utf8").includes("const localEdition");

async function desktop(t, options = {}) {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-startup-078-"));
  const profile = path.join(scratch, "用户 配置");
  const appData = path.join(scratch, "Roaming");
  const localProfile = path.join(appData, "FlyingMouse Format Local Music");
  const install = path.join(scratch, "应用 空格 & 中文");
  const launcher = path.join(install, "FlyingMouse Format.exe");
  const runtime = path.join(install, "FlyingMouse Format Runtime.exe");
  const skillRoot = path.join(scratch, ".codex", "skills");
  const explicitProfilePath = options.explicitValue ?? (options.explicitPathIsFile ? path.join(scratch, "显式配置 普通文件") : options.explicitProfileDifferent ? path.join(scratch, "显式配置 新目录") : profile);
  await fsp.mkdir(profile, { recursive: true });
  await fsp.mkdir(install);
  await fsp.mkdir(skillRoot, { recursive: true });
  await fsp.writeFile(path.join(profile, "settings.json"), '{"userValue":"保留原值"}');
  if (options.explicitPathIsFile) await fsp.writeFile(explicitProfilePath, "PRESERVE-EXPLICIT-PROFILE-078");
  await fsp.writeFile(runtime, "fixture: not executable");
  if (options.launcherExists !== false) await fsp.writeFile(launcher, "fixture: not executable");
  const events = [];
  const handlers = new Map();
  const windows = [];
  const profileChanges = [];
  let currentProfile = profile;
  let entryError;
  let bootPromise;
  const blocked = options.block === "local-profile" ? localProfile : options.block === "profile" ? profile : null;
  const fakeFs = {
    ...fs,
    mkdirSync(target, ...args) {
      if (blocked && path.resolve(target) === path.resolve(blocked)) {
        throw Object.assign(new Error("Synthetic directory access failure"), { code: options.errorCode || "EACCES", path: target });
      }
      return fs.mkdirSync(target, ...args);
    }
  };
  const processView = {
    argv: [runtime, ...(options.cli ? ["--cli", "capabilities"] : [])],
    execPath: runtime, resourcesPath: path.join(install, "resources"),
    env: { USERPROFILE: scratch, LOCALAPPDATA: path.join(scratch, "Local") },
    windowsStore: Boolean(options.store), platform: "win32", arch: "x64", pid: process.pid,
    versions: { electron: "43.1.0" },
    stdout: { write(value) { events.push({ stdout: String(value) }); } },
    stderr: { write(value) { events.push({ stderr: String(value) }); } },
    on() {}
  };
  const app = {
    isPackaged: options.packaged !== false,
    commandLine: {
      hasSwitch: name => name === "user-data-dir" && options.explicitProfile !== false,
      getSwitchValue: name => name === "user-data-dir" ? explicitProfilePath : "",
      appendSwitch() {}
    },
    getPath(name) { return name === "userData" ? currentProfile : name === "appData" ? appData : scratch; },
    setPath(name, value) { assert.equal(name, "userData"); profileChanges.push(value); currentProfile = value; },
    getVersion: () => "0.7.8", getAppPath: () => ROOT, on() {},
    requestSingleInstanceLock: () => true,
    whenReady() { events.push("whenReady"); return options.boot ? { then(fn) {
      bootPromise = Promise.resolve().then(fn); return bootPromise;
    } } : new Promise(() => {}); },
    exit(code) { events.push({ exit: code }); }, quit() { events.push("quit"); },
    disableHardwareAcceleration() {}, setAppUserModelId() {}
  };
  class Window extends EventEmitter {
    constructor(windowOptions) {
      super(); this.options = windowOptions; this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "http://127.0.0.1:5333/" };
      this.webContents.session = { setProxy: async () => {}, closeAllConnections: async () => {} };
      windows.push(this);
    }
    isDestroyed() { return false; }
    async loadURL() { return undefined; }
    setAppDetails(details) { this.details = details; }
  }
  const electron = {
    app, BrowserWindow: Window, shell: {}, session: {},
    ipcMain: { handle(name, fn) { handlers.set(name, fn); } },
    dialog: {
      showErrorBox(title, detail) { events.push({ errorDialog: { title, detail } }); },
      async showMessageBox() { return { response: 0 }; }
    }
  };
  const consoleView = {
    log() {}, warn() {}, error(...args) { events.push({ consoleError: args.map(String).join(" ") }); }
  };
  const cache = new Map();
  function load(relative) {
    const absolute = path.join(ROOT, relative);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const localRequire = createRequire(absolute);
    const context = {
      module, exports: module.exports, __dirname: path.dirname(absolute), __filename: absolute,
      process: processView, console: consoleView, Buffer, URL, setTimeout, clearTimeout, setImmediate,
      require(name) {
        if (name === "electron") return electron;
        if (name === "fs" || name === "node:fs") return fakeFs;
        if (name === "os" || name === "node:os") return { ...os, homedir: () => scratch, tmpdir: () => scratch };
        if (name === "./package.json") return { ...localRequire(name), flyingMouseLocalAudio: LOCAL_SOURCE };
        if (name === "./logger") return load("logger.js");
        if (name === "./desktop-shutdown") return load("desktop-shutdown.js");
        if (name === "./agent-skill-installer") return load("agent-skill-installer.js");
        // The HTTP listener is the system boundary; no real server or GUI is started.
        if (name === "./server") return { startServer: async () => {
          events.push("server"); return { server: { listening: true }, url: "http://127.0.0.1:5333" };
        } };
        return localRequire(name);
      }
    };
    vm.runInNewContext(fs.readFileSync(absolute, "utf8"), context, { filename: absolute });
    return module.exports;
  }
  t.after(async () => {
    for (const window of windows) window.emit("closed");
    await fsp.rm(scratch, { recursive: true, force: true });
  });
  try { load("electron-main.js"); } catch (error) { entryError = error; }
  await bootPromise?.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  return { scratch, profile, explicitProfilePath, localProfile, launcher, runtime, skillRoot, events, handlers, windows, profileChanges, entryError };
}

test("early profile/log directory failure gives its path, exits, and preserves the selected profile", async t => {
  const result = await desktop(t, { block: "profile", errorCode: "EACCES" });
  assert.equal(result.entryError, undefined, "main entry must own this early filesystem error");
  const reported = result.events.find(event => event.errorDialog)?.errorDialog;
  assert.ok(reported, "native failure detail must be available before renderer startup");
  assert.ok(reported.detail.includes(result.profile));
  assert.match(reported.detail, /EACCES/);
  assert.ok(result.events.some(event => event.exit === 1));
  assert.equal(result.events.includes("whenReady"), false);
  assert.equal(result.windows.length, 0);
  assert.deepEqual(result.profileChanges, []);
  assert.equal(await fsp.readFile(path.join(result.profile, "settings.json"), "utf8"), '{"userValue":"保留原值"}');
});

test("a file in the selected profile path reports ENOTDIR without trying another profile", async t => {
  const result = await desktop(t, { block: "profile", errorCode: "ENOTDIR" });
  assert.equal(result.entryError, undefined);
  assert.match(result.events.find(event => event.errorDialog)?.errorDialog.detail || "", /ENOTDIR/);
  assert.ok(result.events.some(event => event.exit === 1));
  assert.deepEqual(result.profileChanges, []);
  assert.equal(result.events.includes("whenReady"), false);
});

test("CLI early initialization failure reports to stderr without opening a dialog", async t => {
  const result = await desktop(t, { block: "profile", cli: true });
  assert.equal(result.entryError, undefined);
  assert.ok(result.events.some(event => event.consoleError?.includes(result.profile)));
  assert.equal(result.events.some(event => event.errorDialog), false);
  assert.ok(result.events.some(event => event.exit === 1));
  assert.equal(result.events.includes("whenReady"), false);
});

test("CLI rejects an explicit profile file even when Electron has already returned its default profile", async t => {
  // Real Electron 43 returns its normal Roaming profile for this invalid switch.
  // Keep getPath(userData) on the default while getSwitchValue retains the file.
  const result = await desktop(t, { explicitPathIsFile: true, cli: true });
  assert.equal(result.entryError, undefined);
  assert.ok(result.events.some(event => event.exit === 1), "must stop rather than accept Electron's fallback");
  assert.ok(result.events.some(event => event.consoleError?.includes(result.explicitProfilePath)));
  assert.ok(result.events.some(event => /ENOTDIR|EEXIST/.test(event.consoleError || "")));
  assert.equal(result.events.some(event => event.errorDialog), false);
  assert.equal(result.events.includes("whenReady"), false);
  assert.deepEqual(result.profileChanges, []);
  assert.equal(await fsp.readFile(result.explicitProfilePath, "utf8"), "PRESERVE-EXPLICIT-PROFILE-078");
  assert.equal(await fsp.readFile(path.join(result.profile, "settings.json"), "utf8"), '{"userValue":"保留原值"}');
  assert.equal(fs.existsSync(path.join(result.profile, "debug.log")), false);
});

test("an empty explicit profile is rejected instead of selecting the working or default directory", async t => {
  const result = await desktop(t, { explicitValue: "", cli: true });
  assert.equal(result.entryError, undefined);
  assert.ok(result.events.some(event => event.exit === 1));
  assert.ok(result.events.some(event => /EINVAL/.test(event.consoleError || "")));
  assert.equal(result.events.includes("whenReady"), false);
  assert.deepEqual(result.profileChanges, []);
  assert.equal(fs.existsSync(path.join(result.profile, "debug.log")), false);
});

test("a usable explicit directory wins over Electron's default without copying default settings", async t => {
  const result = await desktop(t, { explicitProfileDifferent: true, boot: true });
  assert.equal(result.entryError, undefined);
  assert.equal(result.windows.length, 1, JSON.stringify(result.events));
  assert.deepEqual(result.profileChanges, [result.explicitProfilePath]);
  assert.equal(fs.existsSync(path.join(result.explicitProfilePath, "debug.log")), true);
  assert.equal(fs.existsSync(path.join(result.explicitProfilePath, "settings.json")), false);
  assert.equal(await fsp.readFile(path.join(result.profile, "settings.json"), "utf8"), '{"userValue":"保留原值"}');
  assert.equal(fs.existsSync(path.join(result.profile, "debug.log")), false);
});

if (LOCAL_SOURCE) test("local edition directory failure preserves the original profile and settings", async t => {
  const result = await desktop(t, { block: "local-profile", explicitProfile: false });
  assert.equal(result.entryError, undefined);
  assert.ok(result.events.find(event => event.errorDialog)?.errorDialog.detail.includes(result.localProfile));
  assert.ok(result.events.some(event => event.exit === 1));
  assert.deepEqual(result.profileChanges, []);
  assert.equal(result.events.includes("whenReady"), false);
  assert.equal(await fsp.readFile(path.join(result.profile, "settings.json"), "utf8"), '{"userValue":"保留原值"}');
});

test("an explicit Unicode profile starts without changing its path or overwriting settings", async t => {
  const result = await desktop(t, { boot: true });
  assert.equal(result.entryError, undefined);
  assert.equal(result.windows.length, 1, JSON.stringify(result.events));
  assert.equal(result.windows[0].options.webPreferences.sandbox, true);
  assert.deepEqual(result.profileChanges, []);
  assert.equal(await fsp.readFile(path.join(result.profile, "settings.json"), "utf8"), '{"userValue":"保留原值"}');
});

test("a missing packaged native entry falls back to the existing runtime for taskbar relaunch", async t => {
  const result = await desktop(t, { boot: true, launcherExists: false });
  assert.equal(result.entryError, undefined);
  assert.equal(result.windows.length, 1, JSON.stringify(result.events));
  assert.equal(result.windows[0].details?.relaunchCommand, `"${result.runtime}"`);
  assert.equal(result.windows[0].details?.appIconPath, result.runtime);
});

for (const launcherExists of [true, false]) {
  test(`packaged skill installation and taskbar agree on the ${launcherExists ? "native entry" : "runtime fallback"}`, async t => {
    const result = await desktop(t, { boot: true, launcherExists });
    assert.equal(result.entryError, undefined);
    assert.equal(result.windows.length, 1, JSON.stringify(result.events));
    const window = result.windows[0];
    const installed = await result.handlers.get("install-agent-skill")({
      sender: window.webContents, senderFrame: window.webContents.mainFrame
    }, { targetIds: ["codex"] });
    assert.equal(installed.failed.length, 0);
    assert.equal(installed.installed.length, 1);
    const launcher = JSON.parse(await fsp.readFile(path.join(result.skillRoot, "flyingmouse-format", "launcher.json"), "utf8"));
    const expected = launcherExists ? result.launcher : result.runtime;
    assert.equal(launcher.executable, expected);
    assert.deepEqual(launcher.args, []);
    assert.equal(window.details.relaunchCommand, `"${expected}"`);
    assert.equal(window.details.appIconPath, expected);
  });
}

test("development skill installation retains the runtime and source arguments", async t => {
  const result = await desktop(t, { boot: true, packaged: false });
  assert.equal(result.entryError, undefined);
  const window = result.windows[0];
  assert.ok(window, JSON.stringify(result.events));
  const installed = await result.handlers.get("install-agent-skill")({
    sender: window.webContents, senderFrame: window.webContents.mainFrame
  }, { targetIds: ["codex"] });
  assert.equal(installed.installed.length, 1);
  const launcher = JSON.parse(await fsp.readFile(path.join(result.skillRoot, "flyingmouse-format", "launcher.json"), "utf8"));
  assert.equal(launcher.executable, result.runtime);
  assert.deepEqual(launcher.args, [ROOT]);
  assert.equal(window.details, undefined);
});
