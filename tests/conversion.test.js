const assert = require("assert");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { after, before, test } = require("node:test");
const sharp = require("sharp");
const serverModule = process.env.FLYINGMOUSE_FORMAT_BASE_URL ? null : require("../server");

const scratchRoot = path.join(os.tmpdir(), `flyingmouse-format-tests-${process.pid}`);
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

function pdfObject(text) {
  return Buffer.from(text, "latin1");
}

async function createTextPdf(filePath) {
  const stream = "BT\n/F1 18 Tf\n40 110 Td\n(Quote Item Qty Price) Tj\n0 -26 Td\n(Apple 2 3.50) Tj\nET\n";
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

function assertZipWithEntry(filePath, expectedFragment) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    assert.strictEqual(header.toString("latin1"), "PK\u0003\u0004");
  } finally {
    fs.closeSync(fd);
  }
  const listing = execFileSync("tar", ["-tf", filePath], { encoding: "utf8" });
  assert.match(listing, expectedFragment);
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
  const sheet = workbook.worksheets[0];
  assert.ok(sheet, "xlsx 至少有一个工作表");
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1)));
  const joined = rows.map((row) => row.join(" ")).join("\n");
  assert.match(joined, /Quote/);
  assert.match(joined, /Apple/);
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
