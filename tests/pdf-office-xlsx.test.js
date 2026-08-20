const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ExcelJS = require("exceljs");
const sharp = require("sharp");
const yazl = require("yazl");
const { openZipEntries } = require("../zip-util");
const {
  HARD_TABLE_CONFIDENCE,
  REVIEW_CELL_CONFIDENCE,
  validatePdfOfficeXlsx,
  writePdfOfficeXlsx
} = require("../pdf-office-xlsx");

async function png(filePath, width = 827, height = 1169, color = "#f5f7fa") {
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(filePath);
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-xlsx-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await png(path.join(root, "page-001.png"));
  await png(path.join(root, "page-002.png"), 900, 1200, "#eef3f8");
  return root;
}

function table(id, confidence, cells, rowCount = 3, columnCount = 4) {
  return {
    id,
    rowCount,
    columnCount,
    bbox: [100, 400, 1500, 1200],
    confidence,
    cells
  };
}

function cell(row, column, text, confidence = 0.96, rowSpan = 1, columnSpan = 1) {
  return {
    row,
    column,
    rowSpan,
    columnSpan,
    bbox: [100 + column * 300, 400 + row * 200, 400 + column * 300, 600 + row * 200],
    text,
    confidence
  };
}

function manifest() {
  const first = table("table-A", 0.93, [
    cell(0, 0, "匿名数据", 0.99, 1, 4),
    cell(1, 0, "编号"), cell(1, 1, "金额"), cell(1, 2, "日期"), cell(1, 3, "状态"),
    cell(2, 0, "00123"), cell(2, 1, "12.50"), cell(2, 2, "2026-08-13"),
    cell(2, 3, "待复核", 0.82)
  ]);
  const second = table("table-B", 0.91, [
    cell(0, 0, "项目", 0.98), cell(0, 1, "数量", 0.98),
    cell(1, 0, "Alpha", 0.94), cell(1, 1, "2", 0.94)
  ], 2, 2);
  return {
    schemaVersion: 1,
    engine: { name: "anonymous-engine", version: "3.7.0", language: "ch" },
    pages: [
      {
        pageNumber: 1, width: 1653, height: 2339, rotation: 0, referenceImage: "page-001.png",
        classification: "scanned", warnings: ["BOUNDED_WARNING"], elapsedMs: 10,
        blocks: [{ type: "table", bbox: first.bbox, tableId: first.id, confidence: first.confidence }],
        tables: [first]
      },
      {
        pageNumber: 2, width: 1653, height: 2339, rotation: 0, referenceImage: "page-002.png",
        classification: "mixed", warnings: [], elapsedMs: 12,
        blocks: [{ type: "table", bbox: second.bbox, tableId: second.id, confidence: second.confidence }],
        tables: [second]
      }
    ]
  };
}

function outputInvalid(error, privateValue = "") {
  return error?.code === "PDF_OFFICE_OUTPUT_INVALID"
    && typeof error.messages?.zhCN === "string"
    && typeof error.messages?.enUS === "string"
    && (!privateValue || !JSON.stringify(error).includes(privateValue));
}

async function loadWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

async function rewriteZipEntry(inputPath, outputPath, entryName, mutate, additions = []) {
  const zipfile = await openZipEntries(inputPath);
  const entries = await new Promise((resolve, reject) => {
    const collected = [];
    zipfile.on("entry", (entry) => {
      if (entry.fileName.endsWith("/")) {
        zipfile.readEntry();
        return;
      }
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          collected.push({ name: entry.fileName, buffer: Buffer.concat(chunks) });
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("end", () => resolve(collected));
    zipfile.on("error", reject);
    zipfile.readEntry();
  });
  const archive = new yazl.ZipFile();
  const output = fsSync.createWriteStream(outputPath);
  const completed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
  });
  archive.outputStream.pipe(output);
  for (const entry of entries) {
    archive.addBuffer(entry.name === entryName ? mutate(entry.buffer) : entry.buffer, entry.name);
  }
  for (const entry of additions) archive.addBuffer(entry.buffer, entry.name);
  archive.end();
  await completed;
}

async function createZip(outputPath, entries) {
  const archive = new yazl.ZipFile();
  const output = fsSync.createWriteStream(outputPath);
  const completed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
  });
  archive.outputStream.pipe(output);
  for (const entry of entries) archive.addBuffer(entry.buffer, entry.name);
  archive.end();
  await completed;
}

async function patchZipHeaders(filePath, patch) {
  const bytes = await fs.readFile(filePath);
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) patch(bytes, offset, "local");
    if (signature === 0x02014b50) patch(bytes, offset, "central");
  }
  await fs.writeFile(filePath, bytes);
}

async function patchZipEntryDeclaredSize(filePath, entryName, declaredSize) {
  const bytes = await fs.readFile(filePath);
  let patched = false;
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const nameOffset = offset + 46;
    if (bytes.subarray(nameOffset, nameOffset + nameLength).toString() !== entryName) continue;
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const localOffset = bytes.readUInt32LE(offset + 42);
    bytes.writeUInt32LE(declaredSize, offset + 24);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const flags = bytes.readUInt16LE(localOffset + 6);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    if (flags & 0x0008) {
      const descriptorOffset = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
      const hasSignature = bytes.readUInt32LE(descriptorOffset) === 0x08074b50;
      bytes.writeUInt32LE(declaredSize, descriptorOffset + (hasSignature ? 12 : 8));
    } else {
      bytes.writeUInt32LE(declaredSize, localOffset + 22);
    }
    patched = true;
    break;
  }
  assert.equal(patched, true);
  await fs.writeFile(filePath, bytes);
}

async function validateInvalidZip(root, fileName, input = manifest()) {
  const packagePath = path.join(root, fileName);
  await assert.rejects(validatePdfOfficeXlsx(packagePath, { manifest: input, assetRoot: root }), outputInvalid);
}

test("uses the documented hard and review confidence thresholds", () => {
  assert.equal(HARD_TABLE_CONFIDENCE, 0.65);
  assert.equal(REVIEW_CELL_CONFIDENCE, 0.85);
});

test("writes deterministic structured sheets, exact recognized strings, merges, review records, metadata and references", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "anonymous.xlsx");
  const result = await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath });
  assert.deepEqual(result.sheetNames, ["识别说明", "P001-T01", "P002-T01", "待核对", "原件对照"]);
  assert.equal(result.referenceImageCount, 2);
  assert.equal(result.reviewCellCount, 1);

  const workbook = await loadWorkbook(outputPath);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), result.sheetNames);
  const sheet = workbook.getWorksheet("P001-T01");
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.columnCount, 4);
  assert.ok(sheet.getCell("A1").isMerged);
  assert.equal(sheet.getCell("A1").value, "匿名数据");
  assert.equal(sheet.getCell("A3").value, "00123");
  assert.equal(sheet.getCell("A3").numFmt, "@");
  assert.equal(sheet.getCell("B3").value, "12.50");
  assert.equal(sheet.getCell("B3").numFmt, "@");
  assert.equal(sheet.getCell("C3").value, "2026-08-13");
  assert.equal(sheet.getCell("C3").numFmt, "@");
  assert.equal(sheet.getCell("D3").fill.fgColor.argb, "FFFFE2A8");
  assert.ok(sheet.getCell("D3").note);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.equal(sheet.views[0].state, "frozen");

  const review = workbook.getWorksheet("待核对");
  assert.deepEqual(review.getRow(2).values.slice(1), [1, "P001-T01", "D3", "待复核", 0.82, "第 1 页"]);
  const info = workbook.getWorksheet("识别说明");
  assert.equal(info.getCell("B3").value, "anonymous-engine");
  assert.equal(info.getCell("B4").value, "3.7.0");
  assert.equal(info.getCell("B5").value, "ch");
  assert.equal(info.getCell("B6").value, HARD_TABLE_CONFIDENCE);
  assert.equal(info.getCell("B7").value, REVIEW_CELL_CONFIDENCE);
  assert.deepEqual(info.getRow(11).values.slice(1), [1, "scanned", 1, 0.93, 1, 10, "BOUNDED_WARNING"]);
  assert.deepEqual(info.getRow(12).values.slice(1), [2, "mixed", 1, 0.91, 0, 12, "无 / None"]);
  const references = workbook.getWorksheet("原件对照");
  assert.equal(references.getImages().length, 2);
  assert.equal(references.pageSetup.orientation, "portrait");
  assert.equal(references.pageSetup.fitToWidth, 1);
});

test("names multiple tables on one page deterministically", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages = [input.pages[0]];
  input.pages[0].tables.push(structuredClone(input.pages[0].tables[0]));
  input.pages[0].tables[1].id = "table-C";
  input.pages[0].blocks.push({ type: "table", bbox: [100, 1300, 1500, 2100], tableId: "table-C", confidence: 0.93 });
  const outputPath = path.join(root, "multiple.xlsx");
  const result = await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath });
  assert.deepEqual(result.tableSheets, ["P001-T01", "P001-T02"]);
});

test("fails closed when no tables are present", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  for (const page of input.pages) { page.tables = []; page.blocks = []; }
  await assert.rejects(
    writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath: path.join(root, "none.xlsx") }),
    (error) => Boolean(error?.code === "PDF_TABLE_NOT_DETECTED" && error.messages?.zhCN && error.messages?.enUS)
  );
});

test("rejects any required table below the hard confidence threshold", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[1].tables[0].confidence = HARD_TABLE_CONFIDENCE - 0.01;
  await assert.rejects(
    writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath: path.join(root, "low.xlsx") }),
    (error) => Boolean(error?.code === "PDF_TABLE_OCR_LOW_QUALITY" && error.messages?.zhCN && error.messages?.enUS)
  );
});

test("preserves an existing output when building or validation fails", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "existing.xlsx");
  const sentinel = Buffer.from("existing-user-output");
  await fs.writeFile(outputPath, sentinel);
  const input = manifest();
  input.pages[0].referenceImage = "missing.png";
  await assert.rejects(writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath }), outputInvalid);
  assert.deepEqual(await fs.readFile(outputPath), sentinel);

  await assert.rejects(
    writePdfOfficeXlsx({
      manifest: manifest(), assetRoot: root, outputPath,
      validateWorkbook: async () => { throw new Error("private validation detail"); }
    }),
    (error) => outputInvalid(error, "private validation detail")
  );
  assert.deepEqual(await fs.readFile(outputPath), sentinel);
});

test("rolls back a pre-existing output when atomic publish fails", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "rollback.xlsx");
  const sentinel = Buffer.from("existing-user-output");
  await fs.writeFile(outputPath, sentinel);
  let renames = 0;
  const fileSystem = {
    ...fs,
    async rename(from, to) {
      renames += 1;
      if (renames === 2) throw new Error("private rename detail");
      return fs.rename(from, to);
    }
  };
  await assert.rejects(writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath, fileSystem }), outputInvalid);
  assert.deepEqual(await fs.readFile(outputPath), sentinel);
  assert.equal((await fs.readdir(root)).some((name) => name.includes(".tmp-") || name.includes(".backup-")), false);
});

test("validator detects damaged required structure, review semantics and reference images", async (t) => {
  const root = await workspace(t);
  const basePath = path.join(root, "valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: basePath });
  for (const [name, mutate] of [
    ["missing-info", (workbook) => workbook.removeWorksheet(workbook.getWorksheet("识别说明").id)],
    ["wrong-value", (workbook) => { workbook.getWorksheet("P001-T01").getCell("B3").value = 12.5; }],
    ["missing-merge", (workbook) => workbook.getWorksheet("P001-T01").unMergeCells("A1:D1")],
    ["missing-highlight", (workbook) => { workbook.getWorksheet("P001-T01").getCell("D3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } }; }],
    ["missing-review", (workbook) => workbook.getWorksheet("待核对").spliceRows(2, 1)],
    ["wrong-reference-label", (workbook) => { workbook.getWorksheet("原件对照").getCell("A2").value = "伪造页码"; }],
    ["missing-reference", (workbook) => { workbook.getWorksheet("原件对照")._media = []; }]
  ]) {
    const workbook = await loadWorkbook(basePath);
    mutate(workbook);
    const damaged = path.join(root, `${name}.xlsx`);
    await workbook.xlsx.writeFile(damaged);
    await assert.rejects(validatePdfOfficeXlsx(damaged, { manifest: manifest(), assetRoot: root }), outputInvalid, name);
  }
});

test("validator binds each sequential embedded reference image to trusted source bytes", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "valid-images.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  const workbook = await loadWorkbook(validPath);
  const images = workbook.getWorksheet("原件对照").getImages();
  const privateSentinel = "private-recognized-image-path";
  const tampered = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#000000" } }).png().toBuffer();
  workbook.getImage(images[0].imageId).buffer = tampered;
  const tamperedPath = path.join(root, `${privateSentinel}.xlsx`);
  await workbook.xlsx.writeFile(tamperedPath);
  await assert.rejects(
    validatePdfOfficeXlsx(tamperedPath, { manifest: manifest(), assetRoot: root }),
    (error) => outputInvalid(error, privateSentinel)
  );
});

test("validator requires exact per-page classification, table confidence, warning details and timing", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "valid-summary.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  for (const [name, mutate] of [
    ["classification", (sheet) => { sheet.getCell("B11").value = "native"; }],
    ["table-count", (sheet) => { sheet.getCell("C11").value = 2; }],
    ["average-confidence", (sheet) => { sheet.getCell("D11").value = 0.99; }],
    ["warning-count", (sheet) => { sheet.getCell("E11").value = 0; }],
    ["duration", (sheet) => { sheet.getCell("F11").value = 999; }],
    ["warning-detail", (sheet) => { sheet.getCell("G11").value = "bogus-warning"; }]
  ]) {
    const workbook = await loadWorkbook(validPath);
    mutate(workbook.getWorksheet("识别说明"));
    const damaged = path.join(root, `${name}.xlsx`);
    await workbook.xlsx.writeFile(damaged);
    await assert.rejects(validatePdfOfficeXlsx(damaged, { manifest: manifest(), assetRoot: root }), outputInvalid, name);
  }
});

test("warning details are bounded and redact unsafe path-like or raw text", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  const privatePath = "C:\\private\\recognized-content.pdf";
  input.pages[0].warnings = ["SAFE_CODE", privatePath, "raw recognized sentence with spaces", "secretword", ...Array.from({ length: 20 }, (_, index) => `W${index}`)];
  const outputPath = path.join(root, "bounded-warnings.xlsx");
  await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath });
  const workbook = await loadWorkbook(outputPath);
  const detail = String(workbook.getWorksheet("识别说明").getCell("G11").value);
  assert.ok(detail.length <= 256);
  assert.ok(detail.includes("SAFE_CODE"));
  assert.ok(detail.includes("[redacted]"));
  assert.ok(!detail.includes(privatePath));
  assert.ok(!detail.includes("raw recognized sentence"));
  assert.ok(!detail.includes("secretword"));
});

test("warning count preserves all 12 warnings while details remain bounded to the first 8", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[0].warnings = Array.from({ length: 12 }, (_, index) => `WARNING_${String(index + 1).padStart(2, "0")}`);
  const outputPath = path.join(root, "twelve-warnings.xlsx");
  await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath });
  const workbook = await loadWorkbook(outputPath);
  const info = workbook.getWorksheet("识别说明");
  const detail = String(info.getCell("G11").value);
  assert.equal(info.getCell("E11").value, 12);
  for (let index = 1; index <= 8; index += 1) assert.ok(detail.includes(`WARNING_${String(index).padStart(2, "0")}`));
  assert.ok(detail.includes("+4"));
  assert.ok(!detail.includes("WARNING_09"));
  assert.ok(!detail.includes("WARNING_12"));
  assert.ok(detail.length <= 256);
});

test("validator enforces exact bidirectional review highlights, notes and rows", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "valid-review.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  for (const [name, mutate] of [
    ["unexpected-highlight", (workbook) => { workbook.getWorksheet("P001-T01").getCell("B3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE2A8" } }; }],
    ["unexpected-note", (workbook) => { workbook.getWorksheet("P001-T01").getCell("B3").note = "bogus"; }],
    ["extra-review-row", (workbook) => { workbook.getWorksheet("待核对").addRow([9, "P999-T99", "A1", "bogus", 0.8, "第 9 页"]); }]
  ]) {
    const workbook = await loadWorkbook(validPath);
    mutate(workbook);
    const damaged = path.join(root, `${name}.xlsx`);
    await workbook.xlsx.writeFile(damaged);
    await assert.rejects(validatePdfOfficeXlsx(damaged, { manifest: manifest(), assetRoot: root }), outputInvalid, name);
  }

  const noReview = manifest();
  noReview.pages[0].tables[0].cells.at(-1).confidence = 0.9;
  const noReviewPath = path.join(root, "zero-review.xlsx");
  await writePdfOfficeXlsx({ manifest: noReview, assetRoot: root, outputPath: noReviewPath });
  const workbook = await loadWorkbook(noReviewPath);
  workbook.getWorksheet("P001-T01").getCell("B3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE2A8" } };
  workbook.getWorksheet("P001-T01").getCell("B3").note = "bogus";
  workbook.getWorksheet("待核对").addRow([1, "P001-T01", "B3", "bogus", 0.8, "第 1 页"]);
  const damaged = path.join(root, "zero-review-bogus.xlsx");
  await workbook.xlsx.writeFile(damaged);
  await assert.rejects(validatePdfOfficeXlsx(damaged, { manifest: noReview, assetRoot: root }), outputInvalid);
});

test("zero-review validation rejects an isolated missing A2:F2 merge", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[0].tables[0].cells.at(-1).confidence = 0.9;
  const validPath = path.join(root, "zero-review-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath: validPath });
  const workbook = await loadWorkbook(validPath);
  workbook.getWorksheet("待核对").unMergeCells("A2:F2");
  const damagedPath = path.join(root, "zero-review-unmerged.xlsx");
  await workbook.xlsx.writeFile(damagedPath);
  await assert.rejects(validatePdfOfficeXlsx(damagedPath, { manifest: input, assetRoot: root }), outputInvalid);
});

test("zero-review validation rejects isolated independent B2 content under the expected merge", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[0].tables[0].cells.at(-1).confidence = 0.9;
  const validPath = path.join(root, "zero-review-valid-b2.xlsx");
  await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath: validPath });
  const damagedPath = path.join(root, "zero-review-b2-content.xlsx");
  await rewriteZipEntry(validPath, damagedPath, "xl/worksheets/sheet4.xml", (buffer) => {
    const xml = buffer.toString("utf8");
    const mutated = xml.replace(
      /(<row\b[^>]*\br="2"[^>]*>[\s\S]*?)(<\/row>)/,
      '$1<c r="B2" t="inlineStr"><is><t>bogus</t></is></c>$2'
    );
    assert.notEqual(mutated, xml);
    return Buffer.from(mutated, "utf8");
  });
  await assert.rejects(validatePdfOfficeXlsx(damagedPath, { manifest: input, assetRoot: root }), outputInvalid);
});

test("zero-review validation rejects an isolated annotation on merged master A2", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[0].tables[0].cells.at(-1).confidence = 0.9;
  const validPath = path.join(root, "zero-review-valid-master-note.xlsx");
  await writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath: validPath });
  const workbook = await loadWorkbook(validPath);
  workbook.getWorksheet("待核对").getCell("A2").note = "bogus";
  const damagedPath = path.join(root, "zero-review-master-note.xlsx");
  await workbook.xlsx.writeFile(damagedPath);
  await assert.rejects(validatePdfOfficeXlsx(damagedPath, { manifest: input, assetRoot: root }), outputInvalid);
});

test("ZIP preflight rejects duplicate, unsafe, oversized and compression-bomb entries before ExcelJS", async (t) => {
  const root = await workspace(t);
  const duplicatePath = path.join(root, "duplicate.xlsx");
  await createZip(duplicatePath, [
    { name: "a.xml", buffer: Buffer.from("<a/>") },
    { name: "b.xml", buffer: Buffer.from("<b/>") }
  ]);
  await patchZipHeaders(duplicatePath, (bytes, offset, kind) => {
    const nameLengthOffset = kind === "local" ? 26 : 28;
    const nameOffset = offset + (kind === "local" ? 30 : 46);
    const nameLength = bytes.readUInt16LE(offset + nameLengthOffset);
    if (bytes.subarray(nameOffset, nameOffset + nameLength).toString() === "b.xml") Buffer.from("a.xml").copy(bytes, nameOffset);
  });
  await validateInvalidZip(root, "duplicate.xlsx");

  const unsafePath = path.join(root, "unsafe.xlsx");
  await createZip(unsafePath, [{ name: "xl/a.xml", buffer: Buffer.from("<a/>") }]);
  await patchZipHeaders(unsafePath, (bytes, offset, kind) => {
    const nameOffset = offset + (kind === "local" ? 30 : 46);
    Buffer.from("../a.xml").copy(bytes, nameOffset);
  });
  await validateInvalidZip(root, "unsafe.xlsx");

  const oversizedPath = path.join(root, "oversized.xlsx");
  await createZip(oversizedPath, [{ name: "xl/workbook.xml", buffer: Buffer.from("<workbook/>") }]);
  await patchZipHeaders(oversizedPath, (bytes, offset, kind) => {
    bytes.writeUInt32LE(32 * 1024 * 1024, offset + (kind === "local" ? 22 : 24));
  });
  await validateInvalidZip(root, "oversized.xlsx");

  const bombPath = path.join(root, "ratio-bomb.xlsx");
  await createZip(bombPath, [{ name: "xl/workbook.xml", buffer: Buffer.alloc(512 * 1024) }]);
  await validateInvalidZip(root, "ratio-bomb.xlsx");

  const validPath = path.join(root, "valid-with-extra-entry.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  const validBombPath = path.join(root, "valid-ratio-bomb.xlsx");
  await rewriteZipEntry(validPath, validBombPath, "[Content_Types].xml", (buffer) => buffer, [
    { name: "xl/unused-bomb.bin", buffer: Buffer.alloc(512 * 1024) }
  ]);
  let excelJsLoaded = false;
  const OriginalWorkbook = ExcelJS.Workbook;
  ExcelJS.Workbook = class extends OriginalWorkbook {
    constructor(...args) { excelJsLoaded = true; super(...args); }
  };
  try { await validateInvalidZip(root, "valid-ratio-bomb.xlsx"); }
  finally { ExcelJS.Workbook = OriginalWorkbook; }
  assert.equal(excelJsLoaded, false);

  const excessiveEntriesPath = path.join(root, "too-many-entries.xlsx");
  await createZip(excessiveEntriesPath, Array.from({ length: 2049 }, (_, index) => ({
    name: `entries/e${String(index).padStart(4, "0")}.bin`, buffer: Buffer.alloc(0)
  })));
  await validateInvalidZip(root, "too-many-entries.xlsx");
});

test("ZIP preflight drains every binary entry and rejects lying actual size before ExcelJS", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "stream-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  const lyingPath = path.join(root, "lying-binary-entry.xlsx");
  await rewriteZipEntry(validPath, lyingPath, "[Content_Types].xml", (buffer) => buffer, [
    { name: "xl/unused.bin", buffer: Buffer.alloc(64 * 1024, 0x41) }
  ]);
  await patchZipEntryDeclaredSize(lyingPath, "xl/unused.bin", 1024);
  let excelJsLoaded = false;
  const OriginalWorkbook = ExcelJS.Workbook;
  ExcelJS.Workbook = class extends OriginalWorkbook {
    constructor(...args) { excelJsLoaded = true; super(...args); }
  };
  try { await assert.rejects(validatePdfOfficeXlsx(lyingPath, { manifest: manifest(), assetRoot: root }), outputInvalid); }
  finally { ExcelJS.Workbook = OriginalWorkbook; }
  assert.equal(excelJsLoaded, false);
});

test("package closure rejects orphan media and unexpected object relationships and parts", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "closure-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });

  const orphanPath = path.join(root, "orphan-media.xlsx");
  await rewriteZipEntry(validPath, orphanPath, "[Content_Types].xml", (buffer) => buffer, [
    { name: "xl/media/image999.png", buffer: await fs.readFile(path.join(root, "page-001.png")) }
  ]);
  await assert.rejects(validatePdfOfficeXlsx(orphanPath, { manifest: manifest(), assetRoot: root }), outputInvalid);

  const objectPath = path.join(root, "unexpected-object.xlsx");
  await rewriteZipEntry(validPath, objectPath, "xl/worksheets/_rels/sheet2.xml.rels", (buffer) => {
    const xml = buffer.toString("utf8");
    return Buffer.from(xml.replace("</Relationships>", '<Relationship Id="rIdObject" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/object1.bin"/></Relationships>'));
  }, [{ name: "xl/embeddings/object1.bin", buffer: Buffer.from("object") }]);
  await assert.rejects(validatePdfOfficeXlsx(objectPath, { manifest: manifest(), assetRoot: root }), outputInvalid);
});

test("worksheet XML allowlist rejects formulas, covered merged text and hidden cells", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "xml-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  const attacks = [
    ["formula", "xl/worksheets/sheet2.xml", (xml) => xml.replace(/(<c\b(?=[^>]*\br="B3")[^>]*>)/, "$1<f>1+1</f>")],
    ["covered-merge-text", "xl/worksheets/sheet2.xml", (xml) => xml.replace(/<c\b(?=[^>]*\br="B1")[^>]*\/>/, '<c r="B1" t="inlineStr"><is><t>hidden</t></is></c>')],
    ["hidden-G1", "xl/worksheets/sheet1.xml", (xml) => xml.replace(/<c\b(?=[^>]*\br="G1")[^>]*\/>/, '<c r="G1" t="inlineStr"><is><t>hidden</t></is></c>')],
    ["hidden-H1-reordered", "xl/worksheets/sheet1.xml", (xml) => xml.replace(/(<\/row>)/, '<c s="1" r="H1"/>$1')],
    ["hidden-H11", "xl/worksheets/sheet1.xml", (xml) => xml.replace(/(<row\b[^>]*\br="11"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="H11" t="inlineStr"><is><t>hidden</t></is></c>$2')],
    ["extra-column", "xl/worksheets/sheet1.xml", (xml) => xml.replace("</cols>", '<col min="8" max="8" width="1" hidden="1"/></cols>')],
    ["hyperlink", "xl/worksheets/sheet2.xml", (xml) => xml.replace("</worksheet>", '<hyperlinks><hyperlink ref="A1" location="P001-T01!A1"/></hyperlinks></worksheet>')]
  ];
  for (const [name, entryName, mutate] of attacks) {
    const damagedPath = path.join(root, `${name}.xlsx`);
    await rewriteZipEntry(validPath, damagedPath, entryName, (buffer) => {
      const xml = buffer.toString("utf8");
      const changed = mutate(xml);
      assert.notEqual(changed, xml, name);
      return Buffer.from(changed);
    });
    await assert.rejects(validatePdfOfficeXlsx(damagedPath, { manifest: manifest(), assetRoot: root }), outputInvalid, name);
  }
});

test("worksheet XML allowlist rejects comments on covered merged cells and external relationships", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "xml-rel-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  const workbook = await loadWorkbook(validPath);
  workbook.getWorksheet("P001-T01").getCell("B1").note = "hidden";
  const commentPath = path.join(root, "covered-comment.xlsx");
  await workbook.xlsx.writeFile(commentPath);
  await assert.rejects(validatePdfOfficeXlsx(commentPath, { manifest: manifest(), assetRoot: root }), outputInvalid);

  const externalPath = path.join(root, "external-relationship.xlsx");
  await rewriteZipEntry(validPath, externalPath, "xl/_rels/workbook.xml.rels", (buffer) => {
    const xml = buffer.toString("utf8");
    return Buffer.from(xml.replace("</Relationships>", '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.invalid/book.xlsx" TargetMode="External"/></Relationships>'));
  });
  await assert.rejects(validatePdfOfficeXlsx(externalPath, { manifest: manifest(), assetRoot: root }), outputInvalid);
});

test("worksheet XML allowlist requires exact merge sets on info, table, review and reference sheets", async (t) => {
  const root = await workspace(t);
  const validPath = path.join(root, "merge-valid.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: validPath });
  for (const [name, sheetName, merge] of [
    ["info", "识别说明", "C2:D2"],
    ["table", "P002-T01", "A1:B1"],
    ["review", "待核对", "A1:B1"],
    ["reference", "原件对照", "A3:B3"]
  ]) {
    const workbook = await loadWorkbook(validPath);
    workbook.getWorksheet(sheetName).mergeCells(merge);
    const damagedPath = path.join(root, `extra-merge-${name}.xlsx`);
    await workbook.xlsx.writeFile(damagedPath);
    await assert.rejects(validatePdfOfficeXlsx(damagedPath, { manifest: manifest(), assetRoot: root }), outputInvalid, name);
  }
});

test("rejects oversized or non-scalar engine metadata before writing", async (t) => {
  const root = await workspace(t);
  for (const [name, value] of [["oversized", "x".repeat(100_000)], ["object", { private: "value" }]]) {
    const input = manifest();
    input.engine.name = value;
    const outputPath = path.join(root, `metadata-${name}.xlsx`);
    await assert.rejects(writePdfOfficeXlsx({ manifest: input, assetRoot: root, outputPath }), outputInvalid);
    await assert.rejects(fs.lstat(outputPath), { code: "ENOENT" });
  }
});

test("accepts engine metadata at 256 characters and rejects 257", async (t) => {
  const root = await workspace(t);
  const accepted = manifest();
  accepted.engine.name = "x".repeat(256);
  const acceptedPath = path.join(root, "metadata-256.xlsx");
  await writePdfOfficeXlsx({ manifest: accepted, assetRoot: root, outputPath: acceptedPath });
  assert.equal((await loadWorkbook(acceptedPath)).getWorksheet("识别说明").getCell("B3").value.length, 256);

  const rejected = manifest();
  rejected.engine.name = "x".repeat(257);
  const rejectedPath = path.join(root, "metadata-257.xlsx");
  await assert.rejects(writePdfOfficeXlsx({ manifest: rejected, assetRoot: root, outputPath: rejectedPath }), outputInvalid);
  await assert.rejects(fs.lstat(rejectedPath), { code: "ENOENT" });
});

test("writes byte-deterministic XLSX packages for identical structured input", async (t) => {
  const root = await workspace(t);
  const first = path.join(root, "deterministic-a.xlsx");
  const second = path.join(root, "deterministic-b.xlsx");
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: first });
  await writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: second });
  // ExcelJS 底层 jszip 的 ZIP 条目时间戳为当前时间（跨秒生成即不同）——完整文件字节
  // 比较在慢速 runner 上偶发失败（mac x64 实证）。比较解压后的内容（真正确定性部分）。
  const readEntries = async (p) => {
    const zipfile = await openZipEntries(p);
    return new Promise((resolve, reject) => {
      const collected = [];
      zipfile.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => { collected.push({ name: entry.fileName, buffer: Buffer.concat(chunks) }); zipfile.readEntry(); });
        });
      });
      zipfile.on("end", () => resolve(collected));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  };
  assert.deepEqual(await readEntries(first), await readEntries(second));
});

test("validator rejects raw text or images without meaningful editable table data", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "raw-only.xlsx");
  const workbook = new ExcelJS.Workbook();
  for (const name of ["识别说明", "P001-T01", "待核对", "原件对照"]) workbook.addWorksheet(name);
  workbook.getWorksheet("P001-T01").getCell("A1").value = " ";
  workbook.getWorksheet("原件对照").addImage(workbook.addImage({ filename: path.join(root, "page-001.png"), extension: "png" }), "A1:D20");
  await workbook.xlsx.writeFile(outputPath);
  await assert.rejects(validatePdfOfficeXlsx(outputPath, { manifest: manifest(), assetRoot: root }), outputInvalid);
});

test("preflights table and asset resource bounds before allocation or reads", async (t) => {
  const root = await workspace(t);
  const oversized = manifest();
  oversized.pages[0].tables[0].rowCount = 20_001;
  await assert.rejects(writePdfOfficeXlsx({ manifest: oversized, assetRoot: root, outputPath: path.join(root, "rows.xlsx") }), outputInvalid);

  let readAttempted = false;
  const fileSystem = {
    ...fs,
    async lstat(filePath) {
      const info = await fs.lstat(filePath);
      if (filePath.endsWith("page-001.png")) return { ...info, size: 65 * 1024 * 1024, isFile: () => true, isSymbolicLink: () => false };
      return info;
    },
    async readFile(...args) { readAttempted = true; return fs.readFile(...args); }
  };
  await assert.rejects(writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: path.join(root, "asset.xlsx"), fileSystem }), outputInvalid);
  assert.equal(readAttempted, false);
});

test("rejects symlinked or escaping reference assets before reading", async (t) => {
  const root = await workspace(t);
  let readAttempted = false;
  const fileSystem = {
    ...fs,
    async lstat(filePath) {
      const info = await fs.lstat(filePath);
      if (filePath.endsWith("page-001.png")) return { ...info, isSymbolicLink: () => true };
      return info;
    },
    async readFile(...args) { readAttempted = true; return fs.readFile(...args); }
  };
  await assert.rejects(writePdfOfficeXlsx({ manifest: manifest(), assetRoot: root, outputPath: path.join(root, "link.xlsx"), fileSystem }), outputInvalid);
  assert.equal(readAttempted, false);
});

test("invalid packages and private failures use the bilingual redacted output error", async (t) => {
  const root = await workspace(t);
  const invalidPath = path.join(root, "not-xlsx.xlsx");
  await fs.writeFile(invalidPath, "private recognized content");
  await assert.rejects(validatePdfOfficeXlsx(invalidPath, { manifest: manifest(), assetRoot: root }), (error) => outputInvalid(error, "private recognized content"));
});
