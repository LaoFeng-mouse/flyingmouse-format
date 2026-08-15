const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState
} = require("pdf-lib");
const sharp = require("sharp");

const {
  classifyDocument,
  classifyPageMetrics,
  classifyPdf,
  imageCoverageFromOperators,
  rectangleUnionArea
} = require("../pdf-classifier");
const { loadPdfjs } = require("../pdfjs");
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

async function createRepeatedXObjectPdf(outputPath) {
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
  const imageName = page.node.newXObject("RepeatedImage", image.ref);
  for (const x of [20, 100, 180, 260]) {
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(60, 0, 0, 60, x, 40),
      drawObject(imageName),
      popGraphicsState()
    );
  }
  page.drawText("Item Qty", { x: 72, y: 680, size: 16, font });
  await fsp.writeFile(outputPath, await document.save());
}

function identityViewport(width = 100, height = 100) {
  return { width, height, transform: [1, 0, 0, 1, 0, 0] };
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

test("treats documents with only a few scanned pages (cover/illustration) as native", () => {
  // 单词书封面二维码页被判 scanned，其余 9 页文字 native（scanned 占比 10% < 20%）
  const pages = [
    { characterCount: 60, printableRatio: 1, imageCoverage: 1 },
    ...Array.from({ length: 9 }, () => ({ characterCount: 500, printableRatio: 1, imageCoverage: 0 }))
  ];
  const classification = classifyDocument(pages);

  assert.equal(classification.kind, "native");
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

test("measures optimized repeated image XObjects using pinned operator arguments", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.paintImageXObjectRepeat],
    argsArray: [["img_repeat", 20, 20, new Float32Array([0, 0, 30, 0, 60, 0])]]
  }, OPS, identityViewport());

  assert.equal(coverage, 0.12);
});

test("measures optimized repeated image masks including skew terms", async () => {
  const { OPS } = await loadPdfjs();
  const positions = new Float32Array(Array.from({ length: 10 }, (_, index) => [
    (index % 5) * 20,
    Math.floor(index / 5) * 20
  ]).flat());
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.paintImageMaskXObjectRepeat],
    argsArray: [[{ data: null, width: 1, height: 1 }, 10, 2, 0, 10, positions]]
  }, OPS, identityViewport());

  assert.ok(coverage > 0.1);
  assert.ok(coverage < 0.13);
});

test("measures ten optimized grouped image masks", async () => {
  const { OPS } = await loadPdfjs();
  const images = Array.from({ length: 10 }, (_, index) => ({
    data: null,
    width: 8,
    height: 8,
    interpolate: false,
    count: 1,
    transform: [10, 0, 0, 10, (index % 5) * 20, Math.floor(index / 5) * 20]
  }));
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.paintImageMaskXObjectGroup],
    argsArray: [[images]]
  }, OPS, identityViewport());

  assert.equal(coverage, 0.1);
});

test("measures ten optimized grouped inline images from their map transforms", async () => {
  const { OPS } = await loadPdfjs();
  const map = Array.from({ length: 10 }, (_, index) => ({
    transform: [10, 0, 0, 10, (index % 5) * 20, Math.floor(index / 5) * 20],
    x: index * 8,
    y: 1,
    w: 8,
    h: 8
  }));
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.paintInlineImageXObjectGroup],
    argsArray: [[{ width: 100, height: 10, data: null }, map]]
  }, OPS, identityViewport());

  assert.equal(coverage, 0.1);
});

test("measures a solid-color image mask as the transformed unit square", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.transform, OPS.paintSolidColorImageMask],
    argsArray: [[25, 0, 0, 20, 5, 10], []]
  }, OPS, identityViewport());

  assert.equal(coverage, 0.05);
});

test("applies a form matrix and intersects image bounds with the form bbox", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [
      OPS.paintFormXObjectBegin,
      OPS.transform,
      OPS.paintImageXObject,
      OPS.paintFormXObjectEnd,
      OPS.transform,
      OPS.paintImageXObject
    ],
    argsArray: [
      [new Float32Array([2, 0, 0, 2, 10, 10]), new Float32Array([0, 0, 20, 20])],
      [30, 0, 0, 30, 0, 0],
      ["form_image"],
      [],
      [10, 0, 0, 10, 80, 80],
      ["post_form_image"]
    ]
  }, OPS, identityViewport());

  assert.equal(coverage, 0.17);
});

test("keeps rotated and sheared image coverage finite and bounded", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[100, 50, 50, 100, -25, -25], ["rotated_image"]]
  }, OPS, identityViewport());

  assert.ok(Number.isFinite(coverage));
  assert.ok(coverage >= 0 && coverage <= 1);
});

test("keeps malformed graphics and form stacks bounded without throwing", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [
      OPS.restore,
      OPS.paintFormXObjectEnd,
      OPS.save,
      OPS.paintFormXObjectBegin,
      OPS.transform,
      OPS.paintImageXObject
    ],
    argsArray: [
      [],
      [],
      [],
      [[Infinity, 0, 0, 1, 0, 0], [0, 0, Number.NaN, 10]],
      [Number.NaN, 0, 0, 1, 0, 0],
      ["malformed_image"]
    ]
  }, OPS, identityViewport());

  assert.equal(coverage, 1);
});

test("fails closed for malformed nested form and graphics stacks", async () => {
  const { OPS } = await loadPdfjs();
  const coverage = imageCoverageFromOperators({
    fnArray: [
      OPS.paintFormXObjectBegin,
      OPS.paintFormXObjectBegin,
      OPS.save,
      OPS.paintImageXObject,
      OPS.paintFormXObjectEnd,
      OPS.paintFormXObjectEnd
    ],
    argsArray: [
      [null, new Float32Array([0, 0, 80, 80])],
      [new Float32Array([1, 0, 0, 1, 10, 10]), new Float32Array([0, 0, 20, 20])],
      [],
      ["nested_image"],
      [],
      []
    ]
  }, OPS, identityViewport());

  assert.equal(coverage, 1);
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

test("classifies a real PDF with repeated uses of the same image XObject", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-classifier-repeat-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "repeated-images.pdf");
  await createRepeatedXObjectPdf(inputPath);
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await fsp.readFile(inputPath)),
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });
  try {
    const pdf = await loadingTask.promise;
    const operatorList = await (await pdf.getPage(1)).getOperatorList();
    // The public OPLIST intent disables QueueOptimizer in this pinned PDF.js,
    // but the q/cm/Do/Q source sequence is eligible on streamed render paths.
    const imageIds = operatorList.fnArray.flatMap((operator, index) => (
      operator === pdfjs.OPS.paintImageXObject
        ? [operatorList.argsArray[index][0]]
        : []
    ));
    assert.ok(imageIds.length >= 3);
    assert.equal(new Set(imageIds).size, 1);
  } finally {
    await loadingTask.destroy();
  }

  const classification = await classifyPdf(inputPath);

  assert.equal(classification.kind, "native");
  assert.ok(classification.pages[0].imageCoverage > 0);
  assert.ok(classification.pages[0].imageCoverage < 0.7);
});
