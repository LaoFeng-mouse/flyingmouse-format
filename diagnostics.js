const path = require("node:path");

const MAX_DIAGNOSTIC_LOG_BYTES = 64 * 1024;
const SECRET_KEY_PATTERN = /(authorization|bearer|cookie|credential|password|passwd|secret|token|api[_-]?key)/i;
// A source upload can have any extension (or no extension). Redact known
// conversion lifecycle lines and any filename-like suffix without a format
// whitelist; false positives are preferable to leaking a user's filename.
const SOURCE_FILE_LINE_PATTERN = /\.[^\s\\/"'<>|]{1,32}(?:$|[\s)"',;:])/u;
const CONVERSION_FILE_EVENT_PATTERN = /(?:Convert (?:request|succeeded|rejected|failed)|Rejected convert request|Images-to-PDF|Merge-PDFs|Rejected images-to-pdf|转换失败)/i;
const SECRET_LINE_PATTERN = /(?:\bBearer\s+|\b(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key)["']?\s*[:=])/i;

// These are fixed logger labels, not a list of words to search for in arbitrary
// error text. A filename or parser excerpt must not become an event or code.
const PATH_EVENT_LABELS = [
  "Boot failed", "CLI boot failed", "Uncaught exception", "Unhandled rejection",
  "Unhandled server error", "LibreOffice capability probe failed",
  "Failed to remember diagnostics directory", "Failed to remember save directory",
  "Failed to remove staged diagnostics report", "Save batch item failed",
  "Saved converted file", "Runtime dir", "Runtime directory", "FFmpeg path",
  "AV3A decoder path", "LibreOffice path", "Poppler path",
  "Extracting LibreOffice engine to staging",
  "LibreOffice writable-engine preparation failed; Office conversion remains unavailable"
];
const SYSTEM_ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EBUSY",
  "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EROFS", "ENAMETOOLONG", "EIO",
  "EXDEV", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EADDRINUSE",
  "EADDRNOTAVAIL", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ENOMEM",
  "ENOSYS", "EINVAL"
]);
const SYSTEM_OPERATIONS = new Set([
  "open", "mkdir", "rmdir", "stat", "lstat", "readdir", "scandir", "read",
  "write", "unlink", "rename", "copyfile", "realpath", "access", "spawn",
  "chmod", "chown", "symlink", "link", "readlink", "truncate", "utimes",
  "connect", "listen"
]);

function pathLineSummary(message, record) {
  const prefix = record ? `${record[1]} [${record[2]}] ` : "";
  // Reconstruct from allowlisted values; never return a sliced original prefix.
  let event = record ? PATH_EVENT_LABELS.find(label => message === label || message.startsWith(`${label}:`)) : "";
  let errorText = event ? message.slice(event.length).replace(/^:\s*/, "") : message;
  if (record && /^Server starting \(runtime dir:/.test(message)) event = "Server starting";
  if (record && /^Writable Office engine ready \((?:cache|bundled|prepared)\):/.test(message)) event = "Writable Office engine ready";
  const error = errorText.match(/^(?:Error:\s*)?([A-Z]+)(?::(?:\s|$)|$)/);
  const code = error && SYSTEM_ERROR_CODES.has(error[1]) ? error[1] : "";
  const fields = [];
  if (code) {
    fields.push(`code=${code}`);
    // Node filesystem errors put the syscall before the first quoted/absolute
    // path. Do not scan past that boundary or read operation names from paths.
    const beforePath = errorText.slice(error[0].length).split(/["'\\/]|[A-Za-z]:/u, 1)[0].trimEnd();
    const operation = beforePath.match(/(?:^|,\s*)([a-z]+)\s*$/)?.[1];
    if (SYSTEM_OPERATIONS.has(operation)) fields.push(`operation=${operation}`);
  }
  if (!event && code) event = "System error";
  return `${prefix}${event || ""}${fields.length ? `; ${fields.join("; ")}` : ""}${event ? " " : ""}[REDACTED_PATH]`;
}

// 转换事件行（Convert request / succeeded / failed 等）整行抹掉会让诊断文件失去
// 信息量（用户反馈 2026-08-14：日志全变成 [REDACTED_FILE] 没法看）。替换文件名
// 后保留事件类型、类别、目标格式和字节数。
function redactConversionFilenames(line) {
  if (/Convert succeeded:/i.test(line)) {
    // The server's historical success line quotes the input but not the output.
    // Keep the event and target format; neither basename is diagnostic data.
    return line.replace(/(Convert succeeded:\s*).*?(\s+\([a-z0-9]+\))\s*$/i,
      "$1[REDACTED_FILE] -> [REDACTED_FILE]$2");
  }
  if (/Rejected images-to-pdf:/i.test(line)) {
    return line.replace(/(Rejected images-to-pdf:).*/i, "$1 [REDACTED_FILE]");
  }
  return line.replace(/"[^"]*"/g, "[REDACTED_FILE]");
}

function tailUtf8(value, maxBytes = MAX_DIAGNOSTIC_LOG_BYTES) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let offset = buffer.length - maxBytes;
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1;
  return buffer.subarray(offset).toString("utf8");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeDiagnosticText(value, options = {}) {
  let text = String(value || "");
  const secretValues = Array.isArray(options.secretValues) ? options.secretValues : [];
  for (const secret of secretValues.filter((item) => typeof item === "string" && item.length >= 4)) {
    text = text.replace(new RegExp(escapeRegExp(secret), "gi"), "[REDACTED_SECRET]");
  }
  text = text.replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]");
  const homePattern = options.userHome
    ? new RegExp(escapeRegExp(options.userHome), "i")
    : null;
  let yamlErrorBody = false;
  return text.split(/\r?\n/).map((line) => {
    const record = line.match(/^(\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]) \[(DEBUG|INFO|WARN|ERROR)\] (.*)$/);
    const message = record ? record[3] : line;
    if (record) yamlErrorBody = false;
    // Old parser messages may contain document text in both the reason (tags)
    // and the following source excerpt. New logging rules cannot erase old logs.
    if (/^(?:Error:\s*)?YAML(?:Exception:|\s*解析失败[:：]|\s+parse\s+(?:error|failed))/i.test(message)) {
      yamlErrorBody = true;
      const location = message.match(/\((\d{1,10}:\d{1,10})\)\s*$/)?.[1];
      return `Error: YAML parse failed${location ? ` (${location})` : ""} [REDACTED_CONTENT]`;
    }
    // Match excerpts even when the bounded log starts after the error header.
    if (yamlErrorBody || /^\s*\d+\s*\|/.test(line) || /^\s*-+\^\s*$/.test(line)) return "[REDACTED_CONTENT]";
    if (line.includes("[REDACTED_SECRET]") || SECRET_LINE_PATTERN.test(line)) return "[REDACTED_SECRET]";
    if (
      (homePattern && homePattern.test(line))
      || /\b[A-Za-z]:[\\/]/.test(line)
      || /\\\\[^\\\r\n]+\\[^\r\n]+/.test(line)
      || /(?:^|[\s("'=])\/[^\s]/.test(line)
    ) return pathLineSummary(message, record);
    // 转换事件行只抹引号内文件名，保留事件语义（Convert request/succeeded/failed 等）。
    if (CONVERSION_FILE_EVENT_PATTERN.test(line)) return redactConversionFilenames(line);
    if (SOURCE_FILE_LINE_PATTERN.test(message)) return "[REDACTED_FILE]";
    return line;
  }).join("\n");
}

function executableBaseName(value) {
  const input = String(value || "");
  return path.win32.basename(input) || path.posix.basename(input);
}

function safeField(value) {
  return String(value ?? "unknown").replace(/[\r\n]/g, " ").slice(0, 200);
}

function engineLine(name, details = {}) {
  if (name === "docstructure") {
    const fields = [details.available ? "available" : "unavailable"];
    if (details.engineVersion) fields.push(`engineVersion=${safeField(details.engineVersion)}`);
    if (details.modelLockVersion) fields.push(`modelLockVersion=${safeField(details.modelLockVersion)}`);
    if (details.errorCode) fields.push(`errorCode=${safeField(details.errorCode)}`);
    return `- docstructure: ${fields.join("; ")}`;
  }
  const fields = [details.enabled ? "enabled" : "disabled"];
  if (details.version) fields.push(`version=${safeField(details.version)}`);
  if (details.errorCode) fields.push(`errorCode=${safeField(details.errorCode)}`);
  if (details.executable) fields.push(`executable=${safeField(executableBaseName(details.executable))}`);
  return `- ${safeField(name)}: ${fields.join("; ")}`;
}

function buildDiagnosticsReport(input = {}) {
  const secretValues = Object.entries(input.environment || {})
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === "string")
    .map(([, value]) => value);
  const rawLog = String(input.logText || "");
  let logTail = tailUtf8(rawLog);
  if (Buffer.byteLength(rawLog, "utf8") > MAX_DIAGNOSTIC_LOG_BYTES) {
    // A byte-bounded tail may start halfway through a sensitive source excerpt,
    // after its line number or error header. Discard that unclassifiable fragment.
    const newline = logTail.indexOf("\n");
    logTail = newline < 0 ? "" : logTail.slice(newline + 1);
  }
  const sanitized = sanitizeDiagnosticText(logTail, {
    userHome: input.userHome,
    secretValues
  });
  const boundedLog = tailUtf8(sanitized);
  const engines = Object.entries(input.engines || {}).sort(([left], [right]) => left.localeCompare(right));
  return [
    "FlyingMouse Format diagnostics",
    `Generated: ${safeField(input.generatedAt || new Date().toISOString())}`,
    `App version: ${safeField(input.appVersion)}`,
    `OS: ${safeField(input.platform)} ${safeField(input.release)} ${safeField(input.arch)}`,
    `Package: ${safeField(input.packageType)}`,
    `Build channel: ${safeField(input.buildChannel || "public")}`,
    `Compatible startup: ${input.noStdioInit === true}`,
    "Author: 牢蜂 (LaoFeng)",
    "License: Non-Commercial. Commercial resale or rebranding is prohibited.",
    "Notice: This software supports only ordinary audio format conversion and does not support encrypted special formats from any music platform. Please support the artists.",
    "",
    "Engines:",
    ...(engines.length ? engines.map(([name, details]) => engineLine(name, details)) : ["- unavailable"]),
    "",
    "Recent log (sanitized):",
    boundedLog
  ].join("\n");
}

module.exports = { MAX_DIAGNOSTIC_LOG_BYTES, buildDiagnosticsReport, sanitizeDiagnosticText, tailUtf8 };
