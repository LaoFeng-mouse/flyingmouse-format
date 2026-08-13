const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const sharp = require("sharp");

const {
  classifyDocument,
  classifyPageMetrics,
  classifyPdf,
  rectangleUnionArea
} = require("../pdf-classifier");
const { createScannedTablePdf } = require("./helpers/scanned-pdf-fixture");

async function createImagePdf(outputPath, { text, images }) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([600, 800]);
  const png = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 35, g: 90, b: 160, alpha: 1 }
    }
  }).png().toBuffer();
  const image = await document.embedPng(png);
  for (const bounds of images) page.drawImage(image, bounds);
  if (text) page.drawText(text, { x: 72, y: 680, size: 16, font });
  await fsp.writeFile(outputPath, await document.save());
}

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

test("computes rectangle union area without double-counting overlaps", () => {
  assert.equal(rectangleUnionArea([
    { x0: 0, y0: 0, x1: 8, y1: 10 },
    { x0: 4, y0: 0, x1: 10, y1: 10 }
  ]), 100);
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

test("classifies short printable text with a small logo as native", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-logo-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "small-logo.pdf");
  await createImagePdf(inputPath, {
    text: "Item Qty",
    images: [{ x: 510, y: 710, width: 60, height: 60 }]
  });

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "native");
  assert.ok(classification.pages[0].imageCoverage > 0);
  assert.ok(classification.pages[0].imageCoverage < 0.7);
});

test("classifies one-character text over a full-page image as scanned", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-noise-overlay-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "noise-overlay.pdf");
  await createImagePdf(inputPath, {
    text: "X",
    images: [{ x: 0, y: 0, width: 600, height: 800 }]
  });

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "scanned");
  assert.ok(classification.pages[0].imageCoverage >= 0.7);
});

test("classifies reliable overlay text over a full-page image as scanned", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-text-overlay-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "text-overlay.pdf");
  await createImagePdf(inputPath, {
    text: "Printable overlay text that exceeds twenty-four characters",
    images: [{ x: 0, y: 0, width: 600, height: 800 }]
  });

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "scanned");
  assert.ok(classification.pages[0].characterCount >= 24);
  assert.ok(classification.pages[0].imageCoverage >= 0.7);
});

test("keeps two non-overlapping images below the page coverage threshold", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-two-images-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "two-images.pdf");
  await createImagePdf(inputPath, {
    text: "Item Qty",
    images: [
      { x: 20, y: 40, width: 250, height: 200 },
      { x: 330, y: 40, width: 250, height: 200 }
    ]
  });

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "native");
  assert.ok(classification.pages[0].imageCoverage > 0.2);
  assert.ok(classification.pages[0].imageCoverage < 0.7);
});
