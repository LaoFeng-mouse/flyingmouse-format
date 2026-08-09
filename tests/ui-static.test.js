const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const publicRoot = path.join(__dirname, "..", "public");

function readPublic(fileName) {
  return fs.readFileSync(path.join(publicRoot, fileName), "utf8");
}

test("renderer exposes workflow hooks and drop zone copy", () => {
  const html = readPublic("index.html");
  assert.match(html, /id="workflowSteps"/);
  for (const step of ["select", "analyze", "convert", "save"]) {
    assert.match(html, new RegExp(`data-step="${step}"`), `${step} workflow step is missing`);
  }
  assert.match(html, /id="dropZone"/);
  assert.match(html, /把文件丢给鼠鼠|Drop files here/);
  assert.match(html, /id="dropHint"/);
});

test("renderer restores the original mouse mascot and sponsor widget", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /mouse-mascot|mouseMascot/);
  assert.match(html, /sponsorWidget/);
  assert.match(app, /setMouseState|mouseAssets|mouseMascot/);
});

test("renderer uses the mouse brand and favicon", () => {
  const html = readPublic("index.html");
  assert.match(html, /class="brand-mouse"/);
  assert.match(html, /rel="icon"/);
  assert.match(html, /href="\/assets\/mouse-format\/mouse-idle\.png"/);
});

test("original mouse visual theme classes are present", () => {
  const css = readPublic("styles.css");
  assert.match(css, /--accent:\s*#e95f6d/);
  assert.match(css, /\.workflow-steps/);
  assert.match(css, /\.mouse-stage/);
  assert.match(css, /\.mouse-mascot/);
  assert.match(css, /\.sponsor-widget/);
  assert.match(css, /border-radius:\s*var\(--radius\)/);
});

test("renderer exposes a bilingual language selector", () => {
  const html = readPublic("index.html");
  assert.match(html, /id="languageSelect"/);
  assert.match(html, /value="zh-CN"/);
  assert.match(html, /value="en-US"/);
  assert.ok(html.indexOf("/i18n.js") < html.indexOf("/app.js"));
});

test("renderer does not inject dynamic HTML", () => {
  const app = readPublic("app.js");
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(app, /\.textContent\s*=/);
});

test("renderer restores and updates target preferences by source extension", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /conversion-preferences\.js/);
  assert.match(app, /preferredTarget\(localStorage/);
  assert.match(app, /rememberTarget\(localStorage/);
});

test("PDF to XLSX uses a contextual bilingual smart-table label and warning", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="pdfExcelHint"[^>]*hidden/);
  assert.match(app, /Excel（智能表格提取）/);
  assert.match(app, /Excel \(smart table extraction\)/);
  assert.match(app, /适合电子版规则表格；扫描件、复杂表头和合并单元格可能不完整/);
  assert.match(app, /Best for digital PDFs with regular tables/);
  assert.match(app, /targetSelect\.value === "xlsx"[\s\S]*info\.category === "pdf"/);
});

test("renderer enforces the advertised 2 GB batch limit and localizes resource errors", () => {
  const app = readPublic("app.js");
  assert.match(app, /maxBatchBytes/);
  assert.match(app, /2 \* 1024 \* 1024 \* 1024/);
  assert.match(app, /result\?\.messages\?\.enUS/);
  assert.match(app, /result\?\.messages\?\.zhCN/);
});
