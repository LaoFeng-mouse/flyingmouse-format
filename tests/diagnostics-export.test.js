const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildDiagnosticsReport } = require("../diagnostics");
const { readLastSaveDirectory, writeLastSaveDirectory, readSettings } = require("../settings-store");
const saveDownload = require("../save-download");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-diagnostics-export-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "existing-report.txt");
  const settingsPath = path.join(root, "settings.json");
  await fsp.writeFile(destination, "OLD USER REPORT");
  // Execute the actual registered handler at its filesystem seam, without
  // starting Electron or its conversion service just to test report publication.
  const source = await fsp.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("export-diagnostics",');
  const end = source.indexOf("\nipcMain.handle(", start + 1);
  assert.ok(start >= 0 && end > start, "diagnostics IPC handler must be present");
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, registered) => { handler = registered; } },
    assertTrustedIpc: () => {}, fs, os, path, process, settingsPath,
    readLastSaveDirectory, writeLastSaveDirectory, saveDownload,
    mainWindow: {}, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    logger: { getLogFile: () => path.join(root, "debug.log") },
    serverRuntime: { getToolDiagnostics: async () => ({}) },
    app: { getPath: () => root, getVersion: () => "test", commandLine: { hasSwitch: () => true } },
    packageType: () => "test", buildDiagnosticsReport, log: () => {}
  });
  return { root, destination, settingsPath, exportReport: () => handler({}) };
}

test("diagnostics export preserves the old target when a disk-full write truncates its output", async (t) => {
  const f = await fixture(t);
  const writeFile = fsp.writeFile;
  t.mock.method(fsp, "writeFile", async (destination, _content, ...args) => {
    await writeFile(destination, "PARTIAL", ...args);
    throw Object.assign(new Error("disk full during report write"), { code: "ENOSPC" });
  });
  await assert.rejects(f.exportReport(), { code: "ENOSPC" });
  assert.equal(await fsp.readFile(f.destination, "utf8"), "OLD USER REPORT");
  assert.deepEqual(await fsp.readdir(f.root), ["existing-report.txt"]);
});

test("diagnostics export preserves the old target and settings when publishing is denied", async (t) => {
  const f = await fixture(t);
  t.mock.method(fsp, "rename", async () => {
    throw Object.assign(new Error("destination is locked"), { code: "EACCES" });
  });
  await assert.rejects(f.exportReport(), { code: "EACCES" });
  assert.equal(await fsp.readFile(f.destination, "utf8"), "OLD USER REPORT");
  assert.deepEqual(await fsp.readdir(f.root), ["existing-report.txt"]);
});

test("diagnostics export publishes the whole report before remembering the directory", async (t) => {
  const f = await fixture(t);
  const result = await f.exportReport();
  assert.equal(result.canceled, false);
  assert.equal(result.filePath, f.destination);
  const report = await fsp.readFile(f.destination, "utf8");
  assert.match(report, /^FlyingMouse Format diagnostics\n/);
  assert.match(report, /Recent log \(sanitized\):\n$/);
  assert.equal((await readSettings(f.settingsPath)).lastSaveDirectory, f.root);
  assert.deepEqual((await fsp.readdir(f.root)).sort(), ["existing-report.txt", "settings.json"]);
});

test("diagnostics export redacts source and unquoted destination names in real lifecycle lines", async (t) => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.root, "debug.log"), [
    '[2026-09-16T00:00:00.000Z] [INFO] Convert request: "客户清单 92874.txt" (txt/text) -> md (33 bytes)',
    '[2026-09-16T00:00:01.000Z] [INFO] Convert succeeded: "客户清单 92874.txt" -> 客户清单 92874.md (md)',
    '[2026-09-16T00:00:02.000Z] [WARN] Convert rejected: "内部报告.txt" -> pdf'
  ].join("\n"));
  await f.exportReport();
  const report = await fsp.readFile(f.destination, "utf8");
  assert.doesNotMatch(report, /客户清单|92874|内部报告/);
  assert.match(report, /Convert request:.*\(txt\/text\) -> md \(33 bytes\)/);
  assert.match(report, /Convert succeeded:.*-> \[REDACTED_FILE\] \(md\)/);
  assert.match(report, /Convert rejected:.*-> pdf/);
});

test("diagnostics export strips historical YAML error bodies and keeps later startup events", async (t) => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.root, "debug.log"), [
    '[2026-09-16T00:00:00.000Z] [WARN] Convert rejected: "old.yaml" -> json',
    'Error: YAML 解析失败：unknown tag !<PRIVATE_TAG_991> (5:1)',
    '',
    ' 2 | client: PRIVATE_CUSTOMER_992',
    ' 3 | account: PRIVATE_ACCOUNT_993',
    ' 4 | broken: [',
    ' 5 | ',
    '-----^',
    '    at convertText (C:\\private\\text-docx.js:237:25)',
    '[2026-09-16T00:00:01.000Z] [INFO] Boot started'
  ].join("\n"));
  await f.exportReport();
  const report = await fsp.readFile(f.destination, "utf8");
  assert.doesNotMatch(report, /PRIVATE_|old\.yaml/);
  assert.match(report, /YAML/);
  assert.match(report, /5:1/);
  assert.match(report, /Boot started/);
});

test("diagnostics export drops an incomplete first line when a historical excerpt exceeds the log tail", async (t) => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.root, "debug.log"), [
    'Error: YAML 解析失败：invalid YAML (2:1)',
    ` 1 | ${"padding".repeat(11000)}PRIVATE_CLIPPED_BODY_994`,
    ' 2 | account: PRIVATE_NEXT_LINE_995',
    '[2026-09-16T00:00:01.000Z] [INFO] Boot started'
  ].join("\n"));
  await f.exportReport();
  const report = await fsp.readFile(f.destination, "utf8");
  assert.doesNotMatch(report, /PRIVATE_/);
  assert.match(report, /Boot started/);
});
