const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Execute the production refresh function with controlled network responses and
// timers. This makes conversion/selection races reproducible without sleeping.
const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const refreshSource = appSource.slice(appSource.indexOf("let capabilityRefreshTimer;"), appSource.indexOf("function renderFormatTable()"));
const targetLabelSource = appSource.slice(appSource.indexOf("function targetFormatLabel("), appSource.indexOf("function commonTargetsFrom("));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ converting = false, loadTargets } = {}) {
  const files = [{ name: "notes.txt", size: 10 }];
  const result = { fileName: "notes.docx", downloadUrl: "/downloads/existing" };
  const batchResults = [{ status: "success", result }];
  const state = {
    capabilities: { toolDetails: { libreoffice: { status: "pending" } } },
    files, batchResults, converted: result, isConverting: converting,
    fileInfos: [{ category: "text", targets: ["md", "docx"] }]
  };
  let nextTimerId = 0;
  let targetQueries = 0;
  let engineState = "ready";
  const timers = new Map();
  const select = {
    value: "docx", disabled: false, options: [{ value: "md" }, { value: "docx" }],
    append(option) { this.options.push(option); },
    replaceChildren() { this.options = []; }
  };
  const context = vm.createContext({
    state, targetSelect: select, convertButton: { disabled: false },
    toolHealth: { classList: { add() {} } }, i18n: { language: "en-US" },
    console: { warn() {} }, document: { createElement: () => ({}) },
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
    fetch: async () => ({ ok: true, json: async () => ({ toolDetails: { libreoffice: { status: engineState } } }) }),
    renderFormatTable() {}, renderHealth() {}, syncPdfExcelHint() {},
    loadTargets: async file => { targetQueries++; return loadTargets ? loadTargets(file) : { category: "text", targets: ["md", "docx", "pdf"] }; },
    commonTargetsFrom: infos => infos[0].targets.filter(target => infos.every(info => info.targets.includes(target)))
  });
  assert.ok(refreshSource.includes("async function fetchCapabilities"));
  vm.runInContext(targetLabelSource + "\n" + refreshSource, context);
  return {
    state, select, files, result, batchResults, timers, context,
    refresh: () => context.fetchCapabilities(),
    get targetQueries() { return targetQueries; },
    setEngine(value) { engineState = value; },
    async runTimer() {
      assert.ok(timers.size, "refresh must remain scheduled until targets can be updated");
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
    }
  };
}

function assertPreserved(app) {
  assert.equal(app.state.files, app.files, "selected files were replaced");
  assert.equal(app.state.converted, app.result, "saved result was discarded");
  assert.equal(app.state.batchResults, app.batchResults, "batch history was reset");
  assert.equal(app.state.batchResults[0].result.downloadUrl, "/downloads/existing");
  assert.equal(app.select.value, "docx", "the user's target selection changed");
}

test("Office ready during conversion schedules a later target update without resetting files or results", async () => {
  const app = harness({ converting: true });
  app.setEngine("pending");
  await app.refresh();
  assert.equal(app.targetQueries, 0);
  app.setEngine("ready");
  await app.runTimer();
  assert.equal(app.targetQueries, 0);
  assertPreserved(app);
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx"]);
  app.state.isConverting = false;
  await app.runTimer();
  assert.equal(app.targetQueries, 1);
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx", "pdf"]);
  assertPreserved(app);
  assert.equal(app.context.convertButton.disabled, false);
  assert.equal(app.timers.size, 0);
});

test("idle readiness refresh adds targets once and preserves a completed download", async () => {
  const app = harness();
  await app.refresh();
  await app.refresh();
  assert.equal(app.targetQueries, 1);
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx", "pdf"]);
  assertPreserved(app);
});

test("an old target response cannot overwrite a newly selected file", async () => {
  const pending = deferred();
  const entered = deferred();
  const app = harness({ loadTargets: () => { entered.resolve(); return pending.promise; } });
  const refresh = app.refresh();
  await entered.promise;
  const newerFile = { name: "new.srt", size: 5 };
  const newerInfos = [{ category: "subtitle", targets: ["vtt", "ass", "txt"] }];
  app.state.files = [newerFile];
  app.state.fileInfos = newerInfos;
  app.select.value = "vtt";
  app.select.options = [{ value: "vtt" }, { value: "ass" }, { value: "txt" }];
  pending.resolve({ category: "text", targets: ["md", "docx", "pdf"] });
  await refresh;
  assert.equal(app.state.fileInfos, newerInfos);
  assert.equal(app.state.files[0], newerFile);
  assert.equal(app.select.value, "vtt");
  assert.deepEqual(app.select.options.map(option => option.value), ["vtt", "ass", "txt"]);
});

test("appending a blank PDF page while targets load rejects the shorter stale snapshot", async () => {
  const pending = deferred();
  const entered = deferred();
  const app = harness({ loadTargets: () => { entered.resolve(); return pending.promise; } });
  const refresh = app.refresh();
  await entered.promise;
  const blank = { isBlankPage: true, name: "Blank page", size: 0 };
  app.state.files.push(blank);
  const infos = [{ category: "image", targets: ["pdf", "md"] }, { category: "image", targets: ["pdf"] }];
  app.state.fileInfos = infos;
  pending.resolve({ category: "image", targets: ["pdf", "md", "docx"] });
  await refresh;
  assert.equal(app.state.fileInfos, infos);
  assert.equal(app.state.files.length, 2);
  assert.equal(app.state.files[1], blank);
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx"]);
});

test("conversion beginning during a readiness target request still refreshes automatically after it finishes", async () => {
  const pending = deferred();
  const entered = deferred();
  let first = true;
  const app = harness({ loadTargets: () => {
    if (first) { first = false; entered.resolve(); return pending.promise; }
    return { category: "text", targets: ["md", "docx", "pdf"] };
  } });
  const refresh = app.refresh();
  await entered.promise;
  app.state.isConverting = true;
  pending.resolve({ category: "text", targets: ["md", "docx", "pdf"] });
  await refresh;
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx"]);
  assertPreserved(app);
  app.state.isConverting = false;
  await app.runTimer();
  assert.deepEqual(app.select.options.map(option => option.value), ["md", "docx", "pdf"]);
  assertPreserved(app);
});
