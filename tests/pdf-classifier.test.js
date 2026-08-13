const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const {
  classifyDocument,
  classifyPageMetrics,
  classifyPdf
} = require("../pdf-classifier");
const { createScannedTablePdf } = require("./helpers/scanned-pdf-fixture");

test("classifies reliable text without a page image as native", () => {
  assert.equal(classifyPageMetrics({
    characterCount: 120,
    printableRatio: 1,
    imageCoverage: 0
  }), "native");
});

test("classifies non-empty printable short text without an image as native", () => {
  assert.equal(classifyPageMetrics({
    characterCount: 5,
    printableRatio: 1,
    imageCoverage: 0
  }), "native");
});

test("classifies an empty full-page image as scanned", () => {
  assert.equal(classifyPageMetrics({
    characterCount: 0,
    printableRatio: 0,
    imageCoverage: 1
  }), "scanned");
});

test("classifies one-character noise over a full-page image as scanned", () => {
  assert.equal(classifyPageMetrics({
    characterCount: 1,
    printableRatio: 1,
    imageCoverage: 1
  }), "scanned");
});

test("classifies documents with native and scanned pages as mixed", () => {
  const classification = classifyDocument([
    { characterCount: 120, printableRatio: 1, imageCoverage: 0 },
    { characterCount: 0, printableRatio: 0, imageCoverage: 1 }
  ]);

  assert.equal(classification.kind, "mixed");
  assert.deepEqual(classification.pages.map(({ pageNumber, kind }) => ({ pageNumber, kind })), [
    { pageNumber: 1, kind: "native" },
    { pageNumber: 2, kind: "scanned" }
  ]);
});

test("classifies an empty document as scanned", () => {
  assert.deepEqual(classifyDocument([]), { kind: "scanned", pages: [] });
});

test("classifies a generated image-only PDF using PDF.js operators", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-scan-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = await createScannedTablePdf(path.join(scratch, "scan.pdf"));

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "scanned");
  assert.equal(classification.pages.length, 1);
  assert.deepEqual(Object.keys(classification.pages[0]).sort(), [
    "characterCount",
    "imageCoverage",
    "kind",
    "pageNumber",
    "printableRatio"
  ]);
  assert.deepEqual(classification.pages[0], {
    pageNumber: 1,
    characterCount: 0,
    printableRatio: 0,
    imageCoverage: 1,
    kind: "scanned"
  });
});

test("classifies a generated text PDF using real text extraction", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-native-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "native.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595.28, 841.89]);
  page.drawText("FlyingMouse native PDF classifier fixture with reliable printable text.", {
    x: 72,
    y: 760,
    size: 16,
    font
  });
  await fsp.writeFile(inputPath, await document.save());

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "native");
  assert.equal(classification.pages[0].kind, "native");
  assert.ok(classification.pages[0].characterCount >= 24);
  assert.equal(classification.pages[0].printableRatio, 1);
  assert.equal(classification.pages[0].imageCoverage, 0);
});

test("classifies a generated short text-only PDF as native", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-short-native-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "short-native.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595.28, 841.89]);
  page.drawText("Item Qty", { x: 72, y: 760, size: 16, font });
  await fsp.writeFile(inputPath, await document.save());

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "native");
  assert.equal(classification.pages[0].kind, "native");
  assert.ok(classification.pages[0].characterCount > 0);
  assert.ok(classification.pages[0].characterCount < 24);
  assert.equal(classification.pages[0].printableRatio, 1);
  assert.equal(classification.pages[0].imageCoverage, 0);
});
