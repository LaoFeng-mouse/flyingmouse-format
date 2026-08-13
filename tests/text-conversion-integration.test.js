const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const runtimeDir = path.join(os.tmpdir(), `flyingmouse-text-integration-${process.pid}`);
process.env.FLYINGMOUSE_RUNTIME_DIR = runtimeDir;
// csv->pdf 走 LibreOffice html->pdf 管线；本机已安装版引擎存在时启用，否则跳过该断言。
// 注意必须用 soffice.com（命令行壳）：portable 版 soffice.exe 会拉起 GUI 挂起，probe 超时。
const candidateLo = "C:\\Users\\34615\\AppData\\Local\\Programs\\FlyingMouse Format\\resources\\libreoffice\\LibreOfficePortable\\App\\libreoffice\\program\\soffice.com";
const LO_AVAILABLE = require("node:fs").existsSync(candidateLo);
if (LO_AVAILABLE) process.env.FLYINGMOUSE_LIBREOFFICE_PATH = candidateLo;
const { startServer, platformCapabilities } = require("../server");
const { DCRAW_PATH, rawInput } = require("../config");

let server;
let baseUrl;

before(async () => {
  const started = await startServer(0);
  server = started.server;
  baseUrl = started.url;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function convert(name, content, targetFormat, type) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  return download.text();
}

async function convertResponse(name, content, targetFormat, type) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  return { response, body: await response.json() };
}

test("server preserves HTML headings and lists when converting to Markdown", async () => {
  const markdown = await convert(
    "page.html",
    "<h1>Hello</h1><ul><li>Mouse</li><li>Format</li></ul>",
    "md",
    "text/html"
  );
  assert.match(markdown, /^# Hello/m);
  assert.match(markdown, /^\*\s+Mouse/m);
});

test("server preserves legal quoted newlines when converting CSV to JSON", async () => {
  const json = await convert(
    "table.csv",
    '"name","description"\r\n"鼠鼠","第一行\r\n第二行"\r\n',
    "json",
    "text/csv"
  );
  assert.deepEqual(JSON.parse(json), [{ name: "鼠鼠", description: "第一行\r\n第二行" }]);
});

test("server reports invalid CSV as a stable client error", async () => {
  const { response, body } = await convertResponse(
    "duplicate.csv",
    "name,name\nfirst,second\n",
    "json",
    "text/csv"
  );
  assert.equal(response.status, 422);
  assert.equal(body.errorCode, "CSV_PARSE_FAILED");
  assert.match(body.error, /CSV/);
});

test("server flags txt to JSON as a raw-text wrapper warning instead of pretending to parse", async () => {
  const { response, body } = await convertResponse(
    "note.txt",
    "just some plain text\nno structure here",
    "json",
    "text/plain"
  );
  assert.equal(response.status, 200, body.error);
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const payload = JSON.parse(await download.text());
  assert.equal(payload.text, "just some plain text\nno structure here");
  assert.ok(Array.isArray(body.warnings), "expected warnings array");
  assert.ok(body.warnings.some((warning) => warning.code === "TEXT_JSON_WRAPPED"));
});

test("server converts CSV to JSON without the wrapper warning (real parse)", async () => {
  const { response, body } = await convertResponse(
    "data.csv",
    "name,age\nAlice,30\n",
    "json",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.ok(!Array.isArray(body.warnings) || !body.warnings.some((warning) => warning.code === "TEXT_JSON_WRAPPED"));
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  const payload = JSON.parse(await download.text());
  assert.deepEqual(payload, [{ name: "Alice", age: "30" }]);
});

test("server converts CSV to a real EPUB (not a LO fake success)", async () => {
  const { response, body } = await convertResponse(
    "rows.csv",
    "name,age\nAlice,30\nBob,25\n",
    "epub",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.equal(body.fileName, "rows.epub");
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const buffer = Buffer.from(await download.arrayBuffer());
  // EPUB 规范：第一个条目是明文 mimetype
  assert.match(buffer.toString("latin1", 0, 1024), /application\/epub\+zip/);
});

test("server converts CSV to XLSX with real cells (not a LO fake success)", async () => {
  const { response, body } = await convertResponse(
    "rows.csv",
    "name,age\nAlice,30\nBob,25\n",
    "xlsx",
    "text/csv"
  );
  assert.equal(response.status, 200, body.error);
  assert.equal(body.fileName, "rows.xlsx");
  const download = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(download.status, 200);
  const buffer = Buffer.from(await download.arrayBuffer());
  assert.equal(buffer.toString("latin1", 0, 2), "PK", "xlsx must be a zip archive");
  const { Workbook } = require("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Sheet1");
  assert.equal(sheet.getCell("A1").value, "name");
  assert.equal(sheet.getCell("B2").value, "30");
  assert.equal(sheet.getCell("A3").value, "Bob");
});

test("server converts CSV to PDF and HTML with a real table", { skip: !LO_AVAILABLE }, async () => {
  const pdf = await convertResponse("rows.csv", "name,age\nAlice,30\n", "pdf", "text/csv");
  assert.equal(pdf.response.status, 200, pdf.body.error);
  assert.equal(pdf.body.fileName, "rows.pdf");
  const pdfDownload = await fetch(`${baseUrl}${pdf.body.downloadUrl}`);
  const pdfBuffer = Buffer.from(await pdfDownload.arrayBuffer());
  assert.equal(pdfBuffer.toString("latin1", 0, 4), "%PDF", "csv->pdf must produce a real PDF");

  const html = await convertResponse("rows.csv", "name,age\nAlice,30\n", "html", "text/csv");
  assert.equal(html.response.status, 200, html.body.error);
  assert.equal(html.body.fileName, "rows.html");
  const htmlDownload = await fetch(`${baseUrl}${html.body.downloadUrl}`);
  const htmlText = await htmlDownload.text();
  assert.match(htmlText, /<table>/);
  assert.match(htmlText, /Alice/);
});

test("server converts TSV through the same real pipelines as CSV", async () => {
  const json = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "json", "text/tab-separated-values");
  assert.equal(json.response.status, 200, json.body.error);
  const jsonDownload = await fetch(`${baseUrl}${json.body.downloadUrl}`);
  assert.deepEqual(JSON.parse(await jsonDownload.text()), [{ name: "Alice", age: "30" }]);

  const md = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "md", "text/tab-separated-values");
  assert.equal(md.response.status, 200, md.body.error);
  const mdDownload = await fetch(`${baseUrl}${md.body.downloadUrl}`);
  assert.match(await mdDownload.text(), /\| name \| age \|/);

  const xlsx = await convertResponse("data.tsv", "name\tage\nAlice\t30\n", "xlsx", "text/tab-separated-values");
  assert.equal(xlsx.response.status, 200, xlsx.body.error);
  const xlsxDownload = await fetch(`${baseUrl}${xlsx.body.downloadUrl}`);
  const xlsxBuffer = Buffer.from(await xlsxDownload.arrayBuffer());
  assert.equal(xlsxBuffer.toString("latin1", 0, 2), "PK", "tsv->xlsx must be a zip archive");
});

test("capabilities expose stable conversion limits and Sharp keeps pixel protection enabled", async () => {
  const response = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.deepEqual(capabilities.limits, {
    maxImagePixels: Number.MAX_SAFE_INTEGER,
    maxImageDimension: Number.MAX_SAFE_INTEGER,
    maxImagePdfPixels: Number.MAX_SAFE_INTEGER,
    maxBatchBytes: Number.MAX_SAFE_INTEGER
  });
  assert.deepEqual(capabilities.groups.image.experimentalInputs, ["heic", "heif", "ico", "tga"].concat(DCRAW_PATH ? [...rawInput] : []).sort());
  assert.deepEqual(capabilities.groups.document.experimentalInputs, ["wpd", "wps", "wpt"]);
  assert.deepEqual(capabilities.groups.spreadsheet.experimentalInputs, ["et", "ett"]);
  assert.deepEqual(capabilities.groups.presentation.experimentalInputs, ["dps", "dpt"]);
  assert.deepEqual(capabilities.groups.audio.experimentalInputs, ["kgg", "mflac"]);
  assert.equal(capabilities.platform.standardNcm, true);
  assert.equal(capabilities.platform.av3a, process.platform === "win32");
  const serverSource = require("node:fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const imageSource = require("node:fs").readFileSync(path.join(__dirname, "..", "image.js"), "utf8");
  const pdfTableSource = require("node:fs").readFileSync(path.join(__dirname, "..", "pdf-table.js"), "utf8");
  assert.doesNotMatch(serverSource, /limitInputPixels\s*:\s*false/);
  assert.match(imageSource, /assertImagePdfBudget\(metadataList\)/);
  assert.match(pdfTableSource, /assertPdfPages\(pdf\.numPages\)/);
  assert.match(pdfTableSource, /"-cropbox"/);
  assert.match(pdfTableSource, /async function\* pages\(\)/);
});

test("platform capabilities keep standard NCM cross-platform and AV3A Windows-only", () => {
  assert.deepEqual(platformCapabilities("darwin", "arm64"), {
    os: "darwin", arch: "arm64", standardNcm: true, av3a: false
  });
  assert.deepEqual(platformCapabilities("win32", "x64"), {
    os: "win32", arch: "x64", standardNcm: true, av3a: true
  });
});

test("packaging and Win7 staging include the new runtime modules", () => {
  const packageJson = require("../package.json");
  const source = require("node:fs").readFileSync(path.join(__dirname, "..", "win7-build-profile.js"), "utf8");
  for (const file of ["resource-policy.js", "text-conversion.js", "pdf-table-extractor.js", "pdf-table-runtime.js", "config.js", "utils.js", "media.js", "zip-util.js", "image.js", "ocr.js", "pdfjs.js", "pdf-table.js", "pdf.js", "text-docx.js", "office-convert.js"]) {
    assert.ok(packageJson.build.files.includes(file), `${file} is missing from build.files`);
    assert.match(source, new RegExp(`["]${file.replace(".", "\\.")}["]`));
  }
});
