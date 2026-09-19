const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createOfficeReadiness } = require("../office-readiness");

async function fixture(t, { fail = false, prepareOffice = true, officeProbe } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-store-capabilities-"));
  const appRoot = path.join(__dirname, "..");
  const readiness = createOfficeReadiness();
  let finish;
  let probes = 0;
  let conversions = 0;
  if (prepareOffice) {
    readiness.configureOfficePreparation({ path: "prepared-soffice", prepare: () => new Promise(resolve => { finish = resolve; }) });
    void readiness.startOfficePreparation();
  }
  const config = { ...require("../config"), RUNTIME_DIR: root,
    UPLOAD_DIR: path.join(root, "uploads"), OUTPUT_DIR: path.join(root, "outputs") };
  fs.mkdirSync(config.UPLOAD_DIR); fs.mkdirSync(config.OUTPUT_DIR);
  const realUtils = require("../utils");
  const overrides = {
    "./config": config,
    "./office-readiness": { ...require("../office-readiness"), ...readiness },
    "./office-engine": { ...require("../office-engine"), probeLibreOffice: async () => {
      probes++; return officeProbe ? officeProbe() : { enabled: true, version: "verified-test" };
    } },
    "./office-convert": { ...require("../office-convert"), convertWithLibreOffice: async (_input, output) => {
      conversions++; await fsp.writeFile(output, "prepared Office output");
    } },
    "./pdf-structure-engine": { getStructuredPdfAvailability: async () => ({ enabled: false,
      errorCode: "PDF_STRUCTURE_MODEL_MISSING", limits: { maxPages: 500 }, modelValidation: "required-files" }) },
    "./markdown-document": { pandocPath: () => "" },
    "./subtitles": { convertSubtitle: async () => { throw new Error("not used"); } },
    "./utils": { ...realUtils, commandExists: async () => true,
      outputPathFor: (_name, target) => path.join(config.OUTPUT_DIR, `output.${target}`) }
  };
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, "server.js"), "utf8"), {
    __dirname: appRoot, module: exported, exports: exported.exports, process, Buffer, console,
    setInterval, clearInterval, setTimeout, clearTimeout, URL,
    require: name => Object.hasOwn(overrides, name) ? overrides[name]
      : name.startsWith("./") ? require(path.join(appRoot, name)) : require(name)
  });
  const server = await new Promise(resolve => {
    const listening = exported.exports.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fsp.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, readiness, complete: async () => {
    finish(fail ? { path: "readonly-soffice", source: "bundled", reason: "test disk full" }
      : { path: "prepared-soffice", source: "published" });
    await readiness.startOfficePreparation();
  }, probes: () => probes, conversions: () => conversions,
    diagnostics: () => exported.exports.getToolDiagnostics() };
}

async function convert(url, name, target) {
  const form = new FormData();
  form.set("file", new Blob(["Hello Office"]), name);
  form.set("targetFormat", target);
  const response = await fetch(`${url}/api/convert`, { method: "POST", body: form });
  return { status: response.status, body: await response.json() };
}

async function targets(url, extension) {
  const response = await fetch(`${url}/api/targets`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extension })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function beforeOfficeCompletes(request) {
  let timeout;
  try {
    const result = await Promise.race([
      request,
      // This is a deadlock guard, not a benchmark: the Office promise remains
      // unresolved until after the assertion, even on a busy CI worker.
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 2000); })
    ]);
    assert.ok(result, "PDF targets must respond while the unrelated Office probe is still blocked");
    return result;
  } finally { clearTimeout(timeout); }
}

test("cold PDF target lookup does not start or await an unrelated Office probe", async t => {
  let release;
  const blockedProbe = new Promise(resolve => { release = resolve; });
  const fixtureData = await fixture(t, { prepareOffice: false, officeProbe: () => blockedProbe });
  const request = targets(fixtureData.url, "PDF");
  try {
    const result = await beforeOfficeCompletes(request);
    assert.equal(result.extension, "pdf");
    assert.equal(result.category, "pdf");
    assert.ok(result.targets.includes("docx"));
    assert.ok(result.targets.includes("xlsx"));
    assert.ok(result.targets.includes("png"));
    assert.equal(fixtureData.probes(), 0, "PDF lookup must not launch LibreOffice");
  } finally {
    release({ enabled: true, version: "verified-test" });
    await request;
  }
});

test("PDF target lookup stays independent of an active Office probe without resetting its cache", async t => {
  let release;
  let started;
  const probeStarted = new Promise(resolve => { started = resolve; });
  const blockedProbe = new Promise(resolve => { release = resolve; });
  const fixtureData = await fixture(t, { prepareOffice: false, officeProbe: () => {
    started(); return blockedProbe;
  } });
  let capabilitySettled = false;
  const capabilities = fetch(`${fixtureData.url}/api/capabilities`).then(response => response.json()).then(result => {
    capabilitySettled = true; return result;
  });
  await probeStarted;
  let diagnosticsSettled = false;
  const diagnostics = fixtureData.diagnostics().then(result => { diagnosticsSettled = true; return result; });
  let officeTargetsSettled = false;
  const officeTargets = targets(fixtureData.url, "doc").then(result => { officeTargetsSettled = true; return result; });
  const officeConversion = convert(fixtureData.url, "sample.doc", "pdf");
  const pdfTargets = targets(fixtureData.url, "pdf");
  try {
    const result = await beforeOfficeCompletes(pdfTargets);
    assert.ok(result.targets.includes("docx"));
    assert.equal(capabilitySettled, false, "all-engine capabilities still require the real Office probe");
    assert.equal(diagnosticsSettled, false, "diagnostic export must still await the real Office probe");
    assert.equal(officeTargetsSettled, false, "Office targets must not advertise an unverified engine");
    assert.equal(fixtureData.conversions(), 0, "Office conversion must not run before its probe completes");
    assert.equal(fixtureData.probes(), 1);
  } finally {
    release({ enabled: true, version: "verified-test" });
    await Promise.all([capabilities, diagnostics, officeTargets, officeConversion, pdfTargets]);
  }
  assert.equal((await capabilities).toolDetails.libreoffice.version, "verified-test");
  assert.equal((await diagnostics).libreoffice.version, "verified-test");
  assert.ok((await officeTargets).targets.includes("pdf"));
  assert.equal((await officeConversion).body.ok, true);
  assert.equal(fixtureData.conversions(), 1);
  await targets(fixtureData.url, "pdf");
  const ready = await (await fetch(`${fixtureData.url}/api/capabilities`)).json();
  assert.equal(ready.tools.libreoffice, true);
  assert.equal(ready.toolDetails.libreoffice.status, "ready");
  assert.equal(fixtureData.probes(), 1, "PDF requests must not reset or poison the shared Office probe cache");
});

test("pending Office capabilities stay responsive and become ready without stale probe results", async t => {
  const fixtureData = await fixture(t);
  const { url } = fixtureData;
  const first = await (await fetch(`${url}/api/capabilities`)).json();
  assert.equal(first.toolDetails.libreoffice.status, "pending");
  assert.equal(first.tools.libreoffice, false);
  assert.equal(first.tools.pdf, true);
  assert.equal(first.tools.pdfStructure, false);
  assert.equal(first.toolDetails.pdfStructure.errorCode, "PDF_STRUCTURE_MODEL_MISSING");
  assert.equal(fixtureData.probes(), 0, "read-only/unprepared Office must not be probed");
  assert.equal((await convert(url, "sample.txt", "md")).body.ok, true);
  let settled = false;
  const queued = convert(url, "sample.doc", "pdf").then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);
  assert.equal(fixtureData.conversions(), 0);
  assert.equal((await (await fetch(`${url}/api/capabilities`)).json()).toolDetails.libreoffice.status, "pending");
  await fixtureData.complete();
  assert.equal((await queued).body.ok, true);
  const ready = await (await fetch(`${url}/api/capabilities`)).json();
  assert.equal(ready.toolDetails.libreoffice.status, "ready");
  assert.equal(ready.tools.libreoffice, true);
  assert.equal(fixtureData.probes(), 1);
  assert.equal(fixtureData.conversions(), 1);
});

test("failed Office preparation returns an actionable bilingual error while text remains usable", async t => {
  const fixtureData = await fixture(t, { fail: true });
  await fixtureData.complete();
  const rejected = await convert(fixtureData.url, "sample.doc", "pdf");
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.errorCode, "OFFICE_ENGINE_PREPARATION_FAILED");
  assert.ok(rejected.body.messages.zhCN);
  assert.ok(rejected.body.messages.enUS);
  assert.match(rejected.body.details.reason, /disk full/);
  assert.equal(fixtureData.probes(), 0);
  assert.equal((await convert(fixtureData.url, "sample.txt", "md")).body.ok, true);
});
