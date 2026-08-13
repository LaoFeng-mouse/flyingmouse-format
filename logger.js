// Unified logger for FlyingMouse Format.
//
// Writes leveled log lines to a single file so failures can be diagnosed
// after the fact. The target file is resolved in this priority order:
//   1. FLYINGMOUSE_LOG_FILE env var (explicit override, used by tests)
//   2. Electron userData dir (desktop mode; the Electron main process calls
//      setLogFile early so server.js and the renderer share the same file)
//   3. Temp dir fallback (plain `node server.js` / tests without Electron)
//
// Logging must never break the app: every write is wrapped so an unwritable
// path or a full disk only drops log lines, never the conversion.

const fs = require("fs");
const os = require("os");
const path = require("path");

let logFileOverride = process.env.FLYINGMOUSE_LOG_FILE || "";
let resolvedFile = "";

const LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

// Keep the tail of the log bounded so a long-running app cannot grow
// debug.log without limit. 1 MB is plenty for diagnosing a session.
const MAX_LOG_BYTES = 1024 * 1024;

function defaultLogFile() {
  try {
    if (process.versions && process.versions.electron) {
      // eslint-disable-next-line global-require
      const { app } = require("electron");
      if (app && typeof app.getPath === "function") {
        return path.join(app.getPath("userData"), "debug.log");
      }
    }
  } catch {
    // Not running inside Electron; fall through to temp dir.
  }
  return path.join(os.tmpdir(), "flyingmouse-format-debug.log");
}

function ensureWritable(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  return filePath;
}

function trimIfOversized(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_BYTES) {
      // Keep only the last third of the file. Use read/write so we never
      // need to shell out; this runs at most once per oversized append.
      const fd = fs.openSync(filePath, "r+");
      try {
        const keep = Math.floor(MAX_LOG_BYTES / 3);
        const buffer = Buffer.alloc(keep);
        const bytesRead = fs.readSync(fd, buffer, 0, keep, Math.max(0, stat.size - keep));
        fs.truncateSync(filePath, 0);
        fs.writeSync(fd, buffer, 0, bytesRead, 0);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Trimming is best-effort.
  }
}

function currentFile() {
  if (resolvedFile) return resolvedFile;
  if (logFileOverride) {
    resolvedFile = ensureWritable(logFileOverride);
    return resolvedFile;
  }
  resolvedFile = ensureWritable(defaultLogFile());
  return resolvedFile;
}

// Called by electron-main.js once the app is ready so server.js and the
// renderer's IPC-forwarded messages land in the same debug.log.
function setLogFile(filePath) {
  if (!filePath) return;
  logFileOverride = filePath;
  resolvedFile = ensureWritable(filePath);
}

function formatError(error) {
  if (!error) return "";
  if (typeof error === "string") return ` ${error}`;
  const stack = error.stack || "";
  const message = error.message || String(error);
  return stack ? `\n${stack}` : ` ${message}`;
}

function write(level, message, error) {
  try {
    const filePath = currentFile();
    const line = `[${new Date().toISOString()}] [${level}] ${message}${formatError(error)}\n`;
    fs.appendFileSync(filePath, line, "utf8");
    trimIfOversized(filePath);
    // Also mirror to stdout so `node server.js` sessions stay observable.
    if (LEVELS[level] >= LEVELS.WARN) {
      const stream = process.env.FLYINGMOUSE_LOG_STDERR === "1" ? process.stderr : process.stdout;
      stream.write(`[${level}] ${message}${formatError(error)}\n`);
    }
  } catch {
    // Never let logging take down the app.
  }
}

function debug(message, error) {
  write("DEBUG", message, error);
}

function info(message, error) {
  write("INFO", message, error);
}

function warn(message, error) {
  write("WARN", message, error);
}

function error(message, err) {
  write("ERROR", message, err);
}

// Exposed for tests and diagnostics.
function getLogFile() {
  return currentFile();
}

module.exports = {
  setLogFile,
  getLogFile,
  debug,
  info,
  warn,
  error
};
