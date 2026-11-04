const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");
const { Document, Packer, Paragraph, ImageRun } = require("docx");
const { PDFDocument } = require("pdf-lib");
const yauzl = require("yauzl");

const projectRoot = path.join(__dirname, "..");
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fm-conversion-integrity-"));
process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(suiteRoot, "runtime");
after(() => fsp.rm(suiteRoot, { recursive: true, force: true }));

function child(script, args = []) {
  return spawnSync(process.execPath, ["-e", script, ...args], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 30000
  });
}

async function imageDocument(color) {
  const image = await sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).png().toBuffer();
  const document = new Document({ sections: [{ children: [
    new Paragraph({ children: [new ImageRun({ data: image, type: "png", transformation: { width: 40, height: 40 } })] })
  ] }] });
  return { image, buffer: await Packer.toBuffer(document) };
}

async function readZipFiles(filePath) {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const files = [];
    zip.on("error", reject);
    zip.on("end", () => resolve(files));
    zip.on("entry", (entry) => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("error", reject);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => { files.push({ name: entry.fileName, data: Buffer.concat(chunks) }); zip.readEntry(); });
    }));
    zip.readEntry();
  }));
}

test("image PDF output failure rejects without terminating the conversion process", async () => {
  const input = path.join(suiteRoot, "input.png");
  await sharp({ create: { width: 40, height: 40, channels: 3, background: "red" } }).png().toFile(input);
  const result = child(`
    const { convertImagesToPdf } = require('./image');
    convertImagesToPdf([{ inputPath: process.argv[1] }], process.argv[2]).then(() => {
      console.error('UNEXPECTED_SUCCESS'); process.exitCode = 2;
    }, error => { console.log('CONTROLLED_FAILURE:' + error.code); });
  `, [input, path.join(suiteRoot, "missing-directory", "output.pdf")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTROLLED_FAILURE:ENOENT/);
});

test("ZIP packaging rejects a missing source without terminating the conversion process", () => {
  const result = child(`
    require('./zip-util').zipFiles([{ inputPath: process.argv[1], archiveName: 'missing.txt' }], process.argv[2])
      .then(() => { console.error('UNEXPECTED_SUCCESS'); process.exitCode = 2; },
        error => { console.log('CONTROLLED_FAILURE:' + error.code); });
  `, [path.join(suiteRoot, "missing-input.txt"), path.join(suiteRoot, "missing-source.zip")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTROLLED_FAILURE:ENOENT/);
});

test("ZIP extraction rejects corrupt compressed data without terminating the conversion process", async () => {
  const input = path.join(suiteRoot, "zip-content.txt");
  const zipPath = path.join(suiteRoot, "corrupt.zip");
  await fsp.writeFile(input, "repeat-me ".repeat(100));
  await require("../zip-util").zipFiles([{ inputPath: input, archiveName: "content.txt" }], zipPath);
  const data = await fsp.readFile(zipPath);
  assert.equal(data.readUInt16LE(8), 8, "fixture must use DEFLATE");
  const compressedStart = 30 + data.readUInt16LE(26) + data.readUInt16LE(28);
  data[compressedStart] = 0x07; // Reserved DEFLATE block type, a deterministic decoder error.
  await fsp.writeFile(zipPath, data);
  const result = child(`
    const { openZipEntriesFromBuffer, readZipEntryToFile } = require('./zip-util');
    (async () => {
      const zip = await openZipEntriesFromBuffer(require('fs').readFileSync(process.argv[1]));
      zip.once('entry', async entry => {
        try { await readZipEntryToFile(zip, entry, process.argv[2]); process.exitCode = 2; }
        catch (error) { console.log('CONTROLLED_FAILURE:' + error.message); }
        finally { zip.close(); }
      });
      zip.readEntry();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, [zipPath, path.join(suiteRoot, "corrupt-output.txt")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTROLLED_FAILURE:.*invalid block type/);
});

test("same-name Markdown conversions retain independent image resources", async () => {
  const { convertDocumentToMarkdown } = require("../office-convert");
  const first = await imageDocument("red");
  const second = await imageDocument("blue");
  const firstInput = path.join(suiteRoot, "first.docx");
  const secondInput = path.join(suiteRoot, "second.docx");
  await fsp.writeFile(firstInput, first.buffer);
  await fsp.writeFile(secondInput, second.buffer);
  const firstResult = await convertDocumentToMarkdown(firstInput, path.join(suiteRoot, "first.md"), "docx", "同名.docx");
  const firstAsset = path.join(firstResult.assetsDir, "image-1.png");
  assert.deepEqual(await fsp.readFile(firstAsset), first.image);
  const secondResult = await convertDocumentToMarkdown(secondInput, path.join(suiteRoot, "second.md"), "docx", "同名.docx");
  assert.deepEqual(await fsp.readFile(firstAsset), first.image, "a newer result must not overwrite the earlier image");
  assert.notEqual(firstResult.assetsDir, secondResult.assetsDir);
  assert.deepEqual(await fsp.readFile(path.join(secondResult.assetsDir, "image-1.png")), second.image);
});

test("registered Markdown downloads keep the first image after converting another same-name document", async (t) => {
  const { startServer } = require("../server");
  const { server, url } = await startServer(0);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const first = await imageDocument("red");
  const second = await imageDocument("blue");
  const convert = async (data) => {
    const form = new FormData();
    form.append("file", new Blob([data]), "同名.docx");
    form.append("targetFormat", "md");
    const response = await fetch(`${url}/api/convert`, { method: "POST", body: form });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const a = await convert(first.buffer);
  const b = await convert(second.buffer);
  assert.equal(a.assets.length, 1);
  assert.equal(b.assets.length, 1);
  const downloaded = await fetch(`${url}${a.assets[0].url}`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), first.image);
  const textOnly = new Document({ sections: [{ children: [new Paragraph("Text only")] }] });
  const c = await convert(await Packer.toBuffer(textOnly));
  assert.ok(!c.assets?.length, "an image-free result must not inherit old resources");
});

test("conversion API accepts only its exact page origin while preserving CLI requests", async (t) => {
  const { startServer } = require("../server");
  const { server, url } = await startServer(0);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const convert = async (headers) => {
    const form = new FormData();
    form.append("file", new Blob(['{"name":"mouse"}']), "input.json");
    form.append("targetFormat", "csv");
    return fetch(`${url}/api/convert`, { method: "POST", body: form, headers });
  };
  const port = Number(new URL(url).port);
  for (const headers of [
    { Origin: `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}` },
    { Referer: `http://localhost:${port}/untrusted` },
    { Origin: "https://example.com" }
  ]) {
    const response = await convert(headers);
    const body = await response.text();
    assert.equal(response.status, 403, body);
  }
  for (const headers of [{ Origin: url, Referer: `${url}/` }, {}]) {
    const response = await convert(headers);
    const body = await response.text();
    assert.equal(response.status, 200, body);
  }
});

test("PDF group splitting preserves N-page groups when qpdf is unavailable", async () => {
  const source = await PDFDocument.create();
  for (let i = 0; i < 5; i++) source.addPage([100 + i, 100]);
  const input = path.join(suiteRoot, "five-pages.pdf");
  const output = path.join(suiteRoot, "groups.zip");
  await fsp.writeFile(input, await source.save());
  const result = child(`
    require('./utils').commandExists = async () => false;
    require('./pdf').splitPdfToZip(process.argv[1], process.argv[2], { splitMode: 'group', groupSize: '2' })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `, [input, output]);
  assert.equal(result.status, 0, result.stderr);
  const entries = await readZipFiles(output);
  assert.deepEqual(entries.map((entry) => entry.name), ["page-001-002.pdf", "page-003-004.pdf", "page-005-005.pdf"]);
  const pages = await Promise.all(entries.map(async (entry) => (await PDFDocument.load(entry.data)).getPages().map((page) => page.getWidth())));
  assert.deepEqual(pages, [[100, 101], [102, 103], [104]]);
});

test("encrypted PDF merge and fallback splitting reject before publishing empty ciphertext pages", async (t) => {
  const { QPDF_PATH } = require("../config");
  const version = spawnSync(QPDF_PATH, ["--version"], { windowsHide: true, timeout: 5000 });
  if (version.status !== 0) return t.skip("qpdf is required to generate a real encrypted input fixture");
  const source = await PDFDocument.create();
  source.addPage().drawText("Original editable text");
  const input = path.join(suiteRoot, "plain.pdf");
  const encrypted = path.join(suiteRoot, "encrypted.pdf");
  const merged = path.join(suiteRoot, "encrypted-merged.pdf");
  const split = path.join(suiteRoot, "encrypted-split.zip");
  await fsp.writeFile(input, await source.save());
  const encryption = spawnSync(QPDF_PATH, ["--object-streams=disable", "--encrypt", "fixture-pass", "fixture-pass", "256", "--", input, encrypted], {
    windowsHide: true, encoding: "utf8", timeout: 5000
  });
  assert.equal(encryption.status, 0, encryption.stderr);
  await assert.rejects(require("../pdf").mergePdfFiles([{ inputPath: encrypted }], merged),
    (error) => error.code === "PDF_ENCRYPTED_INPUT" && /解密/.test(error.messages.zhCN));
  assert.equal(fs.existsSync(merged), false);
  const result = child(`
    require('./utils').commandExists = async () => false;
    require('./pdf').splitPdfToZip(process.argv[1], process.argv[2])
      .then(() => { process.exitCode = 2; }, error => console.log('CONTROLLED_FAILURE:' + error.code));
  `, [encrypted, split]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTROLLED_FAILURE:PDF_ENCRYPTED_INPUT/);
  assert.equal(fs.existsSync(split), false);
  const { server, url } = await require("../server").startServer(0);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const form = new FormData();
  form.append("files", new Blob([await fsp.readFile(encrypted)]), "encrypted.pdf");
  const response = await fetch(`${url}/api/merge-pdfs`, { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 422, JSON.stringify(payload));
  assert.equal(payload.errorCode, "PDF_ENCRYPTED_INPUT");
});

test("PDF merge identifies a disguised non-PDF input without publishing a partial result", async (t) => {
  const source = await PDFDocument.create();
  source.addPage().drawText("This valid PDF must not be silently merged on its own.");
  const valid = Buffer.from(await source.save());
  const invalid = Buffer.from("FlyingMouse Format diagnostics\nThis is a text report, not PDF data.\n");
  const invalidName = "原始题目（诊断文本）.pdf";
  const { downloads } = require("../config");
  const registeredBefore = new Set(downloads.keys());
  const { server, url } = await require("../server").startServer(0);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const form = new FormData();
  form.append("files", new Blob([valid], { type: "application/pdf" }), "正常题目.pdf");
  form.append("files", new Blob([invalid], { type: "application/pdf" }), invalidName);
  const response = await fetch(`${url}/api/merge-pdfs`, { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 422, JSON.stringify(payload));
  assert.equal(payload.errorCode, "PDF_INVALID_INPUT");
  assert.ok(payload.error.includes(invalidName), payload.error);
  assert.ok(payload.messages.zhCN.includes(invalidName));
  assert.ok(payload.messages.enUS.includes(invalidName));
  assert.equal(payload.downloadUrl, undefined);
  assert.deepEqual(new Set(downloads.keys()), registeredBefore);
});

test("PDF conversion identifies non-PDF content before invoking an Office converter", async (t) => {
  const originalName = "题目（实际是文本）.pdf";
  const { downloads } = require("../config");
  const registeredBefore = new Set(downloads.keys());
  const { server, url } = await require("../server").startServer(0);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const form = new FormData();
  form.append("file", new Blob(["FlyingMouse Format diagnostics\nNot PDF data."], { type: "application/pdf" }), originalName);
  form.append("targetFormat", "docx");
  const response = await fetch(`${url}/api/convert`, { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 422, JSON.stringify(payload));
  assert.equal(payload.errorCode, "PDF_INVALID_INPUT");
  assert.ok(payload.error.includes(originalName), payload.error);
  assert.equal(payload.downloadUrl, undefined);
  assert.deepEqual(new Set(downloads.keys()), registeredBefore);
});

test("PDF input header check preserves parser handling of prefixes and damaged PDF bodies", async () => {
  const { assertPdfInputHeader } = require("../pdf-input");
  const source = await PDFDocument.create();
  source.addPage().drawText("Header may span the validation read boundary.");
  const prefixed = path.join(suiteRoot, "prefixed.pdf");
  await fsp.writeFile(prefixed, Buffer.concat([Buffer.alloc(65533, 32), Buffer.from(await source.save())]));
  await assertPdfInputHeader(prefixed, "prefixed.pdf");
  assert.equal((await PDFDocument.load(await fsp.readFile(prefixed))).getPageCount(), 1);
  const damaged = path.join(suiteRoot, "damaged.pdf");
  await fsp.writeFile(damaged, "%PDF-1.7\nThis file has a PDF header but no objects.\n");
  await assertPdfInputHeader(damaged, "damaged.pdf");
  await assert.rejects(async () => (await PDFDocument.load(await fsp.readFile(damaged))).getPageCount());
});
