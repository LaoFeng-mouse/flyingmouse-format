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

test("update entry is hidden by default and revealed only on update-available", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="updateButton"[^>]*hidden/);
  assert.match(app, /kind === "available" \|\| kind === "downloaded"/);
  assert.match(app, /updateButton\.hidden = false/);
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

test("renderer labels experimental inputs and the macOS AV3A boundary bilingually", () => {
  const app = readPublic("app.js");
  assert.match(app, /experimentalInputs/);
  assert.match(app, /Experimental\/unverified inputs/);
  assert.match(app, /实验性\/尚未完整验证的输入/);
  assert.match(app, /Standard NCM works on macOS; Audio Vivid AV3A currently requires Windows/);
  assert.match(app, /macOS 支持标准 NCM；Audio Vivid AV3A 目前仅支持 Windows/);
});

test("renderer surfaces a feedback email in the header and on failures", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /class="feedback-line"/);
  assert.match(html, /3465177342@qq\.com/);
  assert.match(app, /"feedback\.label": "问题反馈"/);
  assert.match(app, /"feedback\.label": "Feedback"/);
  assert.match(app, /"feedback\.hint": "如需帮助，请反馈至 3465177342@qq\.com"/);
  assert.match(app, /"feedback\.hint": "For help, please contact 3465177342@qq\.com"/);
  assert.match(app, /t\("feedback\.hint"\)/);
  assert.match(css, /\.feedback-line/);
});

test("QQ Music credential tutorial opens automatically on musicex cookie errors", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /id="qqTutorialModal"/);
  assert.match(html, /QQ音乐_登录cookie\.txt/);
  assert.match(app, /"tutorial\.qq\.title": "QQ 音乐登录教程"/);
  assert.match(app, /"tutorial\.qq\.title": "QQ Music Login Guide"/);
  assert.match(app, /QQ_COOKIE_ERROR_CODES/);
  assert.match(app, /MFLAC_EKEY_REQUIRED/);
  assert.match(app, /maybeShowQqTutorial\(error\)/);
  assert.match(app, /openQqTutorial\(\)/);
  assert.match(app, /closeQqTutorial\(\)/);
  assert.match(css, /\.tutorial-dialog/);
  assert.match(css, /\.tutorial-backdrop/);
});

test("QQ cookie tutorial offers a copyable credential template", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const css = readPublic("styles.css");
  assert.match(html, /id="qqCookieTemplate"/);
  assert.match(html, /uin=你的QQ号; qm_keyst=你复制的qm_keyst值/);
  assert.match(html, /id="qqCookieTemplateCopy"/);
  assert.match(app, /"tutorial\.copyTemplate": "复制模板"/);
  assert.match(app, /"tutorial\.copyTemplate": "Copy template"/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /qqCookieTemplateCopy\.addEventListener\("click", copyQqCookieTemplate\)/);
  assert.match(css, /\.template-card/);
  assert.match(css, /\.template-code/);
});

test("folder compression is exposed through the trusted bridge bilingually", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /id="compressFolderButton"/);
  assert.match(app, /"action\.compressFolder": "压缩文件夹"/);
  assert.match(app, /"action\.compressFolder": "Compress folder"/);
  assert.match(app, /"compressFolder\.saved": "已压缩 \{count\} 个文件到：\{path\}"/);
  assert.match(app, /"compressFolder\.saved": "Compressed \{count\} files to: \{path\}"/);
  assert.match(app, /logBridge\.compressFolder/);
  assert.match(app, /compressFolderButton\.addEventListener\("click"/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});
