const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const resetSource = source.slice(source.indexOf("function resetDownload()"), source.indexOf("let capabilityRefreshTimer;"));
const targetLabelSource = source.slice(source.indexOf("function targetFormatLabel("), source.indexOf("function commonTargetsFrom("));
const conversionSource = source.slice(source.indexOf("async function acceptFiles("), source.indexOf("async function saveResult("));
const selectionEvents = source.slice(source.indexOf('dropZone.addEventListener("click"'), source.indexOf('batchList.addEventListener("click"'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness({ targets, convert } = {}) {
  const state = { files: [], fileInfos: [], batchResults: [], converted: null, isConverting: false, selectionVersion: 0,
    capabilities: {}, settings: { targetBySource: {} }, folderName: "" };
  const statuses = [], convertedNames = [], forms = [];
  const element = () => ({ hidden: false, disabled: false, value: "", textContent: "", options: [],
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, click() { this.clickCount = (this.clickCount || 0) + 1; },
    removeAttribute() {}, replaceChildren() { this.options = []; this.value = ""; },
    append(option) { this.options.push(option); if (!this.value) this.value = option.value; },
    setAttribute() {}, classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    state, i18n: { language: "en-US" }, t: key => key, statuses,
    setStatus(message, type) { statuses.push({ message, type }); },
    loadTargets: file => targets ? targets(file) : Promise.resolve({ category: "text", targets: ["md"] }),
    commonTargetsFrom: infos => infos[0]?.targets.filter(target => infos.every(info => info.targets.includes(target))) || [],
    summarizeFiles: files => ({ name: files.map(file => file.name).join(", "), meta: "" }),
    extensionOf: name => name.split(".").at(-1), preferredTarget: () => null,
    categoryLabel: value => value, isLongTaskTarget: () => false,
    mouseStateForConversion: () => "converting", rendererLog() {},
    setMouseState() {}, setWorkflowStep() {}, resetProgress() {}, setProgress() {},
    setIndeterminateProgress() {}, closePreview() {}, renderBatchList() {},
    syncVideoCodecField() {}, syncPdfActionFields() {}, syncImagePdfModeField() {}, syncPdfExcelHint() {},
    setBatchResult(index, patch) { state.batchResults[index] = { ...state.batchResults[index], ...patch }; },
    setSelectPlaceholder(select, value) { select.replaceChildren(); select.value = value; },
    document: { createElement: () => element() },
    FormData: class { constructor() { this.fields = new Map(); } append(key, value) { this.fields.set(key, value); } },
    fetch: async (_url, { body }) => {
      const file = body.fields.get("file");
      forms.push(body.fields);
      convertedNames.push(file.name);
      const result = convert ? await convert(file) : { fileName: `${file.name}.md`, downloadUrl: `/downloads/${file.name}` };
      return { ok: true, text: async () => JSON.stringify(result) };
    }
  });
  for (const name of ["fileInput", "folderInput", "dropZone", "chooseFolderButton", "clearButton", "fileName", "fileMeta", "fileStrip",
    "batchList", "targetSelect", "convertButton", "downloadButton", "batchSaveButton", "previewButton", "videoCodec", "alphaBackground",
    "pdfPassword", "pdfAction", "pdfSplitMode", "pdfGroupSize", "imagePdfMode"]) context[name] = element();
  context.targetSelect.disabled = true;
  context.convertButton.disabled = true;
  vm.runInContext(`${targetLabelSource}\n${resetSource}\n${conversionSource}\n${selectionEvents}`, context);
  return { context, state, statuses, convertedNames, forms, accept: files => context.acceptFiles(files),
    clear: () => context.clearFile(), convert: () => context.convertCurrentFiles() };
}

test("a cleared selection stays cleared when its delayed target request finishes", async () => {
  const pending = deferred();
  const app = harness({ targets: () => pending.promise });
  const selection = app.accept([{ name: "old.txt", size: 1 }]);
  app.clear();
  pending.resolve({ category: "text", targets: ["md"] });
  await selection;
  assert.equal(app.state.files.length, 0);
  assert.equal(app.state.fileInfos.length, 0);
  assert.equal(app.context.convertButton.disabled, true);
  assert.equal(app.context.targetSelect.value, "");
});

test("a slower old selection cannot replace the current file's formats or error status", async () => {
  for (const oldFails of [false, true]) {
    const pending = deferred();
    const app = harness({ targets: file => file.name === "old.txt" ? pending.promise : Promise.resolve({ category: "subtitle", targets: ["vtt"] }) });
    const oldSelection = app.accept([{ name: "old.txt", size: 1 }]);
    await app.accept([{ name: "new.srt", size: 1 }]);
    const currentStatus = app.statuses.at(-1);
    if (oldFails) pending.reject(new Error("old request failed"));
    else pending.resolve({ category: "text", targets: ["md"] });
    await oldSelection;
    assert.equal(app.state.files[0].name, "new.srt");
    assert.equal(app.state.fileInfos[0].category, "subtitle");
    assert.equal(app.context.targetSelect.value, "vtt");
    assert.equal(app.statuses.at(-1), currentStatus);
  }
});

test("clear and replacement selection cannot mix an in-flight batch with another queue", async () => {
  const pending = deferred();
  const entered = deferred();
  const app = harness({ convert: async file => {
    if (file.name === "one.txt") { entered.resolve(); await pending.promise; }
    return { fileName: `${file.name}.md`, downloadUrl: `/downloads/${file.name}` };
  } });
  await app.accept([{ name: "one.txt", size: 1 }, { name: "two.txt", size: 1 }]);
  const running = app.convert();
  await entered.promise;
  app.clear();
  await app.accept([{ name: "replacement.txt", size: 1 }]);
  await app.convert(); // repeated activation must not launch a second batch
  assert.equal(app.state.isConverting, true);
  assert.deepEqual(Array.from(app.state.files, file => file.name), ["one.txt", "two.txt"]);
  pending.resolve();
  await running;
  assert.deepEqual(app.convertedNames, ["one.txt", "two.txt"]);
  assert.deepEqual(Array.from(app.state.batchResults, item => item.result.fileName), ["one.txt.md", "two.txt.md"]);
  assert.equal(app.state.isConverting, false);
});

test("conversion freezes selection and format controls until the batch settles", async () => {
  const pending = deferred();
  const app = harness({ convert: () => pending.promise });
  await app.accept([{ name: "one.txt", size: 1 }]);
  const running = app.convert();
  const controls = ["fileInput", "folderInput", "dropZone", "chooseFolderButton", "clearButton", "videoCodec", "alphaBackground",
    "pdfPassword", "pdfAction", "pdfSplitMode", "pdfGroupSize", "imagePdfMode"];
  for (const control of controls) assert.equal(app.context[control].disabled, true, control);
  pending.resolve({ fileName: "one.md", downloadUrl: "/downloads/one" });
  await running;
  for (const control of controls) assert.equal(app.context[control].disabled, false, control);
});

test("keyboard, synthetic hidden input changes and drop handlers cannot replace a converting queue", async () => {
  const pending = deferred();
  const app = harness({ convert: () => pending.promise });
  await app.accept([{ name: "one.txt", size: 1 }]);
  const running = app.convert();
  app.context.dropZone.listeners.click();
  app.context.chooseFolderButton.listeners.click();
  assert.equal(app.context.fileInput.clickCount || 0, 0);
  assert.equal(app.context.folderInput.clickCount || 0, 0);
  app.context.fileInput.files = app.context.folderInput.files = [{ name: "other.txt", size: 1 }];
  app.context.fileInput.listeners.change();
  app.context.folderInput.listeners.change();
  await app.context.dropZone.listeners.drop({ preventDefault() {}, dataTransfer: { files: [{ name: "dropped.txt", size: 1 }] } });
  assert.equal(app.state.files[0].name, "one.txt");
  pending.resolve({ fileName: "one.md", downloadUrl: "/downloads/one" });
  await running;
});

test("a slow dropped-folder scan cannot discard results from a conversion started afterwards", async () => {
  const app = harness();
  await app.accept([{ name: "one.txt", size: 1 }]);
  let completeFile;
  let reads = 0;
  const entry = { isDirectory: true, name: "old-folder", createReader: () => ({ readEntries(callback) {
    callback(reads++ ? [] : [{ isFile: true, file(done) { completeFile = done; } }]);
  } }) };
  const dropping = app.context.dropZone.listeners.drop({ preventDefault() {}, dataTransfer: { items: [{ webkitGetAsEntry: () => entry }] } });
  await app.convert();
  const converted = app.state.converted;
  completeFile({ name: "late-file.txt", size: 1 });
  await dropping;
  assert.equal(app.state.files[0].name, "one.txt");
  assert.equal(app.state.converted, converted);
});

test("each queued conversion uses the files and codec captured when the batch started", async () => {
  const pending = deferred();
  const entered = deferred();
  const app = harness({ targets: () => Promise.resolve({ category: "video", targets: ["mp4"] }), convert: async file => {
    if (file.name === "one.mov") { entered.resolve(); await pending.promise; }
    return { fileName: `${file.name}.mp4`, downloadUrl: `/downloads/${file.name}` };
  } });
  await app.accept([{ name: "one.mov", size: 1 }, { name: "two.mov", size: 1 }]);
  app.context.videoCodec.value = "h264";
  const running = app.convert();
  await entered.promise;
  // Direct mutation models a missed entry point: the running loop must still
  // use its snapshot rather than send a newly inserted file or changed codec.
  app.state.files.push({ name: "unexpected.mov", size: 1 });
  app.context.videoCodec.value = "av1";
  pending.resolve();
  await running;
  assert.deepEqual(app.convertedNames, ["one.mov", "two.mov"]);
  assert.deepEqual(app.forms.map(form => form.get("videoCodec")), ["h264", "h264"]);
});

test("the latest dropped folder wins even when an earlier folder finishes scanning first", async () => {
  const app = harness();
  function drop(name) {
    let completeFile, reads = 0;
    const entry = { isDirectory: true, name, createReader: () => ({ readEntries(done) {
      done(reads++ ? [] : [{ isFile: true, file(resolve) { completeFile = resolve; } }]);
    } }) };
    const done = app.context.dropZone.listeners.drop({ preventDefault() {}, dataTransfer: { files: [], items: [{ webkitGetAsEntry: () => entry }] } });
    return { done, finish: () => completeFile({ name: `${name}.txt`, size: 1 }) };
  }
  const old = drop("old-folder"), latest = drop("latest-folder");
  await new Promise(resolve => setImmediate(resolve));
  old.finish();
  await old.done;
  assert.equal(app.state.files.length, 0, "older scan must not commit after a newer drop has begun");
  latest.finish();
  await latest.done;
  assert.equal(app.state.files[0].name, "latest-folder.txt");
  assert.equal(app.state.folderName, "latest-folder");
});
