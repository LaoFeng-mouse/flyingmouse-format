"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test, before, after, mock } = require("node:test");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const sharp = require("sharp");

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
let mergeGate;
for (const [module, name] of [[require("../image"), "convertImagesToPdf"], [require("../pdf"), "mergePdfFiles"]]) {
  const original = module[name];
  mock.method(module, name, async (...args) => {
    if (mergeGate) {
      mergeGate.enter(args[2]?.signal);
      await mergeGate.wait;
    }
    return original(...args);
  });
}
const { app } = require("../server");
let server, origin, pdfBytes, pngBytes;
before(async () => {
  require("../utils").ensureDirs();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Native PDF text must not be published after its HTTP client disconnects.", { x: 30, y: 700, size: 12, font });
  pdfBytes = await pdf.save();
  pngBytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "red" } }).png().toBuffer();
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

function mergeRequest(route, bytes, name) {
  const id = randomUUID(), controller = new AbortController(), form = new FormData();
  form.append("files", new Blob([bytes]), name);
  form.append("files", new Blob([bytes]), `other-${name}`);
  const response = fetch(origin + route, {
    method: "POST", body: form, signal: controller.signal,
    headers: { "X-FlyingMouse-Progress-Id": id }
  });
  response.catch(() => {});
  return { id, controller, response };
}

for (const route of ["/api/convert-images-to-pdf", "/api/merge-pdfs"]) {
  const input = () => route.includes("images") ? [pngBytes, "cancel.png"] : [pdfBytes, "cancel.pdf"];
  test(`${route} forwards HTTP cancellation to the merge and cleans unpublished output`, async t => {
    mergeGate = gate();
    t.after(() => { mergeGate?.release(); mergeGate = null; });
    const originalIds = [...config.downloads.keys()], running = mergeRequest(route, ...input());
    const signal = await mergeGate.entered;
    running.controller.abort();
    await assert.rejects(running.response, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 30));
    mergeGate.release();
    assert.ok(signal?.aborted, "the real merge must receive the request's aborted signal");
    await assertUnpublished(running.id, originalIds);
  });

  test(`${route} does not publish a completed merge when the client disconnects during validation`, async t => {
    const checked = gate(), stat = fsp.stat;
    t.after(checked.release);
    t.mock.method(fsp, "stat", async (file, ...args) => {
      const result = await stat(file, ...args);
      if (path.dirname(String(file)) === config.OUTPUT_DIR && String(file).endsWith(".pdf")) {
        checked.enter(); await checked.wait;
      }
      return result;
    });
    const originalIds = [...config.downloads.keys()], running = mergeRequest(route, ...input());
    await checked.entered;
    running.controller.abort();
    await assert.rejects(running.response, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 30));
    checked.release();
    await waitFor(async () => (await fsp.readdir(config.OUTPUT_DIR)).length === 0
      || [...config.downloads.keys()].length > originalIds.length);
    await assertUnpublished(running.id, originalIds);
  });
}

test("both merge routes still publish complete downloadable PDFs for connected callers", async () => {
  for (const [route, bytes, name] of [["/api/convert-images-to-pdf", pngBytes, "sample.png"], ["/api/merge-pdfs", pdfBytes, "sample.pdf"]]) {
    const response = await mergeRequest(route, bytes, name).response;
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const downloaded = await fetch(origin + result.downloadUrl);
    assert.equal(downloaded.status, 200);
    const output = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(output.length, result.previewSize);
    assert.equal((await PDFDocument.load(output)).getPageCount(), 2);
  }
});
