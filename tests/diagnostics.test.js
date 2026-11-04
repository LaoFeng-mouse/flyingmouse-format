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

test("structured engine diagnostics expose only bounded status and versions", () => {
  const report = buildDiagnosticsReport({
    generatedAt: "2026-08-10T08:00:00.000Z",
    appVersion: "0.5.0",
    platform: "win32",
    release: "10.0.26100",
    arch: "x64",
    packageType: "github-nsis",
    engines: {
      docstructure: {
        available: false,
        engineVersion: "3.7.0",
        modelLockVersion: "docstructure-engine-v1",
        errorCode: "PDF_STRUCTURE_ENGINE_UNAVAILABLE",
        executable: "C:\\Users\\Alice\\private\\docstructure-engine.exe",
        arguments: ["C:\\Users\\Alice\\secret.pdf"],
        url: "https://example.test/model",
        content: "customer invoice text"
      }
    },
    logText: ""
  });

  assert.match(report, /docstructure: unavailable; engineVersion=3\.7\.0; modelLockVersion=docstructure-engine-v1; errorCode=PDF_STRUCTURE_ENGINE_UNAVAILABLE/);
  for (const secret of ["Alice", "secret.pdf", "example.test", "customer invoice text", "arguments", "executable"]) {
    assert.doesNotMatch(report, new RegExp(secret, "i"));
  }
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

test("path redaction retains boot failure time, level and system error without its raw message", () => {
  const line = "[2026-10-02T00:00:00.000Z] [ERROR] Boot failed: ENOENT: no such file or directory, mkdir 'D:\\客户资料 空格\\私人目录' PRIVATE_ERROR_BODY";
  assert.equal(sanitizeDiagnosticText(line),
    "[2026-10-02T00:00:00.000Z] [ERROR] Boot failed; code=ENOENT; operation=mkdir [REDACTED_PATH]");
});

for (const sourcePath of [
  "C:\\Users\\Alice Name\\Documents\\内部 财务.xlsx",
  "C:/Users/Alice Name/Documents/内部 财务.xlsx",
  "\\\\Private Server\\Internal Share\\内部 财务.xlsx",
  "/home/Alice Name/内部 财务.xlsx",
  "/内部 财务.xlsx"
]) {
  test(`path errors retain a known code and operation for ${JSON.stringify(sourcePath)}`, () => {
    const output = sanitizeDiagnosticText(`[2026-10-02T00:00:00.001Z] [ERROR] EPERM: operation not permitted, open '${sourcePath}' PRIVATE_ERROR_BODY`);
    assert.equal(output, "[2026-10-02T00:00:00.001Z] [ERROR] System error; code=EPERM; operation=open [REDACTED_PATH]");
    assert.doesNotMatch(output, /Alice|财务|Private|Internal|PRIVATE_ERROR_BODY/);
  });
}

test("normal configured paths retain their static event label without user-controlled suffixes", () => {
  for (const label of ["Runtime dir", "Runtime directory", "FFmpeg path", "LibreOffice path", "Poppler path", "AV3A decoder path"]) {
    const output = sanitizeDiagnosticText(`[2026-10-02T00:00:00.002Z] [INFO] ${label}: C:\\私人 文件夹\\tool name.exe PRIVATE_SUFFIX`);
    assert.equal(output, `[2026-10-02T00:00:00.002Z] [INFO] ${label} [REDACTED_PATH]`);
  }
});

test("real multiline logger errors retain the failure header and known error while dropping stacks", () => {
  const output = sanitizeDiagnosticText([
    "[2026-10-02T00:00:00.003Z] [ERROR] Boot failed",
    "Error: ENOSPC: no space left on device, write 'C:\\私人 文件夹\\output.tmp' PRIVATE_BODY",
    "    at PRIVATE_FUNCTION (C:\\私人 文件夹\\app.js:1:2)",
    "[2026-10-02T00:00:00.004Z] [INFO] Desktop interface ready"
  ].join("\n"));
  assert.equal(output, [
    "[2026-10-02T00:00:00.003Z] [ERROR] Boot failed",
    "System error; code=ENOSPC; operation=write [REDACTED_PATH]",
    "[REDACTED_PATH]",
    "[2026-10-02T00:00:00.004Z] [INFO] Desktop interface ready"
  ].join("\n"));
});

test("path summaries cannot promote filenames, arbitrary errors or malformed timestamps into facts", () => {
  for (const message of [
    "PRIVATE_EVENT ENOENT: no such file, open 'C:\\私人\\file.txt'",
    "Boot failed PRIVATE_EVENT: ENOENT: no such file, open 'C:\\私人\\file.txt'",
    "Boot failed: PRIVATE_CUSTOM_CODE: ENOENT open 'C:\\私人\\file.txt'",
    "Boot failed: read 'C:\\ENOENT\\open EPERM.txt'",
    "Boot failed: PRIVATE_CUSTOM_CODE: 'C:\\私人\\file.txt'"
  ]) {
    const output = sanitizeDiagnosticText(`[2026-10-02T00:00:00.005Z] [ERROR] ${message}`);
    assert.doesNotMatch(output, /PRIVATE_|ENOENT|EPERM|code=|operation=|私人/);
    assert.match(output, /^\[2026-10-02T00:00:00\.005Z\] \[ERROR\]/);
  }
  assert.equal(sanitizeDiagnosticText("[2026-10-02TPRIVATE_TIMESTAMP] [ERROR] C:\\私人\\file.txt"), "[REDACTED_PATH]");
});

test("path classification does not override secrets or historical YAML document suppression", () => {
  const output = sanitizeDiagnosticText([
    "[2026-10-02T00:00:00.006Z] [ERROR] Boot failed: EPERM: open 'C:\\Alice\\settings.json' token=PRIVATE_TOKEN",
    "[2026-10-02T00:00:00.007Z] [ERROR] Boot failed: ENOENT: mkdir 'D:\\PRIVATE_SECRET_VALUE\\data'",
    "Error: YAML 解析失败：unknown tag !<PRIVATE_TAG> (5:1)",
    " 3 | Boot failed: ENOENT: mkdir 'D:\\PRIVATE_YAML_VALUE\\data'",
    "Error: EPERM: open 'C:\\PRIVATE_YAML_BODY\\data'",
    "-----^",
    "[2026-10-02T00:00:00.008Z] [INFO] Runtime dir: C:\\PRIVATE_RUNTIME\\data"
  ].join("\n"), { secretValues: ["PRIVATE_SECRET_VALUE"] });
  assert.doesNotMatch(output, /PRIVATE_|EPERM|ENOENT|operation=/);
  assert.match(output, /\[REDACTED_SECRET\]/);
  assert.match(output, /YAML parse failed \(5:1\) \[REDACTED_CONTENT\]/);
  assert.match(output, /\[INFO\] Runtime dir \[REDACTED_PATH\]$/);
});

test("64 KiB report tail preserves newest path failure without clipped document data", () => {
  const report = buildDiagnosticsReport({
    environment: { API_TOKEN: "PRIVATE_AUTH_VALUE" },
    logText: [
      ` 1 | ${"旧资料".repeat(30000)}PRIVATE_CLIPPED_CONTENT`,
      " 2 | C:\\PRIVATE_DOCUMENT\\report.txt",
      "[2026-10-02T00:00:00.008Z] [ERROR] Boot failed: ENOENT: mkdir 'D:\\PRIVATE_RUNTIME\\data'",
      "[2026-10-02T00:00:00.009Z] [ERROR] Boot failed: ENOENT: mkdir 'D:\\PRIVATE_AUTH_VALUE\\data'"
    ].join("\n")
  });
  const logSection = report.split("Recent log (sanitized):\n")[1];
  assert.ok(Buffer.byteLength(logSection, "utf8") <= MAX_DIAGNOSTIC_LOG_BYTES);
  assert.match(logSection, /\[ERROR\] Boot failed; code=ENOENT; operation=mkdir \[REDACTED_PATH\]/);
  assert.doesNotMatch(report, /PRIVATE_|旧资料|�/);
});

test("an actual Node filesystem failure keeps its code and syscall without disclosing the requested path", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { randomUUID } = require("node:crypto");
  const missingPath = path.join(os.tmpdir(), `fm-diag-${randomUUID()}`, "PRIVATE_FINANCIAL_RECORD 中文.xlsx");
  let failure;
  try { fs.readFileSync(missingPath); } catch (error) { failure = error; }
  assert.equal(failure?.code, "ENOENT");
  const output = sanitizeDiagnosticText(`[2026-10-02T00:00:00.010Z] [ERROR] Boot failed\n${failure.stack}`);
  assert.match(output, /System error; code=ENOENT; operation=open \[REDACTED_PATH\]/);
  assert.doesNotMatch(output, /PRIVATE_FINANCIAL_RECORD|fm-diag-|中文|diagnostics\.test/);
  assert.ok(!output.includes(os.tmpdir()));
});
