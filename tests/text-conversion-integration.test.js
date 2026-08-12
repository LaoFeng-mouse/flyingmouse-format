const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const runtimeDir = path.join(os.tmpdir(), `flyingmouse-text-integration-${process.pid}`);
process.env.FLYINGMOUSE_RUNTIME_DIR = runtimeDir;
const { startServer, platformCapabilities } = require("../server");

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

test("capabilities expose stable conversion limits and Sharp keeps pixel protection enabled", async () => {
  const response = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.deepEqual(capabilities.limits, {
    maxImagePixels: 50_000_000,
    maxImageDimension: 16_384,
    maxImagePdfPixels: 100_000_000,
    maxBatchBytes: 2 * 1024 * 1024 * 1024,
    maxPdfPages: 500,
    maxOcrPdfPages: 100
  });
  assert.deepEqual(capabilities.groups.image.experimentalInputs, ["heic", "heif"]);
  assert.deepEqual(capabilities.groups.document.experimentalInputs, ["wpd", "wps", "wpt"]);
  assert.deepEqual(capabilities.groups.spreadsheet.experimentalInputs, ["et", "ett"]);
  assert.deepEqual(capabilities.groups.presentation.experimentalInputs, ["dps", "dpt"]);
  assert.deepEqual(capabilities.groups.audio.experimentalInputs, ["kgg", "mflac"]);
  assert.equal(capabilities.platform.standardNcm, true);
  assert.equal(capabilities.platform.av3a, process.platform === "win32");
  const serverSource = require("node:fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /limitInputPixels\s*:\s*false/);
  assert.match(serverSource, /assertImagePdfBudget\(metadataList\)/);
  assert.match(serverSource, /assertPdfPages\(pdf\.numPages\)/);
  assert.match(serverSource, /"-cropbox"/);
  assert.match(serverSource, /async function\* pages\(\)/);
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
  for (const file of ["resource-policy.js", "text-conversion.js", "pdf-table-extractor.js", "pdf-table-runtime.js"]) {
    assert.ok(packageJson.build.files.includes(file), `${file} is missing from build.files`);
    assert.match(source, new RegExp(`["]${file.replace(".", "\\.")}["]`));
  }
});
