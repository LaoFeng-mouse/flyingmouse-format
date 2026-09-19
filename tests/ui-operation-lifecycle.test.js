const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { File } = require("node:buffer");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function range(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function element(tag = "div") {
  return { tag, hidden: false, disabled: false, value: "", textContent: "", options: [], children: [], dataset: {}, listeners: {},
    classList: { add() {}, remove() {} }, focus() {}, setAttribute() {}, removeAttribute() {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(selector) { return this.options.find(option => selector === `option[value="${option.value}"]`) || null; },
    replaceChildren(...children) { this.children = children; this.options = children; this.value = children[0]?.value || ""; },
    append(...children) { this.children.push(...children); if (this.options !== this.children) this.options.push(...children); if (!this.value) this.value = children[0]?.value || ""; }
  };
}
function harness() {
  const state = { files: [], fileInfos: [], batchResults: [], converted: null, isConverting: false, selectionVersion: 0,
    capabilities: {}, settings: { targetBySource: {} }, folderName: "" };
  const requests = [], statuses = [];
  const context = vm.createContext({ state, requests, statuses, FormData, AbortController, setInterval, clearInterval,
    i18n: { language: "en-US" }, t: key => key, rendererLog() {},
    categoryLabel: value => value, isLongTaskTarget: () => false, mouseStateForConversion: () => "converting",
    setMouseState() {}, setWorkflowStep() {}, resetProgress() {}, setProgress() {}, setStageProgress() {}, updateProgressDetail() {},
    renderQqMusicConnection() {}, setIndeterminateProgress() {}, renderBatchList() {}, closePreview() {}, saveConvertedFile() {}, saveAllConvertedFiles() {},
    syncVideoCodecField() {}, syncPdfExcelHint() {}, persistSettings: async () => {}, rememberTarget: () => ({}),
    setStatus(message, type) { statuses.push({ message, type }); }, formatSize: String,
    extensionOf: name => name.split(".").at(-1), preferredTarget: () => null,
    setSelectPlaceholder(select, value) { select.replaceChildren(); select.value = value; },
    setBatchResult(index, patch) { state.batchResults[index] = { ...state.batchResults[index], ...patch }; },
    createTextElement: (tag, className, text) => Object.assign(element(tag), { className, textContent: text }),
    document: { createElement: element, activeElement: null, contains: () => false, body: element() },
    loadTargets: async file => ({ category: file.name.endsWith(".pdf") ? "pdf" : "image", targets: file.name.endsWith(".pdf") ? ["pdf"] : ["pdf", "png"] }),
    fetch: async (url, { body } = {}) => {
      requests.push({ url, body });
      return { ok: true, text: async () => JSON.stringify({ fileName: "output.pdf", downloadUrl: "/downloads/output" }) };
    }
  });
  for (const name of ["fileInput", "folderInput", "dropZone", "chooseFolderButton", "clearButton", "fileName", "fileMeta", "fileStrip",
    "batchList", "targetSelect", "convertButton", "downloadButton", "batchSaveButton", "previewButton", "videoCodec", "alphaBackground",
    "pdfPassword", "pdfAction", "pdfSplitMode", "pdfGroupSize", "imagePdfMode", "cancelConversionButton", "progressLabel",
    "pdfPasswordField", "pdfActionField", "pdfSplitModeField", "pdfGroupSizeField", "imagePdfModeField",
    "previewTitle", "previewMeta", "previewContent", "previewDrawer", "previewBackdrop", "previewClose"]) context[name] = element();
  context.pdfAction.options = ["merge", "", "encrypt", "decrypt"].map(value => Object.assign(element("option"), { value }));
  context.imagePdfMode.options = ["merge", "separate"].map(value => Object.assign(element("option"), { value }));
  context.imagePdfMode.value = "merge";
  context.previewDrawer.hidden = true;
  context.window = { FlyingMouseProgress: { createRequest: () => ({ send: (url, body) => context.fetch(url, { body }), close() {}, cancel: async () => {} }) } };
  vm.runInContext([
    range("function resetDownload()", "let capabilityRefreshTimer;"),
    range("function targetFormatLabel(", "function renderBatchList()"),
    range("function canReorderImages()", "function syncVideoCodecField()"),
    range("function syncImagePdfModeField()", "function syncPdfExcelHint()"),
    range("async function acceptFiles(", "async function saveResult("),
    range("function previewFallback(", "async function saveConvertedFile("),
    range("// 在队列 index 之后插入", 'clearButton.addEventListener("click"'),
    range('targetSelect.addEventListener("change"', 'previewButton.addEventListener("click"')
  ].join("\n"), context);
  return { context, state, requests, statuses,
    accept: names => context.acceptFiles(names.map(name => new File(["fixture"], name))),
    convert: () => context.convertCurrentFiles() };
}

test("multiple PDFs default explicitly to merging while a single PDF defaults to splitting", async () => {
  const app = harness();
  await app.accept(["a.pdf", "b.pdf"]);
  assert.equal(app.context.pdfAction.value, "merge");
  assert.equal(app.context.pdfSplitModeField.hidden, true);
  await app.convert();
  assert.deepEqual(app.requests.map(request => request.url), ["/api/merge-pdfs"]);
  await app.accept(["single.pdf"]);
  assert.equal(app.context.pdfAction.value, "");
  assert.equal(app.context.pdfAction.querySelector('option[value="merge"]').disabled, true);
  assert.equal(app.context.pdfSplitModeField.hidden, false);
});

for (const action of ["encrypt", "decrypt", ""]) {
  test(`multiple PDFs respect the selected ${action || "split"} operation for each file`, async () => {
    const app = harness();
    await app.accept(["a.pdf", "b.pdf"]);
    app.context.pdfAction.value = action;
    app.context.pdfPassword.value = "test-password";
    app.context.pdfSplitMode.value = "group";
    app.context.pdfGroupSize.value = "3";
    app.context.syncPdfActionFields();
    await app.convert();
    assert.deepEqual(app.requests.map(request => request.url), ["/api/convert", "/api/convert"]);
    assert.deepEqual(app.requests.map(request => request.body.get("file").name), ["a.pdf", "b.pdf"]);
    for (const { body } of app.requests) {
      assert.equal(body.get("pdfAction"), action);
      assert.equal(body.get("password"), "test-password");
      assert.equal(body.get("splitMode"), "group");
      assert.equal(body.get("groupSize"), "3");
    }
  });
}

test("inserting and removing a blank page updates mode choices, targets and queue count", async () => {
  const app = harness();
  await app.accept(["a.jpg", "b.jpg"]);
  app.context.insertBlankPage(0);
  assert.equal(app.context.imagePdfMode.querySelector('option[value="separate"]').disabled, true);
  assert.deepEqual(Array.from(app.context.targetSelect.options, option => option.value), ["pdf"]);
  assert.match(app.context.fileName.textContent, /3/);
  assert.match(app.statuses.at(-1).message, /2 images.*1 blank.*3.*PDF/);
  app.context.removeBlankPage(1);
  assert.equal(app.context.imagePdfMode.querySelector('option[value="separate"]').disabled, false);
  assert.deepEqual(Array.from(app.context.targetSelect.options, option => option.value), ["pdf", "png"]);
  assert.match(app.context.fileName.textContent, /2/);
  assert.match(app.statuses.at(-1).message, /Selected 2 images/);
});

test("changing image mode refreshes actions and cannot separate an inserted blank page", async () => {
  const app = harness();
  await app.accept(["a.jpg", "b.jpg"]);
  app.context.insertBlankPage(0);
  app.context.imagePdfMode.value = "separate";
  await app.context.imagePdfMode.listeners.change();
  assert.equal(app.context.imagePdfMode.value, "merge");
  await app.convert();
  assert.deepEqual(app.requests.map(request => request.url), ["/api/convert-images-to-pdf"]);
  assert.equal(app.requests[0].body.get("blanks"), "1");
  assert.deepEqual(app.requests[0].body.getAll("files").map(file => file.name), ["a.jpg", "b.jpg"]);
});

test("reordering a newly selected image queue keeps later blank-page actions working", async () => {
  const app = harness();
  await app.accept(["a.jpg", "b.jpg"]);
  app.context.moveFileInQueue(0, "down");
  app.context.moveFileInQueue(1, "up");
  app.context.insertBlankPage(0);
  assert.equal(app.state.files.length, 3);
  assert.equal(app.state.files[1].isBlankPage, true);
  assert.ok(app.state.batchResults.every(item => item.status === "pending"));
});

test("submit validates blank pages even if a mode control missed its change event", async () => {
  const app = harness();
  await app.accept(["a.jpg", "b.jpg"]);
  app.context.insertBlankPage(0);
  app.context.imagePdfMode.value = "separate";
  await app.convert();
  assert.deepEqual(app.requests.map(request => request.url), ["/api/convert-images-to-pdf"]);
  assert.equal(app.requests[0].body.get("blanks"), "1");
});

test("submit refuses a blank page queue with an incompatible target", async () => {
  const app = harness();
  await app.accept(["a.jpg", "b.jpg"]);
  app.context.insertBlankPage(0);
  app.context.targetSelect.value = "png";
  await app.convert();
  assert.equal(app.requests.length, 0);
  assert.equal(app.state.isConverting, false);
  assert.equal(app.statuses.at(-1).type, "error");
});

for (const oldFails of [false, true]) {
  test(`a stale text preview ${oldFails ? "failure" : "body"} cannot replace the current file`, async () => {
    const app = harness(), oldBody = deferred(), entered = deferred();
    let oldSignal;
    app.context.fetch = async (url, options) => {
      if (url === "/A") {
        oldSignal = options?.signal;
        return { ok: true, text: () => { entered.resolve(); return oldBody.promise; } };
      }
      return { ok: true, text: async () => "CONTENT-B" };
    };
    const pending = app.context.openPreview({ fileName: "A.txt", previewKind: "text", previewUrl: "/A" });
    await entered.promise;
    app.context.closePreview();
    await app.context.openPreview({ fileName: "B.txt", previewKind: "text", previewUrl: "/B" });
    if (oldFails) oldBody.reject(new Error("A failed")); else oldBody.resolve("CONTENT-A");
    await pending;
    assert.equal(app.context.previewTitle.textContent, "B.txt");
    assert.equal(app.context.previewContent.children[0].textContent, "CONTENT-B");
    assert.equal(oldSignal?.aborted, true);
  });
}

test("closing an in-flight preview prevents late content from repopulating the drawer", async () => {
  const app = harness(), response = deferred();
  app.context.fetch = () => response.promise;
  const pending = app.context.openPreview({ fileName: "A.txt", previewKind: "text", previewUrl: "/A" });
  app.context.closePreview();
  response.resolve({ ok: true, text: async () => "CONTENT-A" });
  await pending;
  assert.equal(app.context.previewDrawer.hidden, true);
  assert.equal(app.context.previewContent.children.length, 0);
  assert.equal(app.state.previewResult, null);
});
