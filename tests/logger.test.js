const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { after, before, test } = require("node:test");

const logger = require("../logger");
const scratchRoot = path.join(os.tmpdir(), `flyingmouse-format-logger-tests-${process.pid}`);

function readRoot(fileName) {
  return fs.readFileSync(path.join(__dirname, "..", fileName), "utf8");
}

before(async () => {
  await fsp.mkdir(scratchRoot, { recursive: true });
});

after(async () => {
  await fsp.rm(scratchRoot, { recursive: true, force: true });
});

test("logger writes leveled lines with timestamps to the configured file", async () => {
  const logFile = path.join(scratchRoot, "debug.log");
  logger.setLogFile(logFile);

  logger.info("hello info");
  logger.warn("hello warn");
  logger.error("hello error", new Error("boom"));

  const content = await fsp.readFile(logFile, "utf8");
  const lines = content.trim().split("\n");

  assert.ok(lines.some((line) => line.includes("[INFO] hello info")), "INFO line missing");
  assert.ok(lines.some((line) => line.includes("[WARN] hello warn")), "WARN line missing");
  assert.ok(lines.some((line) => line.includes("[ERROR] hello error")), "ERROR line missing");
  assert.match(content, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "timestamp missing");
  assert.match(content, /Error: boom/, "error stack was not appended");
});

test("logger mirrors warnings and errors to stdout but not info", async () => {
  const logFile = path.join(scratchRoot, "stdout.log");
  logger.setLogFile(logFile);

  const writes = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };

  try {
    logger.info("quiet-info");
    logger.warn("loud-warn");
    logger.error("loud-error", new Error("detail"));
  } finally {
    process.stdout.write = originalWrite;
  }

  const stdout = writes.join("");
  assert.ok(!stdout.includes("quiet-info"), "INFO should not be mirrored to stdout");
  assert.ok(stdout.includes("loud-warn"), "WARN should be mirrored to stdout");
  assert.ok(stdout.includes("loud-error"), "ERROR should be mirrored to stdout");
});

test("server.js routes conversion lifecycle events through the logger", () => {
  const source = readRoot("server.js");
  assert.match(source, /require\("\.\/logger"\)/, "server must require the logger");
  assert.match(source, /logger\.info\(`Convert request/, "convert request start must be logged");
  assert.match(source, /logger\.info\(`Convert succeeded/, "convert success must be logged");
  assert.match(source, /logger\.error\(`Convert failed/, "convert failure must be logged");
  assert.match(source, /Command failed/, "engine stderr must be logged on command failure");
  assert.match(source, /Server listening on/, "server startup must be logged");
});

test("electron main forwards renderer log events to debug.log behind the trust boundary", () => {
  const source = readRoot("electron-main.js");
  assert.match(source, /require\("\.\/logger"\)/, "main must require the logger");
  assert.match(source, /logger\.setLogFile\(/, "main must point the logger at userData");
  assert.match(source, /ipcMain\.handle\("log-event"/, "log-event IPC handler is missing");
  assert.match(source, /assertTrustedIpc\(event\)/, "renderer log IPC must check the trust boundary");
  assert.match(source, /\[renderer\]/, "renderer messages must be tagged");
});

test("preload exposes a log bridge to the renderer", () => {
  const source = readRoot("preload.js");
  assert.match(source, /log\(level, message\)/, "preload must expose log(level, message)");
  assert.match(source, /"log-event"/, "preload must invoke the log-event channel");
});

test("renderer reports uncaught errors and conversion failures to the main process", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /window\.flyingMouseFormat \|\| \{\}/, "log bridge fallback missing");
  assert.match(app, /function rendererLog\(/, "rendererLog helper missing");
  assert.match(app, /addEventListener\("error"/, "window error listener missing");
  assert.match(app, /addEventListener\("unhandledrejection"/, "unhandledrejection listener missing");
  assert.match(app, /logBridge\.log\(level, detail\)/, "renderer must forward through the bridge");
});

test("package.json build whitelist includes logger.js", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  assert.ok(
    packageJson.build.files.includes("logger.js"),
    "logger.js must be in build.files or the packaged app will crash with MODULE_NOT_FOUND"
  );
});
