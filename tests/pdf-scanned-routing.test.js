const assert = require("assert/strict");
const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { test } = require("node:test");

const { convertPdf, convertStructuredPdf } = require("../pdf");
const { validateStructureManifest } = require("../pdf-structure-contract");
const { validatePdfOfficeDocx } = require("../pdf-office-docx");
const { validatePdfOfficeXlsx } = require("../pdf-office-xlsx");
const { createScannedTablePdf } = require("./helpers/scanned-pdf-fixture");

test("creates deterministic scanned PDF fixtures", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-fixture-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const firstPath = await createScannedTablePdf(path.join(scratch, "first.pdf"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const secondPath = await createScannedTablePdf(path.join(scratch, "second.pdf"));
  const [first, second] = await Promise.all([fsp.readFile(firstPath), fsp.readFile(secondPath)]);
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(sha256(first), sha256(second));
});

test("routes scanned DOCX through the structure converter", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-route-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = await createScannedTablePdf(path.join(scratch, "scan.pdf"));
  const outputPath = path.join(scratch, "scan.docx");
  const calls = [];
  const classification = { kind: "scanned", pages: [{ pageNumber: 1, kind: "scanned" }] };
  await convertPdf(inputPath, outputPath, "docx", {
    classifyPdf: async () => classification,
    convertStructuredPdf: async (args) => {
      calls.push(args);
      await fsp.writeFile(args.outputPath, "fake");
    }
  });
  assert.equal(calls.length, 1, "expected one structured conversion call");
  assert.equal(calls[0].inputPath, inputPath);
  assert.equal(calls[0].outputPath, outputPath);
  assert.equal(calls[0].target, "docx");
  assert.deepEqual(calls[0].classification, classification);
});

function structuredManifest({ tables = [], blocks = [], tableLike = tables.length > 0 } = {}) {
  return {
    schemaVersion: 1,
    engine: { name: "fixture", version: "1" },
    pages: [{
      pageNumber: 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page.png", tableLike, blocks, tables, warnings: []
    }]
  };
}

function acceptedTable() {
  return {
    id: "t1", rowCount: 2, columnCount: 2, bbox: [0, 0, 100, 50], confidence: 0.99,
    cells: [
      { row: 0, column: 0, rowSpan: 1, columnSpan: 1, bbox: [0, 0, 50, 25], text: "A", confidence: 0.99 },
      { row: 0, column: 1, rowSpan: 1, columnSpan: 1, bbox: [50, 0, 100, 25], text: "B", confidence: 0.99 },
      { row: 1, column: 0, rowSpan: 1, columnSpan: 1, bbox: [0, 25, 50, 50], text: "1", confidence: 0.99 },
      { row: 1, column: 1, rowSpan: 1, columnSpan: 1, bbox: [50, 25, 100, 50], text: "2", confidence: 0.99 }
    ]
  };
}

test("composes scanned and mixed structured DOCX/XLSX writers", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-structured-compose-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const manifest = structuredManifest({ tables: [acceptedTable()] });
  const seen = [];
  for (const target of ["docx", "xlsx"]) {
    const outputPath = path.join(scratch, `out.${target}`);
    await convertPdf("input.pdf", outputPath, target, {
      classifyPdf: async () => ({ kind: target === "docx" ? "mixed" : "scanned", pages: [] }),
      withStructuredPdf: async (_input, _options, consume) => consume(Object.freeze(manifest), scratch),
      [`writePdfOffice${target === "docx" ? "Docx" : "Xlsx"}`]: async ({ manifest: selected, outputPath: output }) => {
        seen.push({ target, selected });
        await fsp.writeFile(output, target);
      }
    });
    assert.equal(await fsp.readFile(outputPath, "utf8"), target);
  }
  assert.deepEqual(seen.map((item) => item.target), ["docx", "xlsx"]);
  assert.equal(manifest.pages[0].tables.length, 1, "composition must not mutate a frozen/source manifest");
});

test("structured XLSX rejects zero tables before output publication", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-zero-table-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.xlsx");
  let writerCalled = false;
  await assert.rejects(convertStructuredPdf({
    inputPath: "input.pdf", outputPath, target: "xlsx", options: {
      withStructuredPdf: async (_input, _options, consume) => consume(structuredManifest(), scratch),
      writePdfOfficeXlsx: async () => { writerCalled = true; }
    }
  }), (error) => error.code === "PDF_TABLE_NOT_DETECTED");
  assert.equal(writerCalled, false);
  assert.equal(await fsp.stat(outputPath).then(() => true, () => false), false);
});

test("structured XLSX rejects low-confidence table candidates before output publication", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-low-table-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.xlsx");
  const weak = acceptedTable();
  weak.source = "pp-structure-v3";
  weak.confidence = 0.2;
  weak.cells = weak.cells.map((cell) => ({ ...cell, confidence: 0.2, text: "" }));
  const manifest = structuredManifest({ tableLike: true });
  manifest.pages[0].tableCandidates = [weak];
  await assert.rejects(convertStructuredPdf({
    inputPath: "input.pdf", outputPath, target: "xlsx", options: {
      withStructuredPdf: async (_input, _options, consume) => consume(manifest, scratch),
      writePdfOfficeXlsx: async () => { throw new Error("writer must not run"); }
    }
  }), (error) => error.code === "PDF_TABLE_OCR_LOW_QUALITY");
  assert.equal(await fsp.stat(outputPath).then(() => true, () => false), false);
});

test("structured conversion preserves low-quality and invalid errors without creating nominal output", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-structured-errors-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  for (const code of ["PDF_TABLE_OCR_LOW_QUALITY", "PDF_STRUCTURE_SCHEMA_INVALID"]) {
    const outputPath = path.join(scratch, `${code}.xlsx`);
    const failure = Object.assign(new Error("private"), { code });
    await assert.rejects(convertStructuredPdf({
      inputPath: "input.pdf", outputPath, target: "xlsx", options: {
        withStructuredPdf: async () => { throw failure; }
      }
    }), (error) => error.code === code);
    assert.equal(await fsp.stat(outputPath).then(() => true, () => false), false);
  }
});

test("structured failures preserve a pre-existing destination byte-for-byte", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-preserve-structured-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  for (const failure of [
    Object.assign(new Error("schema"), { code: "PDF_STRUCTURE_SCHEMA_INVALID" }),
    Object.assign(new Error("quality"), { code: "PDF_TABLE_OCR_LOW_QUALITY" })
  ]) {
    const outputPath = path.join(scratch, `${failure.code}.xlsx`);
    await fsp.writeFile(outputPath, "KEEP");
    await assert.rejects(convertStructuredPdf({
      inputPath: "input.pdf", outputPath, target: "xlsx", options: {
        withStructuredPdf: async () => { throw failure; }
      }
    }), (error) => error.code === failure.code);
    assert.equal(await fsp.readFile(outputPath, "utf8"), "KEEP");
  }

  for (const target of ["docx", "xlsx"]) {
    const outputPath = path.join(scratch, `writer.${target}`);
    await fsp.writeFile(outputPath, "KEEP");
    const writer = async ({ outputPath: attemptPath }) => {
      assert.notEqual(attemptPath, outputPath);
      await fsp.writeFile(attemptPath, "PARTIAL");
      throw new Error("writer failed");
    };
    await assert.rejects(convertStructuredPdf({
      inputPath: "input.pdf", outputPath, target, options: {
        withStructuredPdf: async (_input, _options, consume) => consume(
          structuredManifest({ tables: [acceptedTable()] }), scratch),
        writePdfOfficeDocx: writer,
        writePdfOfficeXlsx: writer
      }
    }));
    assert.equal(await fsp.readFile(outputPath, "utf8"), "KEEP");
  }
});

test("actual structured writers accept a deeply frozen validated manifest without mutation", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-actual-office-compose-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fsp.writeFile(path.join(scratch, "page.png"), png);
  const input = structuredManifest({
    tables: [acceptedTable()],
    blocks: [
      { type: "paragraph", bbox: [0, 55, 100, 65], text: "Editable paragraph", confidence: 0.99 },
      { type: "table", bbox: [0, 0, 100, 50], tableId: "t1", confidence: 0.99 }
    ]
  });
  const manifest = validateStructureManifest(input, scratch);
  const before = JSON.stringify(manifest);

  const docxPath = path.join(scratch, "actual.docx");
  await convertStructuredPdf({
    inputPath: "input.pdf", outputPath: docxPath, target: "docx", options: {
      withStructuredPdf: async (_input, _options, consume) => consume(manifest, scratch)
    }
  });
  const docx = await validatePdfOfficeDocx(docxPath, { expectedReferenceImages: 1,
    expectedTables: [{ rows: 2, columns: 2 }] });
  assert.equal(docx.hasEditableContent, true);

  const xlsxPath = path.join(scratch, "actual.xlsx");
  await convertStructuredPdf({
    inputPath: "input.pdf", outputPath: xlsxPath, target: "xlsx", options: {
      withStructuredPdf: async (_input, _options, consume) => consume(manifest, scratch)
    }
  });
  const xlsx = await validatePdfOfficeXlsx(xlsxPath, { manifest, assetRoot: scratch });
  assert.ok(xlsx);
  assert.equal(JSON.stringify(manifest), before);
  assert.ok(Object.isFrozen(manifest.pages[0].tables[0].cells[0]));
});
