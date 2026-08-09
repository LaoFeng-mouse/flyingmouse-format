"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  pdfTextContentToWords,
  normalizeOcrResult,
  detectTableLinesFromRaw,
  buildPdfTableWorkbook
} = require("../pdf-table-runtime");

test("converts PDF.js transforms to top-left words for normal and rotated viewports", () => {
  const textContent = { items: [{ str: "Mouse", transform: [1, 0, 0, 10, 20, 30], width: 40, height: 10 }] };
  const normal = pdfTextContentToWords({ textContent, viewport: { transform: [1, 0, 0, -1, 0, 100], scale: 1, rotation: 0 } });
  assert.deepEqual(normal, [{ text: "Mouse", x: 20, y: 60, width: 40, height: 10, confidence: 1 }]);

  const rotated = pdfTextContentToWords({ textContent, viewport: { transform: [0, 1, 1, 0, 0, 0], scale: 1, rotation: 90 } });
  assert.deepEqual(rotated, [{ text: "Mouse", x: 30, y: 20, width: 10, height: 40, confidence: 1 }]);
});

test("normalizes Tesseract blocks, paragraphs, lines and words without duplicates", () => {
  const leafA = {
    text: "A", confidence: 91, bbox: { x0: 2, y0: 3, x1: 12, y1: 13 },
    symbols: [{ text: "A", confidence: 99, bbox: { x0: 2, y0: 3, x1: 12, y1: 13 } }]
  };
  const leafB = { text: "B", confidence: 0.42, bbox: { x0: 20, y0: 3, x1: 30, y1: 13 } };
  const result = { data: {
    blocks: [{
      text: "A B", bbox: { x0: 2, y0: 3, x1: 30, y1: 13 },
      paragraphs: [{
        text: "A B", bbox: { x0: 2, y0: 3, x1: 30, y1: 13 },
        lines: [{ text: "A B", bbox: { x0: 2, y0: 3, x1: 30, y1: 13 }, words: [leafA, leafB] }]
      }]
    }],
    words: [leafA, leafB]
  } };
  assert.deepEqual(normalizeOcrResult(result), [
    { text: "A", x: 2, y: 3, width: 10, height: 10, confidence: 0.91 },
    { text: "B", x: 20, y: 3, width: 10, height: 10, confidence: 0.42 }
  ]);
});

test("detects long horizontal and vertical rules and merges thick adjacent pixels", () => {
  const width = 16;
  const height = 14;
  const data = Buffer.alloc(width * height, 255);
  const dark = (x, y) => { data[y * width + x] = 0; };
  for (let x = 2; x <= 13; x += 1) { dark(x, 3); dark(x, 4); }
  for (let y = 1; y <= 12; y += 1) { dark(7, y); dark(8, y); }
  const lines = detectTableLinesFromRaw({ data, width, height, channels: 1, minLengthRatio: 0.6 });
  assert.deepEqual(lines, [
    { x1: 2, y1: 3.5, x2: 13, y2: 3.5, thickness: 2 },
    { x1: 7.5, y1: 1, x2: 7.5, y2: 12, thickness: 2 }
  ]);
});

test("consumes PDF pages from an async iterable one page at a time", async () => {
  let yielded = 0;
  async function* pages() {
    yielded += 1;
    yield { pageNumber: 1, width: 10, height: 10, textContent: { items: [] }, viewport: { transform: [1, 0, 0, -1, 0, 10], scale: 1 } };
    yielded += 1;
    yield { pageNumber: 2, width: 10, height: 10, textContent: { items: [] }, viewport: { transform: [1, 0, 0, -1, 0, 10], scale: 1 } };
  }
  const seen = [];
  const model = await buildPdfTableWorkbook(pages(), {
    detectTablesOnPage: (page) => { seen.push({ page: page.pageNumber, yielded }); return { ...page, tables: [], rawRows: [], warnings: [] }; },
    buildWorkbookModel: (detected) => detected
  });
  assert.deepEqual(seen, [{ page: 1, yielded: 1 }, { page: 2, yielded: 2 }]);
  assert.equal(model.length, 2);
});

test("composes page extraction, OCR fallback, line detection and workbook building with injected dependencies", async () => {
  const calls = [];
  const detectTablesOnPage = (page) => {
    calls.push(page);
    return { pageNumber: page.pageNumber, source: page.source, tables: [], rawRows: [page.words.map((word) => word.text)], warnings: [] };
  };
  const buildWorkbookModel = (pages) => ({ pages, marker: "workbook" });
  const pages = [
    { pageNumber: 1, width: 100, height: 80, textContent: { items: [{ str: "Text", transform: [1, 0, 0, 8, 4, 20], width: 16, height: 8 }] }, viewport: { transform: [1, 0, 0, -1, 0, 80], scale: 1, rotation: 0 }, raw: { data: Buffer.alloc(80), width: 10, height: 8, channels: 1 } },
    { pageNumber: 2, width: 100, height: 80, textContent: { items: [] }, viewport: { transform: [1, 0, 0, -1, 0, 80], scale: 1, rotation: 0 } }
  ];
  const model = await buildPdfTableWorkbook(pages, {
    detectTablesOnPage,
    buildWorkbookModel,
    ocrPage: async ({ pageNumber }) => ({ data: { words: [{ text: `OCR${pageNumber}`, confidence: 80, bbox: { x0: 1, y0: 2, x1: 9, y1: 10 } }] } }),
    detectLines: () => [{ x1: 0, y1: 1, x2: 9, y2: 1 }]
  });
  assert.equal(model.marker, "workbook");
  assert.equal(calls[0].source, "pdf-text");
  assert.equal(calls[0].words[0].text, "Text");
  assert.deepEqual(calls[0].lines, [{ x1: 0, y1: 1, x2: 9, y2: 1 }]);
  assert.equal(calls[1].source, "ocr");
  assert.equal(calls[1].words[0].text, "OCR2");
});

test("uses OCR when a scanned page contains only ineffective embedded noise text", async () => {
  let detected;
  await buildPdfTableWorkbook([{
    pageNumber: 1, width: 100, height: 80,
    textContent: { items: [{ str: ".", transform: [1, 0, 0, 8, 4, 20], width: 2, height: 8 }] },
    viewport: { transform: [1, 0, 0, -1, 0, 80], scale: 1, rotation: 0 }
  }], {
    detectTablesOnPage: (page) => { detected = page; return { ...page, tables: [], rawRows: [], warnings: [] }; },
    buildWorkbookModel: (pages) => pages,
    ocrPage: async () => ({ data: { words: [{ text: "Mouse", confidence: 90, bbox: { x0: 1, y0: 2, x1: 20, y1: 12 } }] } })
  });
  assert.equal(detected.source, "ocr");
  assert.equal(detected.words[0].text, "Mouse");
});
