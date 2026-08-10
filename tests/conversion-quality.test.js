const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { after, before, test } = require("node:test");
const sharp = require("sharp");
const serverModule = require("../server");
const { convertNcm } = require("../ncm-format");

const scratchRoot = path.join(os.tmpdir(), `flyingmouse-quality-tests-${process.pid}`);
let server;
let baseUrl;

async function parseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function uploadConvert(filePath, fileName, targetFormat, mimeType = "application/octet-stream") {
  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(filePath)], { type: mimeType }), fileName);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await parseBody(response);
  return { response, body };
}

async function downloadResult(result, outputName) {
  const response = await fetch(`${baseUrl}${result.downloadUrl}`);
  assert.strictEqual(response.status, 200, `download failed for ${result.downloadUrl}`);
  const outputPath = path.join(scratchRoot, outputName);
  await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

before(async () => {
  await fsp.rm(scratchRoot, { recursive: true, force: true });
  await fsp.mkdir(scratchRoot, { recursive: true });
  const started = await serverModule.startServer(0);
  server = started.server;
  baseUrl = started.url;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fsp.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
});

test("capabilities advertise resource limits and the smart PDF → Excel label", async () => {
  const response = await fetch(`${baseUrl}/api/capabilities`);
  const body = await response.json();
  assert.strictEqual(response.status, 200);
  assert.ok(body.limits, "capabilities must expose limits");
  assert.strictEqual(body.limits.maxImagePixels, 100 * 1000 * 1000);
  assert.strictEqual(body.limits.maxImageDimension, 30_000);
  assert.strictEqual(body.limits.maxPdfPages, 1_000);
  assert.strictEqual(body.limits.maxOcrPdfPages, 200);
  assert.ok(body.limits.maxBatchTotalBytes >= 2 * 1024 * 1024 * 1024);
  assert.ok(
    body.optional.some((item) => /智能表格提取|smart table/i.test(item.name)),
    "PDF table extractor label must mention smart extraction"
  );
});

test("HTML → Markdown keeps headings and lists via Turndown", async () => {
  const sourcePath = path.join(scratchRoot, "article.html");
  await fsp.writeFile(
    sourcePath,
    "<h1>Hello</h1>\n<ul>\n<li>A</li>\n<li>B</li>\n</ul>\n<p>Body <strong>bold</strong> text.</p>",
    "utf8"
  );
  const { response, body } = await uploadConvert(sourcePath, "article.html", "md", "text/html");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "article.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  assert.match(markdown, /^# Hello\s*$/m);
  assert.match(markdown, /^-\s+A\s*$/m);
  assert.match(markdown, /^-\s+B\s*$/m);
  assert.match(markdown, /\*\*bold\*\*/);
});

test("CSV → JSON handles quoted fields with embedded newlines", async () => {
  const csv = '"name","description"\n"鼠鼠","第一行\n第二行"\n"cat","say ""hi"""\n';
  const sourcePath = path.join(scratchRoot, "multiline.csv");
  await fsp.writeFile(sourcePath, csv, "utf8");

  const { response, body } = await uploadConvert(sourcePath, "multiline.csv", "json", "text/csv");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "multiline.json");
  const parsed = JSON.parse(await fsp.readFile(outputPath, "utf8"));
  assert.deepStrictEqual(parsed, [
    { name: "鼠鼠", description: "第一行\n第二行" },
    { name: "cat", description: 'say "hi"' }
  ]);
});

test("CSV parser handles CRLF, escaped quotes and trailing newlines", () => {
  const rows = serverModule.parseCsv('a,b\r\n"x","1,2"\r\n"q""q",z\r\n');
  assert.deepStrictEqual(rows, [
    ["a", "b"],
    ["x", "1,2"],
    ['q"q', "z"]
  ]);
});

test("oversized image dimensions are rejected with a clear safety error", async () => {
  const sourcePath = path.join(scratchRoot, "oversized.png");
  await sharp({
    create: { width: 30_001, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } }
  })
    .png()
    .toFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "oversized.png", "jpg", "image/png");
  assert.strictEqual(response.status, 500, "oversized image must be rejected");
  assert.match(body.error, /安全限制|limit/i);
});

test("NCM decryption exposes cover art and song metadata (engine-free)", async (t) => {
  const fixture = path.join(__dirname, "fixtures", "sample.ncm");
  if (!fs.existsSync(fixture)) {
    t.skip("缺少真实 NCM fixture（官方网易云客户端下载，放入 tests/fixtures/sample.ncm）");
    return;
  }
  const result = await convertNcm(fixture);
  try {
    assert.ok(result.nativePath, "native audio must be written");
    assert.ok(result.coverPath, "cover art must be extracted");
    const cover = await fsp.readFile(result.coverPath);
    const isJpeg = cover.length >= 3 && cover[0] === 0xff && cover[1] === 0xd8 && cover[2] === 0xff;
    const isPng = cover.length >= 8 && cover.subarray(0, 8).equals(Buffer.from("89504E470D0A1A0A", "hex"));
    assert.ok(isJpeg || isPng, "cover must be a valid JPEG or PNG image");
    assert.ok(result.meta, "meta must be decoded");
    const title = result.meta.musicName || result.meta.name || result.meta.title;
    assert.ok(title, "meta must include a song title");
  } finally {
    await fsp.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("NCM metadata mapping fills title, artist and album", () => {
  const tags = serverModule.ncmMetaTags({
    musicName: "Happy Song",
    artist: [["Mouse Singer"]],
    album: "Tiny Fish"
  });
  assert.deepStrictEqual(tags, {
    title: "Happy Song",
    artist: "Mouse Singer",
    album: "Tiny Fish"
  });
  assert.deepStrictEqual(serverModule.ncmMetaTags(null), {});
  assert.deepStrictEqual(serverModule.ncmMetaTags({ musicName: "  " }), {});
});
