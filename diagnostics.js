const path = require("node:path");

const MAX_DIAGNOSTIC_LOG_BYTES = 64 * 1024;
const SECRET_KEY_PATTERN = /(authorization|bearer|cookie|credential|password|passwd|secret|token|api[_-]?key)/i;
// A source upload can have any extension (or no extension). Redact known
// conversion lifecycle lines and any filename-like suffix without a format
// whitelist; false positives are preferable to leaking a user's filename.
const SOURCE_FILE_LINE_PATTERN = /\.[^\s\\/"'<>|]{1,32}(?:$|[\s)"',;:])/u;
const CONVERSION_FILE_EVENT_PATTERN = /(?:Convert (?:request|succeeded|rejected|failed)|Rejected convert request|Images-to-PDF|Merge-PDFs|Rejected images-to-pdf|转换失败)/i;
const SECRET_LINE_PATTERN = /(?:\bBearer\s+|\b(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key)["']?\s*[:=])/i;

// 转换事件行（Convert request / succeeded / failed 等）整行抹掉会让诊断文件失去
// 信息量（用户反馈 2026-08-14：日志全变成 [REDACTED_FILE] 没法看）。改成只替换
// 引号内的文件名，保留事件类型、类别、目标格式和字节数。
function redactQuotedFilenames(line) {
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
  return text.split(/\r?\n/).map((line) => {
    if (line.includes("[REDACTED_SECRET]") || SECRET_LINE_PATTERN.test(line)) return "[REDACTED_SECRET]";
    if (
      (homePattern && homePattern.test(line))
      || /\b[A-Za-z]:\\./.test(line)
      || /\\\\[^\\\r\n]+\\[^\r\n]+/.test(line)
      || /(?:^|[\s("'=])\/(?!\/)(?:[^/\s]+\/)+/.test(line)
    ) return "[REDACTED_PATH]";
    // 转换事件行只抹引号内文件名，保留事件语义（Convert request/succeeded/failed 等）。
    if (CONVERSION_FILE_EVENT_PATTERN.test(line)) return redactQuotedFilenames(line);
    if (SOURCE_FILE_LINE_PATTERN.test(line)) return "[REDACTED_FILE]";
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
  const sanitized = sanitizeDiagnosticText(tailUtf8(input.logText), {
    userHome: input.userHome,
    secretValues
  });
  const boundedLog = tailUtf8(sanitized);
  const engines = Object.entries(input.engines || {}).sort(([left], [right]) => left.localeCompare(right));
  return [
    "Mahiro Format diagnostics",
    `Generated: ${safeField(input.generatedAt || new Date().toISOString())}`,
    `App version: ${safeField(input.appVersion)}`,
    `OS: ${safeField(input.platform)} ${safeField(input.release)} ${safeField(input.arch)}`,
    `Package: ${safeField(input.packageType)}`,
    "License: Non-Commercial. Commercial resale or rebranding is prohibited.",
    "Notice: Special music-container compatibility is experimental and unavailable in Microsoft Store builds. Process only files you lawfully obtained and may use; keep the source and review the output.",
    "",
    "Engines:",
    ...(engines.length ? engines.map(([name, details]) => engineLine(name, details)) : ["- unavailable"]),
    "",
    "Recent log (sanitized):",
    boundedLog
  ].join("\n");
}

module.exports = { MAX_DIAGNOSTIC_LOG_BYTES, buildDiagnosticsReport, sanitizeDiagnosticText, tailUtf8 };
