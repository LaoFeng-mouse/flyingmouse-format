const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MAX_DIAGNOSTIC_LOG_BYTES,
  buildDiagnosticsReport,
  sanitizeDiagnosticText,
  tailUtf8
} = require("../diagnostics");

test("diagnostics report contains bounded platform and engine facts without full paths", () => {
  const report = buildDiagnosticsReport({
    generatedAt: "2026-08-10T08:00:00.000Z",
    appVersion: "0.3.4",
    platform: "win32",
    release: "10.0.26100",
    arch: "x64",
    packageType: "github-nsis",
    engines: {
      libreoffice: {
        enabled: false,
        errorCode: "OFFICE_ENGINE_PROFILE_FAILED",
        executable: "C:\\Users\\Alice\\Downloads\\FlyingMouse\\soffice.com"
      },
      ffmpeg: {
        enabled: true,
        version: "7.1",
        executable: "D:\\apps\\FlyingMouse\\ffmpeg.exe"
      }
    },
    logText: "safe line"
  });

  assert.match(report, /App version: 0\.3\.4/);
  assert.match(report, /OS: win32 10\.0\.26100 x64/);
  assert.match(report, /Package: github-nsis/);
  assert.match(report, /libreoffice: disabled; errorCode=OFFICE_ENGINE_PROFILE_FAILED; executable=soffice\.com/);
  assert.match(report, /ffmpeg: enabled; version=7\.1; executable=ffmpeg\.exe/);
  assert.doesNotMatch(report, /Alice|Downloads|D:\\apps/);
});

test("diagnostics redacts credentials, home paths, URLs, and source filenames", () => {
  const source = [
    "Input C:\\Users\\Alice\\Documents\\客户名单.xlsx failed",
    "authorization: Bearer super-secret-token",
    "password=hunter2 api_key=abc123 token: xyz789",
    "https://example.test/upload?token=visible&name=客户名单.pdf",
    "plain source 秘密报价.docx",
    "Convert Client Proposal 2026.pdf failed",
    "UNC \\\\fileserver\\customers\\Acme\\quarterly results.xlsx",
    "POSIX /mnt/private/customer/offer.docx",
    "JSON {\"token\":\"json-secret-value\"}",
    "password=demo secret value with spaces",
    "Convert Client Budget.ods failed",
    "Convert Customer Notes.json failed",
    "Convert Private Clip.webm failed",
    "Convert Tender Draft.rtf failed",
    "Convert Unknown Research.customext failed",
    "Convert Client Backup.7z failed",
    "Convert Client Archive.123abc failed",
    "Convert Client Note.扩展 failed",
    "Convert request: \"README\" failed"
  ].join("\n");
  const sanitized = sanitizeDiagnosticText(source, {
    userHome: "C:\\Users\\Alice",
    secretValues: ["super-secret-token", "hunter2", "abc123", "xyz789"]
  });

  for (const secret of ["Alice", "客户名单", "秘密报价", "Client Proposal", "fileserver", "Acme", "quarterly results", "mnt/private", "offer", "json-secret-value", "demo secret value", "Client Budget", "Customer Notes", "Private Clip", "Tender Draft", "Unknown Research", "Client Backup", "Client Archive", "Client Note", "README", "super-secret-token", "hunter2", "abc123", "xyz789"]) {
    assert.doesNotMatch(sanitized, new RegExp(secret));
  }
  assert.match(sanitized, /\[REDACTED_PATH\]/);
  assert.match(sanitized, /\[REDACTED_SECRET\]/);
  assert.match(sanitized, /\[REDACTED_FILE\]/);
});

test("UTF-8 log tails never exceed 64 KiB and retain the newest complete text", () => {
  const log = `${"旧日志鼠".repeat(30000)}\nLATEST-诊断行`;
  const tail = tailUtf8(log, MAX_DIAGNOSTIC_LOG_BYTES);
  assert.ok(Buffer.byteLength(tail, "utf8") <= MAX_DIAGNOSTIC_LOG_BYTES);
  assert.match(tail, /LATEST-诊断行$/);
  assert.doesNotMatch(tail, /�/);
});

test("report sanitizes and bounds log text after redaction expansion", () => {
  const report = buildDiagnosticsReport({
    appVersion: "0.3.4",
    platform: "win32",
    release: "10",
    arch: "x64",
    packageType: "github-nsis",
    userHome: "C:\\Users\\Alice",
    environment: { API_TOKEN: "top-secret", PATH: "C:\\safe" },
    logText: `${"padding\n".repeat(15000)}C:\\Users\\Alice\\Desktop\\private.pdf token=top-secret`
  });
  const logSection = report.split("Recent log (sanitized):\n")[1];
  assert.ok(Buffer.byteLength(logSection, "utf8") <= MAX_DIAGNOSTIC_LOG_BYTES);
  assert.doesNotMatch(report, /Alice|private|top-secret/);
});
