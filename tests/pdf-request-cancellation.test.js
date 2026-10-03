"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test, before, after, mock } = require("node:test");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-pdf-request-cancel-"));
process.env.FLYINGMOUSE_RUNTIME_DIR = root;
process.env.FLYINGMOUSE_LOG_FILE = path.join(root, "test.log");
const config = require("../config");
config.DOCENGINE_PATH = "held-test-docengine";
mock.method(require("../utils"), "commandExists", async () => false);
mock.method(require("../office-engine"), "probeLibreOffice", async () => ({ enabled: false }));
mock.method(require("../markdown-document"), "pandocPath", () => "");
mock.method(require("../pdf-structure-engine"), "getStructuredPdfAvailability", async () => ({ enabled: false }));
let structuredCalls = 0;
const structuredBoundary = require("../pdf-structure-engine").withStructuredPdf;
mock.method(require("../pdf-structure-engine"), "withStructuredPdf", (...args) => {
  structuredCalls += 1;
  return structuredBoundary(...args);
});
let nativeGate;
// Only the external engine boundary is held. The HTTP route, PDF classifier,
// native/fallback routing, cancellation, publication and cleanup remain real.
mock.method(require("../utils"), "run", async (command, _args, options) => {
  assert.equal(command, config.DOCENGINE_PATH);
  nativeGate.enter(options.signal);
  await nativeGate.wait;
  require("../conversion-cancellation").throwIfCanceled(options.signal);
  throw new Error("Synthetic native engine failure after the held boundary");
});
const { app } = require("../server");
let server, origin, pdfBytes;
before(async () => {
  require("../utils").ensureDirs();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Native PDF text must not be published after its HTTP client disconnects.", { x: 30, y: 700, size: 12, font });
  pdfBytes = await pdf.save();
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  mock.restoreAll();
  await fsp.rm(root, { recursive: true, force: true });
});

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { enter, entered, wait, release };
}
function request(target) {
  const id = randomUUID(), controller = new AbortController(), form = new FormData();
  form.append("file", new Blob([pdfBytes]), "cancel.pdf");
  form.append("targetFormat", target);
  const response = fetch(origin + "/api/convert", {
    method: "POST", body: form, signal: controller.signal,
    headers: { "X-FlyingMouse-Progress-Id": id }
  });
  response.catch(() => {});
  return { id, controller, response };
}
async function waitFor(check) {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for request cleanup");
}
async function assertUnpublished(id, originalIds) {
  await waitFor(async () => (await fsp.readdir(config.UPLOAD_DIR)).length === 0);
  assert.deepEqual([...config.downloads.keys()], originalIds);
  assert.deepEqual(await fsp.readdir(config.OUTPUT_DIR), []);
  const progress = await (await fetch(origin + "/api/conversion-progress/" + id)).json();
  assert.equal(progress.status, "failed");
}

test("disconnecting a PDF request reaches the native engine signal and never enters a successful fallback", async t => {
  nativeGate = gate(); t.after(nativeGate.release);
  const originalIds = [...config.downloads.keys()], originalStructuredCalls = structuredCalls, running = request("docx");
  const signal = await nativeGate.entered;
  running.controller.abort();
  await assert.rejects(running.response, { name: "AbortError" });
  // Let the socket-close event arrive before releasing the engine boundary.
  await new Promise(resolve => setTimeout(resolve, 30));
  nativeGate.release();
  await waitFor(async () => (await fsp.readdir(config.UPLOAD_DIR)).length === 0);
  assert.ok(signal?.aborted, "PDF conversion must receive the request's aborted signal");
  assert.equal(structuredCalls, originalStructuredCalls, "cancellation must not start a structured fallback attempt");
  await assertUnpublished(running.id, originalIds);
});

test("disconnecting while a completed PDF output is being checked cannot register a download", async t => {
  const checked = gate(), stat = fsp.stat;
  t.after(checked.release);
  t.mock.method(fsp, "stat", async (file, ...args) => {
    const result = await stat(file, ...args);
    if (path.dirname(String(file)) === config.OUTPUT_DIR && String(file).endsWith(".txt")) {
      checked.enter(); await checked.wait;
    }
    return result;
  });
  const originalIds = [...config.downloads.keys()], running = request("txt");
  await checked.entered;
  running.controller.abort();
  await assert.rejects(running.response, { name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 30));
  checked.release();
  await waitFor(async () => (await fsp.readdir(config.OUTPUT_DIR)).length === 0
    || [...config.downloads.keys()].length > originalIds.length);
  await assertUnpublished(running.id, originalIds);
});
