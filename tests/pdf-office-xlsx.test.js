const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ExcelJS = require("exceljs");
const sharp = require("sharp");
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
