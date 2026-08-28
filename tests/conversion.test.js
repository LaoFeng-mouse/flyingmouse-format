const assert = require("assert");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const { pathToFileURL } = require("url");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const yauzl = require("yauzl");
const { after, before, test } = require("node:test");
const sharp = require("sharp");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const scratchRoot = path.join(os.tmpdir(), `flyingmouse-format-tests-${process.pid}`);
const isolatedRuntimeRoot = path.join(scratchRoot, "empty-runtime");
if (!process.env.FLYINGMOUSE_FORMAT_BASE_URL) {
  process.env.FLYINGMOUSE_RUNTIME_DIR = isolatedRuntimeRoot;
}
const serverModule = process.env.FLYINGMOUSE_FORMAT_BASE_URL ? null : require("../server");
const FFMPEG_BIN = process.env.FLYINGMOUSE_FFMPEG_PATH
  || path.join(__dirname, "..", "bin", "ffmpeg", "ffmpeg.exe");
const { QPDF_PATH } = require("../config");
const {
  assetDirectoryNameForMarkdown,
  rewriteMarkdownAssetReferences,
  sanitizeAssetDirectoryName
} = require("../markdown-assets");
const qpdfAvailable = (() => {
  try {
    execFileSync(QPDF_PATH, ["--version"], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const structuredEnginePresent = fs.existsSync(
  path.join(__dirname, "..", "bin", "docstructure", "docstructure-engine.exe")
);
let server;
let baseUrl;
let sessionToken;

function apiFetch(apiPath, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Mahiro-Session-Token", sessionToken);
  return fetch(`${baseUrl}${apiPath}`, { ...options, headers });
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// 用 yauzl 解压 zip（不依赖 tar：git-bash 的 GNU tar 会把 C:\ 当远程主机导致假失败）
function extractZipToDir(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError);
        return;
      }
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const target = path.join(destDir, entry.fileName);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const output = fs.createWriteStream(target);
          stream.pipe(output);
          output.on("close", () => zipfile.readEntry());
        });
      });
      zipfile.on("end", resolve);
      zipfile.on("error", reject);
    });
  });
}

function readZipEntry(buffer, entryName) {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (method === 0) return data.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

async function createImage(filePath, color, width = 96, height = 64) {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color
    }
  })
    .png()
    .toFile(filePath);
}

async function createTextImage(filePath, text = "HELLO 123") {
  const svg = `<svg width="1000" height="260" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="55" y="160" font-family="Arial, Microsoft YaHei" font-size="86" fill="black">${text}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function createScannedTableImage(filePath) {
  const svg = `<svg width="1600" height="800" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <g stroke="black" stroke-width="6">
      <path d="M80 80H1520M80 300H1520M80 520H1520M80 740H1520"/>
      <path d="M80 80V740M800 80V740M1520 80V740"/>
    </g>
    <g font-family="Arial" font-size="84" fill="black">
      <text x="150" y="225">Item</text><text x="920" y="225">Qty</text>
      <text x="150" y="445">Apple</text><text x="920" y="445">2</text>
      <text x="150" y="665">Banana</text><text x="920" y="665">3</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function pdfObject(text) {
  return Buffer.from(text, "latin1");
}

async function createTextPdf(filePath) {
  const stream = [
    "BT", "/F1 18 Tf",
    "1 0 0 1 20 118 Tm (Item) Tj", "1 0 0 1 105 118 Tm (Qty) Tj", "1 0 0 1 170 118 Tm (Price) Tj",
    "1 0 0 1 20 82 Tm (Apple) Tj", "1 0 0 1 105 82 Tm (2) Tj", "1 0 0 1 170 82 Tm (3.50) Tj",
    "ET", ""
  ].join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream\nendobj\n`
  ].map(pdfObject);

  const chunks = [pdfObject("%PDF-1.4\n")];
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(object);
  }
  const body = Buffer.concat(chunks);
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  await fsp.writeFile(filePath, Buffer.concat([body, pdfObject(xref + trailer)]));
}

async function createCroppedTablePdf(filePath) {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 300]);
  page.setCropBox(50, 50, 300, 200);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const rows = [["Name", "Value"], ["Mouse", "7"]];
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    page.drawText(value, { x: 70 + columnIndex * 130, y: 205 - rowIndex * 70, size: 22, font });
  }));
  [60, 180, 310].forEach((x) => page.drawLine({ start: { x, y: 80 }, end: { x, y: 240 }, thickness: 2 }));
  [80, 160, 240].forEach((y) => page.drawLine({ start: { x: 60, y }, end: { x: 310, y }, thickness: 2 }));
  await fsp.writeFile(filePath, await document.save());
}

async function uploadConvert(filePath, fileName, targetFormat, mimeType = "application/octet-stream") {
  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(filePath)], { type: mimeType }), fileName);
  form.append("targetFormat", targetFormat);

  const response = await apiFetch("/api/convert", {
    method: "POST",
    body: form
  });
  const body = await parseBody(response);
  return { response, body };
}

async function uploadImagesToPdf(files, options = {}) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new Blob([await fsp.readFile(file.path)], { type: "image/png" }), file.name);
  }
  if (options.blanks) form.append("blanks", options.blanks);
  if (options.folderName) form.append("folderName", options.folderName);

  const response = await apiFetch("/api/convert-images-to-pdf", {
    method: "POST",
    body: form
  });
  const body = await parseBody(response);
  return { response, body };
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function downloadResult(result, outputName) {
  const response = await fetch(`${baseUrl}${result.downloadUrl}`);
  assert.strictEqual(response.status, 200, `download failed for ${result.downloadUrl}`);
  const outputPath = path.join(scratchRoot, outputName);
  await fsp.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

function assertPdf(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    assert.strictEqual(header.toString("latin1"), "%PDF-");
  } finally {
    fs.closeSync(fd);
  }
}

function sofficeProcessIds() {
  if (process.platform !== "win32") return new Set();
  try {
    const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq soffice*", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true
    });
    return new Set([...output.matchAll(/"soffice(?:\.exe|\.bin)"\s*,\s*"(\d+)"/gi)].map((match) => match[1]));
  } catch {
    return new Set();
  }
}

function assertZipWithEntry(filePath, expectedFragment) {
  const archive = fs.readFileSync(filePath);
  assert.strictEqual(archive.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");

  const minimumEocdSize = 22;
  const eocdSearchStart = Math.max(0, archive.length - 0xffff - minimumEocdSize);
  let eocdOffset = -1;
  for (let offset = archive.length - minimumEocdSize; offset >= eocdSearchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  assert.notStrictEqual(eocdOffset, -1, "ZIP end-of-central-directory record is missing");

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = archive.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.strictEqual(archive.readUInt32LE(offset), 0x02014b50, "invalid ZIP central-directory entry");
    const flags = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    entries.push(archive.subarray(nameStart, nameStart + nameLength).toString(flags & 0x0800 ? "utf8" : "latin1"));
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  assert.match(entries.join("\n"), expectedFragment);
}

before(async () => {
  await fsp.rm(scratchRoot, { recursive: true, force: true });
  await fsp.mkdir(scratchRoot, { recursive: true });
  if (process.env.FLYINGMOUSE_FORMAT_BASE_URL) {
    baseUrl = process.env.FLYINGMOUSE_FORMAT_BASE_URL.replace(/\/$/, "");
  } else {
    const started = await serverModule.startServer(0);
    server = started.server;
    baseUrl = started.url;
    sessionToken = started.sessionToken;
  }
  if (!sessionToken) {
    const sessionResponse = await fetch(`${baseUrl}/api/session`, { cache: "no-store" });
    assert.strictEqual(sessionResponse.status, 200);
    sessionToken = (await sessionResponse.json()).token;
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (!process.env.KEEP_CONVERSION_TESTS) {
    await fsp.rm(scratchRoot, { recursive: true, force: true });
  }
});
test("cleanup removes expired Markdown sidecar directories recursively", { skip: !serverModule }, async () => {
  const cleanupRoot = path.join(scratchRoot, "cleanup-runtime");
  const expiredDir = path.join(cleanupRoot, "expired.assets");
  const freshDir = path.join(cleanupRoot, "fresh.assets");
  await fsp.mkdir(expiredDir, { recursive: true });
  await fsp.mkdir(freshDir, { recursive: true });
  await fsp.writeFile(path.join(expiredDir, "image-1.png"), "old");
  await fsp.writeFile(path.join(freshDir, "image-1.png"), "fresh");
  const now = Date.now();
  const oldDate = new Date(now - 2 * 60 * 60 * 1000);
  await fsp.utimes(expiredDir, oldDate, oldDate);

  await serverModule.cleanupOldFiles({ now, directories: [cleanupRoot] });

  await assert.rejects(fsp.stat(expiredDir), (error) => error?.code === "ENOENT");
  assert.strictEqual((await fsp.stat(freshDir)).isDirectory(), true);
});

test("renamed Markdown outputs rewrite their sidecar directory references", () => {
  const markdown = [
    "# 报告",
    "![截图](带图报告.assets/image-1.png)",
    "<img src=\"带图报告.assets/image-2.jpg\">"
  ].join("\n");
  const rewritten = rewriteMarkdownAssetReferences(markdown, "带图报告.assets", "重命名报告.assets");
  assert.doesNotMatch(rewritten, /带图报告\.assets\//);
  assert.match(rewritten, /!\[截图\]\(重命名报告\.assets\/image-1\.png\)/);
  assert.match(rewritten, /src="重命名报告\.assets\/image-2\.jpg"/);
  assert.strictEqual(assetDirectoryNameForMarkdown(path.join("输出", "重命名报告.md")), "重命名报告.assets");
  assert.strictEqual(sanitizeAssetDirectoryName("../带图报告.assets"), "带图报告.assets");
});

test("converts a PNG image to a visually equivalent single-page PDF without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "测试图片.png");
  await createImage(sourcePath, { r: 42, g: 150, b: 220, alpha: 1 });
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "测试图片.png", "pdf", "image/png");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "测试图片.pdf");
  const outputPath = await downloadResult(body, "single-image.pdf");
  assertPdf(outputPath);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("merges multiple images into one PDF without changing any source image", async () => {
  const firstPath = path.join(scratchRoot, "第一页.png");
  const secondPath = path.join(scratchRoot, "第二页.png");
  await createImage(firstPath, { r: 230, g: 80, b: 60, alpha: 1 }, 80, 80);
  await createImage(secondPath, { r: 60, g: 180, b: 90, alpha: 1 }, 120, 70);
  const hashes = [hashFile(firstPath), hashFile(secondPath)];

  const { response, body } = await uploadImagesToPdf([
    { path: firstPath, name: "第一页.png" },
    { path: secondPath, name: "第二页.png" }
  ]);

  assert.strictEqual(response.status, 200, body.error);
  assert.match(body.fileName, /\.pdf$/);
  const outputPath = await downloadResult(body, "merged-images.pdf");
  assertPdf(outputPath);
  assert.deepStrictEqual([hashFile(firstPath), hashFile(secondPath)], hashes);
});

test("merges images with blank pages inserted at requested positions", async () => {
  const firstPath = path.join(scratchRoot, "空白页测试-一.png");
  const secondPath = path.join(scratchRoot, "空白页测试-二.png");
  await createImage(firstPath, { r: 200, g: 30, b: 30, alpha: 1 }, 90, 60);
  await createImage(secondPath, { r: 30, g: 30, b: 200, alpha: 1 }, 90, 60);

  // blanks=0,2：在第 0 个文件之前 + 第 2 个文件之后插入空白页 → 4 页：白,一,二,白
  const { response, body } = await uploadImagesToPdf(
    [
      { path: firstPath, name: "空白页测试-一.png" },
      { path: secondPath, name: "空白页测试-二.png" }
    ],
    { blanks: "0,2" }
  );

  assert.strictEqual(response.status, 200, body.error);
  assert.match(body.fileName, /等4个文件\.pdf$/);
  const outputPath = await downloadResult(body, "blank-merged.pdf");
  assertPdf(outputPath);
  // 验证 PDF 页数 = 4（用 pdfjs 读页数）——require.resolve 按 npm 解析，避免硬编码本机路径
  const { getDocument } = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
  const data = new Uint8Array(await fsp.readFile(outputPath));
  const doc = await getDocument({ data, isEvalSupported: false }).promise;
  assert.strictEqual(doc.numPages, 4);
});

test("converts a PDF to DOCX with extracted text and tables", async () => {
  const sourcePath = path.join(scratchRoot, "word-source.pdf");
  await createTextPdf(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "word-source.pdf", "docx", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "word-source.docx");
  const outputPath = await downloadResult(body, "word-source.docx");
  const packageBytes = await fsp.readFile(outputPath);
  assert.strictEqual(packageBytes.readUInt32LE(0), 0x04034b50, "docx must be a ZIP package");
  const documentXml = readZipEntry(packageBytes, "word/document.xml");
  assert.match(documentXml, /<w:document/);
  // Windows 标准版的结构化 PDF 回退会把这组规则定位文字恢复为真实表格，
  // 并保留最后一列；其他平台仍允许走纯 PDF.js 文字回退。
  if (process.platform === "win32") {
    assert.match(documentXml, /<w:tbl>/);
    assert.match(documentXml, /Price/);
    assert.match(documentXml, /3\.50/);
  }
  assert.match(documentXml, /Item/);
  assert.match(documentXml, /Qty/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a video to an animated GIF", async () => {
  const sourcePath = path.join(scratchRoot, "clip.mp4");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=128x96:rate=10", "-pix_fmt", "yuv420p", sourcePath]);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "clip.mp4", "gif", "video/mp4");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "clip.gif");
  const outputPath = await downloadResult(body, "clip.gif");
  const header = fs.readFileSync(outputPath).subarray(0, 6).toString("latin1");
  assert.strictEqual(header, "GIF89a", "video GIF must start with GIF89a");
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts an animated WebP to GIF preserving frames", async () => {
  const sourcePath = path.join(scratchRoot, "anim-in.webp");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=96x72:rate=8", "-lossless", "0", "-loop", "0", sourcePath]);

  const { response, body } = await uploadConvert(sourcePath, "anim-in.webp", "gif", "image/webp");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "anim-in.gif");
  const outputPath = await downloadResult(body, "anim-in.gif");
  const header = fs.readFileSync(outputPath).subarray(0, 6).toString("latin1");
  assert.strictEqual(header, "GIF89a", "animated WebP GIF must start with GIF89a");
});

test("converts XLSX to legacy XLS via LibreOffice", async () => {
  const sourcePath = path.join(scratchRoot, "legacy-source.xlsx");
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["a", "b"]);
  sheet.addRow([1, 2]);
  await workbook.xlsx.writeFile(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "legacy-source.xlsx", "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "legacy-source.xls");
  const outputPath = await downloadResult(body, "legacy-source.xls");
  const header = fs.readFileSync(outputPath).subarray(0, 4).toString("hex");
  assert.strictEqual(header, "d0cf11e0", "XLS must be an OLE2 compound document");
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a ZIP of images to a single PDF", async () => {
  const yazl = require("yazl");
  const first = path.join(scratchRoot, "zip-a.png");
  const second = path.join(scratchRoot, "zip-b.png");
  await createImage(first, "green", 80, 60);
  await createImage(second, "blue", 80, 60);
  const zipPath = path.join(scratchRoot, "images.zip");
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    archive.addFile(first, "a.png");
    archive.addFile(second, "b.png");
    const output = fs.createWriteStream(zipPath);
    archive.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
    archive.end();
  });

  const { response, body } = await uploadConvert(zipPath, "images.zip", "pdf", "application/zip");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "images.pdf");
  const outputPath = await downloadResult(body, "images.pdf");
  assertPdf(outputPath);
});

test("encrypts a PDF with a password via qpdf (requires qpdf engine)", { skip: !qpdfAvailable && "qpdf engine missing" }, async () => {
  const sourcePath = path.join(scratchRoot, "encrypt-source.pdf");
  await createTextPdf(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "application/pdf" }), "encrypt-source.pdf");
  form.append("targetFormat", "pdf");
  form.append("pdfAction", "encrypt");
  form.append("password", "secret123");
  const response = await apiFetch("/api/convert", { method: "POST", body: form });
  const body = await parseBody(response);

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "encrypt-source.pdf");
  const outputPath = await downloadResult(body, "encrypted.pdf");
  assertPdf(outputPath);

  // 输出是加密 PDF：带 /Encrypt 标记，且无密码无法打开
  const outputBytes = await fsp.readFile(outputPath);
  assert.match(outputBytes.toString("latin1"), /\/Encrypt/, "encrypted PDF must carry an /Encrypt dictionary");
  await assert.rejects(
    () => PDFDocument.load(outputBytes),
    /encrypted|Encrypt/i,
    "encrypted PDF must not open without a password"
  );
  assert.strictEqual(hashFile(sourcePath), beforeHash, "source must be unchanged");
});

test("rejects PDF encryption without a password with a clear error", async () => {
  const sourcePath = path.join(scratchRoot, "encrypt-no-password.pdf");
  await createTextPdf(sourcePath);

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "application/pdf" }), "encrypt-no-password.pdf");
  form.append("targetFormat", "pdf");
  form.append("pdfAction", "encrypt");
  const response = await apiFetch("/api/convert", { method: "POST", body: form });
  const body = await parseBody(response);

  assert.strictEqual(response.status, 422);
  assert.strictEqual(body.errorCode, "PDF_ENCRYPT_NO_PASSWORD");
  assert.match(body.error, /密码/);
});

test("decrypts a qpdf-encrypted PDF back to readable content (requires qpdf engine)", { skip: !qpdfAvailable && "qpdf engine missing" }, async () => {
  const sourcePath = path.join(scratchRoot, "roundtrip-source.pdf");
  const doc = await PDFDocument.create();
  const page = doc.addPage([240, 160]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SECRET", { x: 30, y: 80, size: 18, font });
  await fsp.writeFile(sourcePath, await doc.save());

  // 加密
  const encForm = new FormData();
  encForm.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "application/pdf" }), "roundtrip-source.pdf");
  encForm.append("targetFormat", "pdf");
  encForm.append("pdfAction", "encrypt");
  encForm.append("password", "secret123");
  const encResponse = await apiFetch("/api/convert", { method: "POST", body: encForm });
  const encBody = await parseBody(encResponse);
  assert.strictEqual(encResponse.status, 200, encBody.error);
  const encryptedPath = await downloadResult(encBody, "roundtrip-enc.pdf");

  // 解密
  const decForm = new FormData();
  decForm.append("file", new Blob([await fsp.readFile(encryptedPath)], { type: "application/pdf" }), "roundtrip-enc.pdf");
  decForm.append("targetFormat", "pdf");
  decForm.append("pdfAction", "decrypt");
  decForm.append("password", "secret123");
  const decResponse = await apiFetch("/api/convert", { method: "POST", body: decForm });
  const decBody = await parseBody(decResponse);
  assert.strictEqual(decResponse.status, 200, decBody.error);
  const decryptedPath = await downloadResult(decBody, "roundtrip-dec.pdf");

  const decryptedBytes = await fsp.readFile(decryptedPath);
  assert.doesNotMatch(decryptedBytes.toString("latin1"), /\/Encrypt/, "decrypted PDF must not carry /Encrypt");
  const reopened = await PDFDocument.load(decryptedBytes);
  assert.strictEqual(reopened.getPageCount(), 1, "decrypted PDF must be readable with 1 page");
});

test("PDF table OCR quality gate rejects low-confidence scans with a clear reason", async () => {
  const { assertPdfTableOcrQuality } = require("../server");
  assert.doesNotThrow(() => assertPdfTableOcrQuality({
    summary: [{ pageNumber: 1, source: "text", tableCount: 3, confidence: 0.9 }]
  }));
  assert.throws(
    () => assertPdfTableOcrQuality({
      summary: [{ pageNumber: 1, source: "ocr", tableCount: 1, confidence: 0.51 }]
    }),
    (error) => error.code === "PDF_TABLE_OCR_LOW_QUALITY" && /置信度/.test(error.messages.zhCN)
  );
});

test("rejects a silent video targeting audio with a stable error code", async () => {
  const sourcePath = path.join(scratchRoot, "silent.mp4");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=96x64:rate=10", "-pix_fmt", "yuv420p", sourcePath]);

  const { response, body } = await uploadConvert(sourcePath, "silent.mp4", "wav", "video/mp4");

  assert.strictEqual(response.status, 422);
  assert.strictEqual(body.errorCode, "MEDIA_NO_AUDIO_TRACK");
  assert.match(body.messages.zhCN, /音频轨道/);
});

test("rejects an animated GIF targeting TIFF with a stable error code", async () => {
  const sourcePath = path.join(scratchRoot, "anim-tiff.gif");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", sourcePath]);

  const { response, body } = await uploadConvert(sourcePath, "anim-tiff.gif", "tiff", "image/gif");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(body.errorCode, "TARGET_UNAVAILABLE_FOR_SOURCE");
});

test("rejects an unknown target with a stable error code", async () => {
  const sourcePath = path.join(scratchRoot, "unknown-target.txt");
  await fsp.writeFile(sourcePath, "text", "utf8");

  const { response, body } = await uploadConvert(sourcePath, "unknown-target.txt", "xyz9", "text/plain");

  assert.strictEqual(response.status, 400);
  assert.strictEqual(body.errorCode, "UNSUPPORTED_TARGET");
});

test("renders PDF pages to a PNG zip without changing the source PDF", async () => {
  const sourcePath = path.join(scratchRoot, "报价单.pdf");
  await createTextPdf(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "报价单.pdf", "png", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "报价单.png.zip");
  const outputPath = await downloadResult(body, "pdf-pages.zip");
  assertZipWithEntry(outputPath, /page-001\.png/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("renders PDF pages to a JPG zip without changing the source PDF", async () => {
  const sourcePath = path.join(scratchRoot, "picture-export.pdf");
  await createTextPdf(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "picture-export.pdf", "jpg", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "picture-export.jpg.zip");
  const outputPath = await downloadResult(body, "pdf-pages-jpg.zip");
  assertZipWithEntry(outputPath, /page-001\.jpg/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("OCR converts an image containing text to TXT without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "ocr-image.png");
  await createTextImage(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "ocr-image.png", "txt", "image/png");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "ocr-image.txt");
  const outputPath = await downloadResult(body, "ocr-image.txt");
  const text = await fsp.readFile(outputPath, "utf8");
  assert.match(text, /HELLO\s+123/i);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("OCR converts an image-only PDF to TXT without changing the source PDF", async () => {
  const imagePath = path.join(scratchRoot, "ocr-pdf-source.png");
  await createTextImage(imagePath);
  const imageToPdf = await uploadConvert(imagePath, "ocr-pdf-source.png", "pdf", "image/png");
  assert.strictEqual(imageToPdf.response.status, 200, imageToPdf.body.error);
  const pdfPath = await downloadResult(imageToPdf.body, "ocr-image-only.pdf");
  const beforeHash = hashFile(pdfPath);

  const { response, body } = await uploadConvert(pdfPath, "ocr-image-only.pdf", "txt", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "ocr-image-only.txt");
  const outputPath = await downloadResult(body, "ocr-image-only.txt");
  const text = await fsp.readFile(outputPath, "utf8");
  assert.match(text, /HELLO\s+123/i);
  assert.strictEqual(hashFile(pdfPath), beforeHash);
});

test("keeps existing PNG to JPG conversion working", async () => {
  const sourcePath = path.join(scratchRoot, "still-works.png");
  await createImage(sourcePath, { r: 15, g: 90, b: 180, alpha: 1 });
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "still-works.png", "jpg", "image/png");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "still-works.jpg");
  const outputPath = await downloadResult(body, "still-works.jpg");
  const metadata = await sharp(outputPath).metadata();
  assert.strictEqual(metadata.format, "jpeg");
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("keeps existing TXT to HTML conversion working without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "notes.txt");
  await fsp.writeFile(sourcePath, "line one\nline two", "utf8");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "notes.txt", "html", "text/plain");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "notes.html");
  const outputPath = await downloadResult(body, "notes.html");
  const html = await fsp.readFile(outputPath, "utf8");
  assert.match(html, /line one/);
  assert.match(html, /line two/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("PDF table extraction to XLSX keeps rows and cells", async () => {
  const sourcePath = path.join(scratchRoot, "表格.pdf");
  await createTextPdf(sourcePath);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "表格.pdf", "xlsx", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "表格.xlsx");
  const outputPath = await downloadResult(body, "表格.xlsx");
  assert.strictEqual(hashFile(sourcePath), beforeHash);

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.ok(workbook.getWorksheet("识别说明"), "xlsx 必须包含识别说明页");
  const sheet = workbook.getWorksheet("P001-T01");
  assert.ok(sheet, "xlsx 必须包含第一页第一张表");
  const expected = [["Item", "Qty", "Price"], ["Apple", "2", "3.50"]];
  let matches = 0;
  expected.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (String(sheet.getCell(rowIndex + 1, columnIndex + 1).value || "").trim() === value) matches += 1;
  }));
  assert.ok(matches / expected.flat().length >= 0.95, `electronic PDF cell accuracy ${matches}/${expected.flat().length}`);
});

test("cropped PDF table keeps PDF.js and Poppler coordinates aligned", async () => {
  const sourcePath = path.join(scratchRoot, "cropped-table.pdf");
  await createCroppedTablePdf(sourcePath);
  const { response, body } = await uploadConvert(sourcePath, "cropped-table.pdf", "xlsx", "application/pdf");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "cropped-table.xlsx");
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet("P001-T01");
  assert.ok(sheet);
  assert.deepStrictEqual([
    [String(sheet.getCell(1, 1).value), String(sheet.getCell(1, 2).value)],
    [String(sheet.getCell(2, 1).value), String(sheet.getCell(2, 2).value)]
  ], [["Name", "Value"], ["Mouse", "7"]]);
});

test("scanned PDF to XLSX fails closed when the structured engine is unavailable",
  { skip: structuredEnginePresent ? "structured engine is present in this environment" : false },
  async () => {
  const imagePath = path.join(scratchRoot, "scanned-table.png");
  await createScannedTableImage(imagePath);
  const imageToPdf = await uploadConvert(imagePath, "scanned-table.png", "pdf", "image/png");
  assert.strictEqual(imageToPdf.response.status, 200, imageToPdf.body.error);
  const pdfPath = await downloadResult(imageToPdf.body, "scanned-table.pdf");

  const { response, body } = await uploadConvert(pdfPath, "scanned-table.pdf", "xlsx", "application/pdf");
  assert.strictEqual(response.status, 500);
  assert.strictEqual(body.errorCode, "PDF_STRUCTURE_ENGINE_MISSING");
  assert.match(body.messages.zhCN, /结构化转换引擎/);
  assert.match(body.messages.enUS, /structured PDF conversion engine/i);
  assert.strictEqual(body.fileName, undefined);
  assert.strictEqual(body.downloadUrl, undefined);
});

test("audio files must not offer video container targets", async () => {
  const response = await apiFetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension: "mp3" })
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.ok(!body.targets.includes("mp4"), `mp3 must not offer mp4, got ${body.targets.join(",")}`);
  assert.ok(!body.targets.includes("webm"), `mp3 must not offer webm, got ${body.targets.join(",")}`);
  assert.ok(!body.targets.includes("mkv"), `mp3 must not offer mkv, got ${body.targets.join(",")}`);
  assert.ok(!body.targets.includes("mov"), `mp3 must not offer mov, got ${body.targets.join(",")}`);
  assert.ok(body.targets.includes("wav"), "mp3 must still offer wav");
  assert.ok(body.targets.includes("zip"), "mp3 must still offer zip");
});

test("video files keep both audio and video targets", async () => {
  const response = await apiFetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension: "mp4" })
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.ok(body.targets.includes("mp3"), "mp4 must offer mp3");
  assert.ok(body.targets.includes("mkv"), "mp4 must offer mkv");
});

test("cross-site conversion requests are rejected", async () => {
  const sourcePath = path.join(scratchRoot, "csrf-test.png");
  await createImage(sourcePath, { r: 200, g: 40, b: 40, alpha: 1 });

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "image/png" }), "csrf-test.png");
  form.append("targetFormat", "jpg");

  const evilResponse = await apiFetch("/api/convert", {
    method: "POST",
    headers: { Origin: "https://evil.example.com" },
    body: form
  });
  assert.strictEqual(evilResponse.status, 403, "cross-site origin must be rejected");

  const refererResponse = await apiFetch("/api/convert", {
    method: "POST",
    headers: { Referer: "https://evil.example.com/page.html" },
    body: form
  });
  assert.strictEqual(refererResponse.status, 403, "cross-site referer must be rejected");
});

test("local requests require the current session token and exact startup origin", async () => {
  const payload = JSON.stringify({ extension: "txt" });
  const missingToken = await fetch(`${baseUrl}/api/targets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(baseUrl).origin
    },
    body: payload
  });
  assert.strictEqual(missingToken.status, 403);
  assert.strictEqual((await parseBody(missingToken)).errorCode, "INVALID_SESSION_TOKEN");

  const wrongLocalOrigin = await apiFetch("/api/targets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:1"
    },
    body: payload
  });
  assert.strictEqual(wrongLocalOrigin.status, 403);
  assert.strictEqual((await parseBody(wrongLocalOrigin)).errorCode, "UNTRUSTED_REQUEST_ORIGIN");
});

test("local-origin conversion requests are allowed", async () => {
  const sourcePath = path.join(scratchRoot, "local-origin.png");
  await createImage(sourcePath, { r: 20, g: 120, b: 200, alpha: 1 });
  const beforeHash = hashFile(sourcePath);

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "image/png" }), "local-origin.png");
  form.append("targetFormat", "jpg");

  const response = await apiFetch("/api/convert", {
    method: "POST",
    headers: { Origin: new URL(baseUrl).origin },
    body: form
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "local-origin.jpg");
  const outputPath = await downloadResult(body, "local-origin.jpg");
  const metadata = await sharp(outputPath).metadata();
  assert.strictEqual(metadata.format, "jpeg");
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("audio files offer the new AAC/OPUS/WMA outputs", async () => {
  const response = await apiFetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension: "mp3" })
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.ok(body.targets.includes("aac"), `mp3 must offer aac, got ${body.targets.join(",")}`);
  assert.ok(body.targets.includes("opus"), `mp3 must offer opus, got ${body.targets.join(",")}`);
  assert.ok(body.targets.includes("wma"), `mp3 must offer wma, got ${body.targets.join(",")}`);
});

test("image files offer MP4/WebM video outputs when ffmpeg is available", async () => {
  const response = await apiFetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension: "gif" })
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.ok(body.targets.includes("mp4"), `gif must offer mp4, got ${body.targets.join(",")}`);
  assert.ok(body.targets.includes("webm"), `gif must offer webm, got ${body.targets.join(",")}`);
});

test("text files offer PDF output when LibreOffice is available", async () => {
  const response = await apiFetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extension: "txt" })
  });
  const body = await parseBody(response);
  assert.strictEqual(response.status, 200, body.error);
  assert.ok(body.targets.includes("pdf"), `txt must offer pdf, got ${body.targets.join(",")}`);
});

test("converts a TXT file to PDF without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "notes.txt");
  await fsp.writeFile(sourcePath, "line one\nline two", "utf8");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "notes.txt", "pdf", "text/plain");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "notes.pdf");
  const outputPath = await downloadResult(body, "notes.pdf");
  assertPdf(outputPath);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a Markdown file to PDF without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "readme.md");
  await fsp.writeFile(sourcePath, "# Title\n\nSome **bold** text.", "utf8");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "readme.md", "pdf", "text/markdown");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "readme.pdf");
  const outputPath = await downloadResult(body, "readme.pdf");
  assertPdf(outputPath);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("merges multiple PDFs into one PDF without changing the sources", async () => {
  const firstPath = path.join(scratchRoot, "合并一.pdf");
  const secondPath = path.join(scratchRoot, "合并二.pdf");
  await createTextPdf(firstPath);
  await createTextPdf(secondPath);
  const hashes = [hashFile(firstPath), hashFile(secondPath)];

  const form = new FormData();
  form.append("files", new Blob([await fsp.readFile(firstPath)], { type: "application/pdf" }), "合并一.pdf");
  form.append("files", new Blob([await fsp.readFile(secondPath)], { type: "application/pdf" }), "合并二.pdf");

  const response = await apiFetch("/api/merge-pdfs", { method: "POST", body: form });
  const body = await parseBody(response);

  assert.strictEqual(response.status, 200, body.error);
  assert.match(body.fileName, /\.pdf$/);
  const outputPath = await downloadResult(body, "merged.pdf");
  assertPdf(outputPath);
  const { PDFDocument } = require("pdf-lib");
  const merged = await PDFDocument.load(await fsp.readFile(outputPath));
  assert.strictEqual(merged.getPageCount(), 2, "merged PDF must contain both pages");
  assert.deepStrictEqual([hashFile(firstPath), hashFile(secondPath)], hashes);
});

test("splits a PDF into a per-page PDF zip without changing the source", async () => {
  const firstPath = path.join(scratchRoot, "页一.pdf");
  const secondPath = path.join(scratchRoot, "页二.pdf");
  await createTextPdf(firstPath);
  await createTextPdf(secondPath);

  const form = new FormData();
  form.append("files", new Blob([await fsp.readFile(firstPath)], { type: "application/pdf" }), "页一.pdf");
  form.append("files", new Blob([await fsp.readFile(secondPath)], { type: "application/pdf" }), "页二.pdf");
  const mergedResponse = await apiFetch("/api/merge-pdfs", { method: "POST", body: form });
  const mergedBody = await parseBody(mergedResponse);
  assert.strictEqual(mergedResponse.status, 200, mergedBody.error);
  const twoPagePdf = await downloadResult(mergedBody, "two-pages.pdf");
  const beforeHash = hashFile(twoPagePdf);

  const { response, body } = await uploadConvert(twoPagePdf, "two-pages.pdf", "pdf", "application/pdf");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "two-pages.pdf.zip");
  const zipPath = await downloadResult(body, "split.zip");
  assertZipWithEntry(zipPath, /page-001\.pdf/);
  assertZipWithEntry(zipPath, /page-002\.pdf/);

  const extractDir = path.join(scratchRoot, "split-out");
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  await extractZipToDir(zipPath, extractDir);
  const { PDFDocument } = require("pdf-lib");
  const page1 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-001.pdf")));
  const page2 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-002.pdf")));
  assert.strictEqual(page1.getPageCount(), 1, "page-001 must be a single page");
  assert.strictEqual(page2.getPageCount(), 1, "page-002 must be a single page");
  assert.strictEqual(hashFile(twoPagePdf), beforeHash);
});

test("splits a PDF into N-page groups when splitMode=group", { skip: !qpdfAvailable && "qpdf engine missing" }, async () => {
  // 造一个 5 页 PDF
  const fivePage = await PDFDocument.create();
  for (let i = 0; i < 5; i += 1) fivePage.addPage([240, 160]);
  const fivePagePath = path.join(scratchRoot, "five-pages.pdf");
  await fsp.writeFile(fivePagePath, await fivePage.save());

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(fivePagePath)], { type: "application/pdf" }), "five-pages.pdf");
  form.append("targetFormat", "pdf");
  form.append("splitMode", "group");
  form.append("groupSize", "2");
  const response = await apiFetch("/api/convert", { method: "POST", body: form });
  const body = await parseBody(response);

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "five-pages.pdf.zip");
  const zipPath = await downloadResult(body, "split-group.zip");
  assertZipWithEntry(zipPath, /page-001-002\.pdf/);
  assertZipWithEntry(zipPath, /page-003-004\.pdf/);
  assertZipWithEntry(zipPath, /page-005-005\.pdf/);

  const extractDir = path.join(scratchRoot, "split-group-out");
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  await extractZipToDir(zipPath, extractDir);
  const g1 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-001-002.pdf")));
  const g2 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-003-004.pdf")));
  const g3 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-005-005.pdf")));
  assert.strictEqual(g1.getPageCount(), 2, "group 1 must have 2 pages");
  assert.strictEqual(g2.getPageCount(), 2, "group 2 must have 2 pages");
  assert.strictEqual(g3.getPageCount(), 1, "group 3 must have 1 page (trailing)");
});

test("converts an animated GIF to MP4 without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "anim.gif");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", sourcePath]);
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "anim.gif", "mp4", "image/gif");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "anim.mp4");
  const outputPath = await downloadResult(body, "anim.mp4");
  const fd = fs.openSync(outputPath, "r");
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 4);
    assert.strictEqual(magic.toString("latin1"), "ftyp", "mp4 must start with ftyp box");
  } finally {
    fs.closeSync(fd);
  }
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts audio to AAC, OPUS and WMA outputs without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "tone.wav");
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", sourcePath]);
  const beforeHash = hashFile(sourcePath);

  const aac = await uploadConvert(sourcePath, "tone.wav", "aac", "audio/wav");
  assert.strictEqual(aac.response.status, 200, aac.body.error);
  assert.strictEqual(aac.body.fileName, "tone.aac");
  const aacPath = await downloadResult(aac.body, "tone.aac");
  const aacHeader = fs.readFileSync(aacPath);
  assert.strictEqual(aacHeader[0], 0xff, "aac must start with ADTS syncword");
  assert.strictEqual(aacHeader[1] & 0xf0, 0xf0, "aac must start with ADTS syncword");

  const opus = await uploadConvert(sourcePath, "tone.wav", "opus", "audio/wav");
  assert.strictEqual(opus.response.status, 200, opus.body.error);
  const opusPath = await downloadResult(opus.body, "tone.opus");
  assert.strictEqual(fs.readFileSync(opusPath).subarray(0, 4).toString("latin1"), "OggS", "opus must be in Ogg container");

  const wma = await uploadConvert(sourcePath, "tone.wav", "wma", "audio/wav");
  assert.strictEqual(wma.response.status, 200, wma.body.error);
  const wmaPath = await downloadResult(wma.body, "tone.wma");
  const wmaMagic = fs.readFileSync(wmaPath).subarray(0, 4);
  assert.deepStrictEqual([...wmaMagic], [0x30, 0x26, 0xb2, 0x75], "wma must start with ASF magic");

  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

async function createMinimalDocx(filePath, text) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(filePath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

// 生成带一张内嵌 PNG 的 docx（验证 docx→md 图片外置 .assets/）
async function createDocxWithImage(filePath, text, imageBuffer) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`), "word/_rels/document.xml.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="609600"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`), "word/document.xml");
  zip.addBuffer(imageBuffer, "word/media/image1.png");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(filePath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

test("converts a DOCX to Markdown without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "报告.docx");
  await createMinimalDocx(sourcePath, "Hello Markdown 你好");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "报告.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "报告.md");
  const outputPath = await downloadResult(body, "报告.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  assert.match(markdown, /Hello Markdown/);
  assert.match(markdown, /你好/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

// 生成带自定义中文标题样式的 docx（styles.xml 定义「一级标题/二级标题/半括号标题（五级）」，
// 验证 mammoth 默认不识别时能按 style-name 映射回 h1-h6，md 不丢大纲）
async function createDocxWithCustomHeadings(filePath, text) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Cust1"><w:name w:val="一级标题"/></w:style><w:style w:type="paragraph" w:styleId="Cust2"><w:name w:val="二级标题"/></w:style><w:style w:type="paragraph" w:styleId="Cust5"><w:name w:val="半括号标题（五级）"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`), "word/styles.xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Cust1"/></w:pPr><w:r><w:t>第一章 概述</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Cust2"/></w:pPr><w:r><w:t>第一节 背景</w:t></w:r></w:p><w:p><w:r><w:t>正文内容 ${text}</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Cust5"/></w:pPr><w:r><w:t>附录细节</w:t></w:r></w:p></w:body></w:document>`), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(filePath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

test("converts a DOCX with embedded images to Markdown with externalized asset files", async () => {
  const imagePath = path.join(scratchRoot, "docx-image.png");
  await createImage(imagePath, { r: 200, g: 40, b: 40, alpha: 1 }, 96, 64);
  const sourcePath = path.join(scratchRoot, "带图报告.docx");
  await createDocxWithImage(sourcePath, "图片外置测试 Image externalized", await fsp.readFile(imagePath));
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "带图报告.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "带图报告.md");
  assert.strictEqual(body.assetDirectoryName, "带图报告.assets");
  assert.ok(Array.isArray(body.assets), "payload must include assets list");
  assert.strictEqual(body.assets.length, 1, "one embedded image expected");
  assert.strictEqual(body.assets[0].name, "image-1.png");
  assert.match(body.assets[0].url, /^\/downloads\/[^/]+\/asset\/image-1\.png$/);

  const outputPath = await downloadResult(body, "带图报告.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  assert.doesNotMatch(markdown, /data:image\//, "md must not embed base64 images");
  assert.match(markdown, /!\[[^\]]*\]\(带图报告\.assets\/image-1\.png\)/, "md must reference the external asset");

  const assetResponse = await fetch(`${baseUrl}${body.assets[0].url}`);
  assert.strictEqual(assetResponse.status, 200);
  const assetBytes = Buffer.from(await assetResponse.arrayBuffer());
  assert.strictEqual(assetBytes.readUInt32BE(0), 0x89504e47, "asset must be a PNG");
  assert.deepStrictEqual(assetBytes, await fsp.readFile(imagePath), "asset bytes must match the source image");

  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a DOCX with custom Chinese heading styles to Markdown headings", async () => {
  const sourcePath = path.join(scratchRoot, "自定义标题.docx");
  await createDocxWithCustomHeadings(sourcePath, "正文段落 body text");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "自定义标题.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "自定义标题.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  // 自定义中文样式名（一级标题/二级标题/半括号标题（五级））必须映射为 md 标题，大纲不丢
  assert.match(markdown, /^# 第一章 概述$/m);
  assert.match(markdown, /^## 第一节 背景$/m);
  assert.match(markdown, /^##### 附录细节$/m);
  assert.match(markdown, /正文内容 正文段落 body text/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

// 生成带 WPS/Word 自动编号的 docx：标题样式（一级标题/二级标题）挂 numPr
// 引用 numbering.xml 的多级编号（第 %1 章 / %1.%2），标题文本本身不含编号。
async function createDocxWithAutoNumbering(filePath, text) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
  // styles.xml：一级标题 → numId=1/ilvl=0（第 %1 章），二级标题 → numId=1/ilvl=1（%1.%2）
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="一级标题"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="H2"><w:name w:val="二级标题"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`), "word/styles.xml");
  // numbering.xml：abstractNum 1 = 多级编号（第 %1 章 / %1.%2）
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="第 %1 章"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`), "word/numbering.xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>概述</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>背景</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>现状</w:t></w:r></w:p><w:p><w:r><w:t>正文 ${text}</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>深入</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>细节</w:t></w:r></w:p></w:body></w:document>`), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(filePath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

test("converts a DOCX with WPS auto-numbered headings to Markdown with number prefixes", async () => {
  const sourcePath = path.join(scratchRoot, "自动编号.docx");
  await createDocxWithAutoNumbering(sourcePath, "段落 body text");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "自动编号.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "自动编号.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  // 自动编号（第 X 章 / 1.1）不在标题文本里，必须从 numbering.xml 重算注入
  assert.match(markdown, /^# 第 1 章 概述$/m);
  assert.match(markdown, /^## 1\.1 背景$/m);
  assert.match(markdown, /^## 1\.2 现状$/m);
  assert.match(markdown, /^# 第 2 章 深入$/m);
  assert.match(markdown, /^## 2\.1 细节$/m);
  assert.match(markdown, /正文 段落 body text/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

// —— 2026-08-21 编号注入加固的回归测试 ——
// 通用 docx 构造器（带 numbering）：给定 styles/numbering/document 三个 XML 片段
// 打包成最小 docx。新增编号/样式回归用例共用，避免每个用例复制一份 yazl 收尾。
async function createNumberedDocx(filePath, stylesXml, numberingXml, documentXml) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
  zip.addBuffer(Buffer.from(stylesXml), "word/styles.xml");
  zip.addBuffer(Buffer.from(numberingXml), "word/numbering.xml");
  zip.addBuffer(Buffer.from(documentXml), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(filePath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

const DOCX_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const AUTO_NUMBERING_XML = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="第 %1 章"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

test("injectHeadingPrefixes skips fenced code blocks and keeps heading alignment (regression)", () => {
  const { injectHeadingPrefixes } = require("../office-convert");
  const prefixes = [
    { prefix: "第 1 章" },
    { prefix: "1.1" },
    { prefix: "1.2" }
  ];
  // ``` 与 ```lang 两种围栏内都放 # 开头行；围栏后紧跟下一个标题
  const md = [
    "# 概述",
    "",
    "## 背景",
    "",
    "```js",
    "# 代码行一",
    "### 代码行二",
    "```",
    "",
    "```",
    "# 代码行三",
    "```",
    "",
    "## 现状"
  ].join("\n");
  const out = injectHeadingPrefixes(md, prefixes);
  // 围栏外标题按序注入
  assert.match(out, /^# 第 1 章 概述$/m);
  assert.match(out, /^## 1\.1 背景$/m);
  // 围栏内的 # 行保持原样，不注入、不消耗索引
  assert.match(out, /^```js$/m);
  assert.match(out, /^# 代码行一$/m);
  assert.match(out, /^### 代码行二$/m);
  assert.match(out, /^# 代码行三$/m);
  assert.doesNotMatch(out, /# 1\.[12] 代码行|### 1\.1 代码行二/);
  // 围栏后的标题编号不受影响
  assert.match(out, /^## 1\.2 现状$/m);
});

test("injectHeadingPrefixes respects hand-typed numbering guards and prefix exhaustion", () => {
  const { injectHeadingPrefixes } = require("../office-convert");
  const md = [
    "# 第一章 概述",
    "",
    "# （1）要点",
    "",
    "# 深入",
    "",
    "# 超出数组的标题"
  ].join("\n");
  const out = injectHeadingPrefixes(md, [{ prefix: "第 1 章" }, { prefix: "第 2 章" }, { prefix: "第 3 章" }]);
  // 手打编号不重复注入；纯文本标题正常注入；前缀数组耗尽后不再注入
  assert.match(out, /^# 第一章 概述$/m);
  assert.match(out, /^# （1）要点$/m);
  assert.match(out, /^# 第 3 章 深入$/m);
  assert.match(out, /^# 超出数组的标题$/m);
  assert.doesNotMatch(out, /第 1 章 第一章|第 2 章 （1）|第 3 章 超出/);
});

test("skips heading styles with single quotes in styleMap and numbering consistently (regression: count mismatch shifted numbers)", async () => {
  const sourcePath = path.join(scratchRoot, "引号样式名.docx");
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="H1Q"><w:name w:val="标题 1'"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="一级标题"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="H2"><w:name w:val="二级标题"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const document = `<w:document ${DOCX_NS}><w:body><w:p><w:pPr><w:pStyle w:val="H1Q"/></w:pPr><w:r><w:t>引言</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>概述</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>背景</w:t></w:r></w:p></w:body></w:document>`;
  await createNumberedDocx(sourcePath, styles, AUTO_NUMBERING_XML, document);

  const { response, body } = await uploadConvert(sourcePath, "引号样式名.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "引号样式名.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  // 含 ' 的样式名无法进 styleMap → mammoth 输出普通段落，不占编号位；
  // 编号计算必须同样跳过，否则后续标题编号整体错位
  assert.match(markdown, /^引言$/m);
  assert.match(markdown, /^# 第 1 章 概述$/m);
  assert.match(markdown, /^## 1\.1 背景$/m);
  assert.doesNotMatch(markdown, /第 2 章/);
});

test("expands each %N with its own level numFmt and renders inactive levels as 零 (regression: mixed formats)", async () => {
  const sourcePath = path.join(scratchRoot, "混排编号.docx");
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="一级标题"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="H2"><w:name w:val="二级标题"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  // ilvl0 用罗马数字（%1.），ilvl1 用 decimal（%1.%2.%3），%3 引用 chineseCounting 但文档从未出现 3 级标题 → 0 → 零
  const numbering = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%3"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const document = `<w:document ${DOCX_NS}><w:body><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>概述</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>背景</w:t></w:r></w:p></w:body></w:document>`;
  await createNumberedDocx(sourcePath, styles, numbering, document);

  const { response, body } = await uploadConvert(sourcePath, "混排编号.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "混排编号.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  // %1 用 ilvl0 的 upperRoman → I；%2 用 ilvl1 的 decimal → 1；%3 未激活 → 零
  assert.match(markdown, /^# I\. 概述$/m);
  assert.match(markdown, /^## I\.1\.零 背景$/m);
});

test("does not double-inject numbering into headings that already carry hand-typed numbers", async () => {
  const sourcePath = path.join(scratchRoot, "手打编号.docx");
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="一级标题"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const numbering = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="第 %1 章"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const document = `<w:document ${DOCX_NS}><w:body><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>第一章 概述</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>（1）要点</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>深入</w:t></w:r></w:p></w:body></w:document>`;
  await createNumberedDocx(sourcePath, styles, numbering, document);

  const { response, body } = await uploadConvert(sourcePath, "手打编号.docx", "md", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "手打编号.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  // 手打「第一章」「（1）」的标题不重复注入；纯文本标题正常注入（计数器仍按文档序推进 → 第 3 章）
  assert.match(markdown, /^# 第一章 概述$/m);
  assert.match(markdown, /^# （1）要点$/m);
  assert.match(markdown, /^# 第 3 章 深入$/m);
  assert.doesNotMatch(markdown, /第 1 章 第一章|第 2 章 （1）/);
});

test("converts Markdown to DOCX without changing the source", async () => {
  const sourcePath = path.join(scratchRoot, "文档.md");
  await fsp.writeFile(sourcePath, "# 标题\n\n正文内容 line one.", "utf8");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "文档.md", "docx", "text/markdown");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "文档.docx");
  const outputPath = await downloadResult(body, "文档.docx");
  assertZipWithEntry(outputPath, /word\/document\.xml/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a DOCX to plain text without LibreOffice txt export", async () => {
  const sourcePath = path.join(scratchRoot, "纯文本.docx");
  await createMinimalDocx(sourcePath, "提取这段文字 Extract me");
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "纯文本.docx", "txt", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "纯文本.txt");
  const outputPath = await downloadResult(body, "纯文本.txt");
  const text = await fsp.readFile(outputPath, "utf8");
  assert.match(text, /提取这段文字/);
  assert.match(text, /Extract me/);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts a DOCX to PDF via LibreOffice", async () => {
  const sourcePath = path.join(scratchRoot, "文档转PDF.docx");
  await createMinimalDocx(sourcePath, "Fresh isolated profile PDF content 2026");
  const beforeHash = hashFile(sourcePath);
  const processesBefore = sofficeProcessIds();

  const { response, body } = await uploadConvert(sourcePath, "文档转PDF.docx", "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "文档转PDF.pdf");
  const outputPath = await downloadResult(body, "文档转PDF.pdf");
  assertPdf(outputPath);
  assert.strictEqual(hashFile(sourcePath), beforeHash);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const leakedProcesses = [...sofficeProcessIds()].filter((pid) => !processesBefore.has(pid));
  assert.deepStrictEqual(leakedProcesses, [], `LibreOffice left child processes behind: ${leakedProcesses.join(", ")}`);
  const runtimeEntries = await fsp.readdir(isolatedRuntimeRoot).catch(() => []);
  assert.deepStrictEqual(runtimeEntries.filter((name) => name.startsWith("office-")), [], "isolated Office profiles must be removed");
});





test("zip conversion honors compression level and reports sizes", async () => {
  const sourcePath = path.join(scratchRoot, "压缩样本.txt");
  await fsp.writeFile(sourcePath, "compress me ".repeat(4000), "utf8");
  const beforeHash = hashFile(sourcePath);

  async function convertZip(level) {
    const form = new FormData();
    form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "text/plain" }), "压缩样本.txt");
    form.append("targetFormat", "zip");
    if (level != null) form.append("compressionLevel", String(level));
    const response = await apiFetch("/api/convert", { method: "POST", body: form });
    const body = await parseBody(response);
    assert.strictEqual(response.status, 200, body.error);
    return body;
  }

  const store = await convertZip(0);
  const max = await convertZip(9);

  assert.ok(store.originalBytes > 0, "zip response must report originalBytes");
  assert.ok(store.compressedBytes > 0, "zip response must report compressedBytes");
  assert.ok(typeof store.compressionRatio === "number", "zip response must report compressionRatio");

  const storePath = await downloadResult(store, "store.zip");
  const maxPath = await downloadResult(max, "max.zip");
  const storeSize = (await fsp.stat(storePath)).size;
  const maxSize = (await fsp.stat(maxPath)).size;
  assert.ok(maxSize < storeSize, `level 9 (${maxSize}) must be smaller than level 0 (${storeSize}) for text`);
  assert.ok(max.compressionRatio > store.compressionRatio, "level 9 ratio must exceed level 0 ratio");
  assert.strictEqual(hashFile(sourcePath), beforeHash);

  const defaultZip = await convertZip(null);
  assert.strictEqual(defaultZip.fileName, "压缩样本.zip");
});

// ---- v0.3.5 审计修复回归：BMP/CSV-MD/XML/YAML/HTML-DOCX/XLSX-CSV/扫描PDF-DOCX ----

function makeBmp2x2() {
  const rowBytes = 8;
  const pixelBytes = rowBytes * 2;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(2, 18);
  out.writeInt32LE(2, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);
  Buffer.from([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0]).copy(out, 54);
  return out;
}

// 构造带命名空间前缀 workbook.xml 的 XLSX（exceljs 4.4.0 无法解析此类文件，
// 用于验证 XLSX->CSV 预检降级 + LibreOffice 实际转换）。
function makePrefixedXlsx(filePath) {
  const yazl = require("yazl");
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`), "_rels/.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets><x:sheet name="Summary" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></x:sheets></x:workbook>`), "xl/workbook.xml");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`), "xl/_rels/workbook.xml.rels");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>商品</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="B2"><v>2</v></c></row>
</sheetData></worksheet>`), "xl/worksheets/sheet1.xml");
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

test("converts BMP to PNG (sharp cannot read BMP; custom decoder required)", async () => {
  const sourcePath = path.join(scratchRoot, "pixels.bmp");
  await fsp.writeFile(sourcePath, makeBmp2x2());
  const beforeHash = hashFile(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "pixels.bmp", "png", "image/bmp");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "pixels.png");
  const outputPath = await downloadResult(body, "pixels.png");
  const header = fs.readFileSync(outputPath).subarray(1, 4).toString("latin1");
  assert.strictEqual(header, "PNG", "BMP output must be a PNG");
  assert.strictEqual(hashFile(sourcePath), beforeHash);
});

test("converts CSV to real Markdown table (not the raw CSV passthrough)", async () => {
  const sourcePath = path.join(scratchRoot, "multiline.csv");
  await fsp.writeFile(sourcePath, '"name","description"\n"Mouse","Line one\nLine two"\n', "utf8");

  const { response, body } = await uploadConvert(sourcePath, "multiline.csv", "md", "text/csv");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "multiline.md");
  const markdown = await fsp.readFile(outputPath, "utf8");
  assert.match(markdown, /^\| name \| description \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| Mouse \| Line one<br>Line two \|/);
});

test("converts XML to parsed JSON instead of a text wrapper", async () => {
  const sourcePath = path.join(scratchRoot, "tree.xml");
  await fsp.writeFile(sourcePath, '<root><item id="1">Mouse</item></root>\n', "utf8");

  const { response, body } = await uploadConvert(sourcePath, "tree.xml", "json", "application/xml");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "tree.json");
  const json = await fsp.readFile(outputPath, "utf8");
  assert.match(json, /"item"/);
  assert.match(json, /"@id": "1"/);
  assert.doesNotMatch(json, /"text"/);
});

test("converts YAML to parsed JSON instead of a text wrapper", async () => {
  const sourcePath = path.join(scratchRoot, "record.yaml");
  await fsp.writeFile(sourcePath, "name: Mouse\ncount: 2\n", "utf8");

  const { response, body } = await uploadConvert(sourcePath, "record.yaml", "json", "application/yaml");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "record.json");
  const json = await fsp.readFile(outputPath, "utf8");
  assert.match(json, /"name": "Mouse"/);
  assert.match(json, /"count": 2/);
  assert.doesNotMatch(json, /"text"/);
});

test("converts HTML to DOCX preserving headings and list items", async () => {
  const sourcePath = path.join(scratchRoot, "structure.html");
  await fsp.writeFile(sourcePath, "<h1>Hello</h1><ul><li>A</li><li>B</li></ul>\n", "utf8");

  const { response, body } = await uploadConvert(sourcePath, "structure.html", "docx", "text/html");

  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "structure.docx");
  const packageBytes = await fsp.readFile(outputPath);
  assert.strictEqual(packageBytes.readUInt32LE(0), 0x04034b50);
  const documentXml = readZipEntry(packageBytes, "word/document.xml");
  assert.match(documentXml, /<w:sz w:val="36"/, "h1 must keep heading size");
  assert.match(documentXml, /Hello/);
  const bullets = (documentXml.match(/•/g) || []).length;
  assert.ok(bullets >= 2, `expected 2 list bullets, got ${bullets}`);
});

test("converts a namespace-prefixed XLSX to CSV despite exceljs preview failure", async () => {
  const sourcePath = path.join(scratchRoot, "prefixed.xlsx");
  await makePrefixedXlsx(sourcePath);

  const { response, body } = await uploadConvert(sourcePath, "prefixed.xlsx", "csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  assert.strictEqual(response.status, 200, body.error);
  assert.ok(Array.isArray(body.warnings), "preview degradation must surface a warning");
  assert.ok(body.warnings.some((warning) => warning.code === "XLSX_CSV_PREVIEW_UNAVAILABLE"), "warning list must include XLSX_CSV_PREVIEW_UNAVAILABLE");
  const outputPath = await downloadResult(body, "prefixed.csv");
  const csv = await fsp.readFile(outputPath, "utf8");
  assert.match(csv, /商品/);
  assert.match(csv, /苹果/);
});
