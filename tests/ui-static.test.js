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

test("renderer restores the original mouse mascot and keeps the sponsor widget", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /mouse-mascot|mouseMascot/);
  assert.match(html, /sponsorWidget|sponsorToggle/);
  assert.match(html, /sponsor-qr\.jpg/);
  assert.match(app, /setMouseState|mouseAssets|mouseMascot/);
  assert.match(app, /sponsorToggle/);
  assert.doesNotMatch(html, /3465177342@qq\.com/);
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

test("renderer restores and updates target preferences through durable Electron settings", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /conversion-preferences\.js/);
  assert.match(app, /migrateLegacySettings/);
  assert.match(app, /preferredTarget\(state\.settings\.targetBySource/);
  assert.match(app, /logBridge\.updateSettings\(\{\s*targetBySource\s*\}/s);
  assert.doesNotMatch(app, /preferredTarget\(localStorage/);
  assert.doesNotMatch(app, /rememberTarget\(localStorage/);
});

test("renderer exposes a bilingual diagnostics export through the trusted bridge", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="diagnosticsButton"/);
  assert.match(app, /"diagnostics\.export": "导出诊断"/);
  assert.match(app, /"diagnostics\.export": "Export diagnostics"/);
  assert.match(app, /logBridge\.exportDiagnostics/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(app, /result\?\.errorCode/);
  assert.match(app, /error\.errorCode/);
});

test("renderer exposes Agent skill installation immediately before diagnostics", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="agentInstallButton"/);
  assert.ok(html.indexOf('id="agentInstallButton"') < html.indexOf('id="diagnosticsButton"'));
  assert.match(app, /"agent\.install": "接入 Agent"/);
  assert.match(app, /"agent\.install": "Connect to Agent"/);
  assert.match(app, /logBridge\.inspectAgentSkillTargets/);
  assert.match(app, /logBridge\.installAgentSkill/);
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

test("video targets expose a codec selector (h264/h265/av1) for mp4/mov/mkv", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="videoCodecField"[^>]*hidden/);
  assert.match(html, /id="videoCodec"/);
  assert.match(app, /"videoCodec\.h264"/);
  assert.match(app, /"videoCodec\.h265"/);
  assert.match(app, /"videoCodec\.av1"/);
  assert.match(app, /\["mp4", "mov", "mkv"\]\.includes\(targetSelect\.value\)/);
  assert.match(app, /\["mp4", "mov", "mkv"\]\.includes\(targetFormat\)/);
  assert.match(app, /form\.append\("videoCodec"/);
});

test("video targets expose a transparent background color selector", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="alphaBackgroundField"[^>]*hidden/);
  assert.match(html, /id="alphaBackground"/);
  assert.match(app, /"alphaBackground\.label"/);
  assert.match(app, /"alphaBackground\.white"/);
  assert.match(app, /"alphaBackground\.black"/);
  assert.match(app, /alphaBackgroundField\.hidden/);
  assert.match(app, /form\.append\("alphaBackground"/);
});

test("multiple images to PDF expose a merge/separate mode selector", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="imagePdfModeField"[^>]*hidden/);
  assert.match(html, /id="imagePdfMode"/);
  assert.match(app, /"imagePdfMode\.label"/);
  assert.match(app, /"imagePdfMode\.merge"/);
  assert.match(app, /"imagePdfMode\.separate"/);
  assert.match(app, /imagePdfModeField\.hidden/);
  assert.match(app, /imagePdfMode\?\.value === "separate"/);
});

test("image targets include BMP output (imageFormatTargets)", () => {
  const { imageFormatTargets } = require("../config");
  assert.ok(imageFormatTargets.includes("bmp"), "bmp should be an image output target");
  // 顺序无关，但 bmp 必须与 png/jpg 等并列出现
  const targets = new Set(imageFormatTargets);
  for (const expected of ["png", "jpg", "webp", "gif", "avif", "tiff", "ico", "bmp", "pdf"]) {
    assert.ok(targets.has(expected), `${expected} missing from imageFormatTargets`);
  }
});

test("renderer no longer enforces a batch size limit and localizes resource errors", () => {
  const app = readPublic("app.js");
  assert.match(app, /maxBatchBytes/);
  assert.match(app, /maxBatchBytes \|\| Number\.MAX_SAFE_INTEGER/);
  assert.match(app, /result\?\.messages\?\.enUS/);
  assert.match(app, /result\?\.messages\?\.zhCN/);
});

test("renderer shows localized conversion warnings without HTML injection", () => {
  const app = readPublic("app.js");
  assert.match(app, /result\?\.warnings/);
  assert.match(app, /warning\?\.messages\?\.enUS/);
  assert.match(app, /warning\?\.messages\?\.zhCN/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test("renderer labels experimental inputs bilingually", () => {
  const app = readPublic("app.js");
  assert.match(app, /experimentalInputs/);
  assert.match(app, /Experimental\/unverified inputs/);
  assert.match(app, /实验性\/尚未完整验证的输入/);
  assert.doesNotMatch(app, /NCM|MFLAC|Audio Vivid/);
});

test("renderer surfaces a feedback hint without personal contact details", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /class="feedback-line"/);
  assert.doesNotMatch(html, /3465177342@qq\.com/);
  assert.match(app, /"feedback\.label": "问题反馈"/);
  assert.match(app, /"feedback\.label": "Feedback"/);
  assert.match(app, /"feedback\.hint": "如需帮助，请导出诊断报告/);
  assert.match(app, /"feedback\.hint": "For help, export the diagnostics report/);
  assert.match(app, /t\("feedback\.hint"\)/);
  assert.match(css, /\.feedback-line/);
});





test("PDF split mode exposes page/group options and a group-size field bilingually", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="pdfSplitModeField"[^>]*hidden/);
  assert.match(html, /id="pdfSplitMode"/);
  assert.match(html, /id="pdfGroupSizeField"[^>]*hidden/);
  assert.match(html, /id="pdfGroupSize"/);
  assert.match(app, /"pdfSplitMode\.label": "拆分方式"/);
  assert.match(app, /"pdfSplitMode\.label": "Split mode"/);
  assert.match(app, /"pdfSplitMode\.page": "逐页拆分（每页一个 PDF）"/);
  assert.match(app, /"pdfSplitMode\.page": "Split into single pages"/);
  assert.match(app, /"pdfSplitMode\.group": "每 N 页一组"/);
  assert.match(app, /"pdfSplitMode\.group": "Group every N pages"/);
  assert.match(app, /"pdfGroupSize\.label": "每几页一组"/);
  assert.match(app, /"pdfGroupSize\.label": "Pages per group"/);
  assert.match(app, /form\.append\("splitMode"/);
  assert.match(app, /form\.append\("groupSize"/);
  assert.match(app, /pdfSplitMode\.addEventListener\("change", syncPdfActionFields\)/);
});

test("folder compression is removed from the UI (2026-09-04 feature removal)", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.doesNotMatch(html, /compressFolderButton/);
  assert.doesNotMatch(html, /zipCompressionField/);
  assert.doesNotMatch(app, /compressFolder/);
  assert.doesNotMatch(app, /zipCompression/);
  assert.doesNotMatch(app, /"zip\./);
  assert.doesNotMatch(css, /compress-folder-button/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test("folder-to-PDF entry is exposed bilingually with webkitdirectory input", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /id="folderInput"[^>]*webkitdirectory/);
  assert.match(html, /id="chooseFolderButton"/);
  assert.match(app, /"upload\.chooseFolder": "选择文件夹转 PDF"/);
  assert.match(app, /"upload\.chooseFolder": "Choose folder → PDF"/);
  assert.match(app, /chooseFolderButton\.addEventListener\("click", \(\) => folderInput\.click\(\)\)/);
  assert.match(app, /folderInput\.addEventListener\("change"/);
  assert.match(app, /state\.folderName/);
  assert.match(app, /webkitRelativePath/);
  assert.match(app, /collectEntryFiles/);
  assert.match(css, /\.drop-folder-line/);
});

test("blank page insertion is exposed in the image merge queue", () => {
  const app = readPublic("app.js");
  assert.match(app, /insertBlankPage\(index\)/);
  assert.match(app, /removeBlankPage\(index\)/);
  assert.match(app, /isBlankPage/);
  assert.match(app, /data-insert-blank/);
  assert.match(app, /data-remove-blank/);
  assert.match(app, /form\.append\("blanks"/);
  assert.match(app, /Blank page/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test("non-commercial notice is present in UI and styles without author attribution", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /class="author-line"/);
  assert.doesNotMatch(html, /牢蜂|LaoFeng/);
  assert.match(html, /仅支持普通音乐格式转换，不支持其他音乐平台的加密特殊格式/);
  assert.match(html, /禁止商业售卖/);
  assert.match(css, /\.author-line/);
  // 渲染器不重新引入 innerHTML
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});
