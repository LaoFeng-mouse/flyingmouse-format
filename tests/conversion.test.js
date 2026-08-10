const assert = require("assert");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
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
let server;
let baseUrl;

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    body: form
  });
  const body = await parseBody(response);
  return { response, body };
}

async function uploadImagesToPdf(files) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new Blob([await fsp.readFile(file.path)], { type: "image/png" }), file.name);
  }

  const response = await fetch(`${baseUrl}/api/convert-images-to-pdf`, {
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

test("scanned PDF table extraction uses OCR and preserves table values", async () => {
  const imagePath = path.join(scratchRoot, "scanned-table.png");
  await createScannedTableImage(imagePath);
  const imageToPdf = await uploadConvert(imagePath, "scanned-table.png", "pdf", "image/png");
  assert.strictEqual(imageToPdf.response.status, 200, imageToPdf.body.error);
  const pdfPath = await downloadResult(imageToPdf.body, "scanned-table.pdf");

  const { response, body } = await uploadConvert(pdfPath, "scanned-table.pdf", "xlsx", "application/pdf");
  assert.strictEqual(response.status, 200, body.error);
  const outputPath = await downloadResult(body, "scanned-table.xlsx");
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.ok(workbook.getWorksheet("识别说明"));
  assert.equal(workbook.worksheets.filter((sheet) => /^P001-T/.test(sheet.name)).length, 1);
  const tableSheet = workbook.worksheets.find((sheet) => /^P001-T/.test(sheet.name));
  assert.ok(tableSheet, "scanned PDF should produce a detected table sheet");
  const expected = [["Item", "Qty"], ["Apple", "2"], ["Banana", "3"]];
  let matches = 0;
  expected.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    const actual = String(tableSheet.getCell(rowIndex + 1, columnIndex + 1).value || "").trim();
    if (actual.toLocaleLowerCase() === value.toLocaleLowerCase()) matches += 1;
  }));
  assert.ok(matches / expected.flat().length >= 0.85, `OCR cell accuracy ${matches}/${expected.flat().length}`);
  const explanationValues = [];
  workbook.getWorksheet("识别说明").eachRow((row) => explanationValues.push(...row.values.slice(1).map(String)));
  assert.match(explanationValues.join(" "), /ocr/i);
  let hasLowConfidenceNote = false;
  tableSheet.eachRow((row) => row.eachCell((cell) => { if (cell.note) hasLowConfidenceNote = true; }));
  assert.ok(hasLowConfidenceNote, "low-confidence OCR cells should retain an Excel note");
});

test("audio files must not offer video container targets", async () => {
  const response = await fetch(`${baseUrl}/api/targets`, {
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
  const response = await fetch(`${baseUrl}/api/targets`, {
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

  const evilResponse = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: { Origin: "https://evil.example.com" },
    body: form
  });
  assert.strictEqual(evilResponse.status, 403, "cross-site origin must be rejected");

  const refererResponse = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: { Referer: "https://evil.example.com/page.html" },
    body: form
  });
  assert.strictEqual(refererResponse.status, 403, "cross-site referer must be rejected");
});

test("local-origin conversion requests are allowed", async () => {
  const sourcePath = path.join(scratchRoot, "local-origin.png");
  await createImage(sourcePath, { r: 20, g: 120, b: 200, alpha: 1 });
  const beforeHash = hashFile(sourcePath);

  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(sourcePath)], { type: "image/png" }), "local-origin.png");
  form.append("targetFormat", "jpg");

  const response = await fetch(`${baseUrl}/api/convert`, {
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
  const response = await fetch(`${baseUrl}/api/targets`, {
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
  const response = await fetch(`${baseUrl}/api/targets`, {
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
  const response = await fetch(`${baseUrl}/api/targets`, {
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

  const response = await fetch(`${baseUrl}/api/merge-pdfs`, { method: "POST", body: form });
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
  const mergedResponse = await fetch(`${baseUrl}/api/merge-pdfs`, { method: "POST", body: form });
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
  execFileSync("tar", ["-xf", zipPath, "-C", extractDir]);
  const { PDFDocument } = require("pdf-lib");
  const page1 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-001.pdf")));
  const page2 = await PDFDocument.load(await fsp.readFile(path.join(extractDir, "page-002.pdf")));
  assert.strictEqual(page1.getPageCount(), 1, "page-001 must be a single page");
  assert.strictEqual(page2.getPageCount(), 1, "page-002 must be a single page");
  assert.strictEqual(hashFile(twoPagePdf), beforeHash);
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

test("decrypts a standard NetEase NCM file to MP3 (real fixture required)", async (t) => {
  const fixture = path.join(__dirname, "fixtures", "sample.ncm");
  if (!fs.existsSync(fixture)) {
    t.skip("缺少真实 NCM fixture（官方网易云客户端下载，放入 tests/fixtures/sample.ncm）");
    return;
  }
  const beforeHash = hashFile(fixture);

  const { response, body } = await uploadConvert(fixture, "sample.ncm", "mp3", "application/octet-stream");

  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "sample.mp3");
  const outputPath = await downloadResult(body, "sample.mp3");
  const magic = fs.readFileSync(outputPath).subarray(0, 3);
  const isMp3 = magic.toString("latin1") === "ID3" || (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0);
  assert.ok(isMp3, `decrypted output must be a playable mp3, magic=${magic.toString("hex")}`);
  assert.strictEqual(hashFile(fixture), beforeHash);
});

test("decrypts a Kugou KGG file to audio (real fixture + key db required)", async (t) => {
  const fixture = path.join(__dirname, "fixtures", "sample.kgg");
  if (!fs.existsSync(fixture)) {
    t.skip("缺少真实 KGG fixture（酷狗客户端下载，放入 tests/fixtures/sample.kgg）");
    return;
  }
  const { candidateDbPaths } = require("../kgg-format");
  if (!candidateDbPaths()) {
    t.skip("缺少酷狗密钥库 KGMusicV3.db（%APPDATA%\\KuGou8\\ 下），无法解密 KGG");
    return;
  }
  const beforeHash = hashFile(fixture);

  const { response, body } = await uploadConvert(fixture, "sample.kgg", "mp3", "application/octet-stream");
  assert.strictEqual(response.status, 200, body.error);
  assert.strictEqual(body.fileName, "sample.mp3");
  const outputPath = await downloadResult(body, "sample.mp3");
  const magic = fs.readFileSync(outputPath).subarray(0, 3);
  const isMp3 = magic.toString("latin1") === "ID3" || (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0);
  assert.ok(isMp3, `decrypted output must be a playable mp3, magic=${magic.toString("hex")}`);
  assert.strictEqual(hashFile(fixture), beforeHash);
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
    const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
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
