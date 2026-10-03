"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const source = process.env.TEST_PDF_TABLE_SOURCE_DIR || path.resolve(__dirname, "..");
const { pdfTextContentToWords, normalizeOcrResult, buildPdfTableWorkbook } = require(path.join(source, "pdf-table-runtime"));
const { detectTablesOnPage, buildWorkbookModel } = require(path.join(source, "pdf-table-extractor"));

function textItem(str, fontName, x, y, width, size) {
  return { str, fontName, transform: [size, 0, 0, size, x, y], width, height: size };
}
function grid(xs = [20, 120, 220, 320], ys = [100, 140, 180]) {
  return [...xs.map(x => ({ x1: x, y1: ys[0], x2: x, y2: ys.at(-1) })),
    ...ys.map(y => ({ x1: xs[0], y1: y, x2: xs.at(-1), y2: y }))];
}
function word(text, x, y, width, style = { fontName: "仿宋", fontSizePt: 11 }) {
  return { text, x, y, width, height: 11, confidence: 1, style };
}
function page(words, extra = {}) {
  return detectTablesOnPage({ pageNumber: 1, width: 360, height: 260, source: "pdf-text", pagePointScale: 0.5, lines: grid(), words, ...extra });
}

test("PDF subset fonts retain their real families and point sizes at different render scales", () => {
  const textContent = { items: [textItem("甲", "f1", 20, 80, 12, 12), textItem("Total", "f2", 45, 80, 28, 9.5)],
    styles: { f1: { fontName: "ABSEKN+FangSong", fontFamily: "serif" }, f2: { fontName: "AUWCNV+TimesNewRomanPSMT", fontFamily: "serif", bold: false, italic: false } } };
  for (const scale of [1, 2.5]) {
    const words = pdfTextContentToWords({ textContent, viewport: { scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] } });
    assert.equal(words[0].style.fontName, "仿宋");
    assert.equal(words[0].style.sourceFontName, "ABSEKN+FangSong");
    assert.equal(words[0].style.fontSizePt, 12);
    assert.equal(words[1].style.fontName, "Times New Roman");
    assert.equal(words[1].style.fontSizePt, 9.5);
    assert.equal(words[1].style.bold, false);
    assert.equal(words[1].style.italic, false);
    assert.equal(words[0].width, 12 * scale);
  }
});

test("generic and opaque font metadata never invent a named font or a bold face", () => {
  const words = pdfTextContentToWords({ textContent: { items: [textItem("Family", "f1", 10, 30, 30, 10), textItem("Opaque", "f2", 50, 30, 30, 10)],
    styles: { f1: { fontFamily: "serif" }, f2: { fontFamily: "sans-serif", fontName: "QLRCZX+KSOFE4500885-Regular" } } }, viewport: { scale: 1, transform: [1, 0, 0, -1, 0, 100] } });
  assert.equal(words[0].style.fontFamily, "serif");
  assert.equal(words[0].style.fontName, undefined);
  assert.equal(words[0].style.bold, undefined);
  assert.equal(words[1].style.fontName, undefined);
  assert.equal(words[1].style.sourceFontName, "QLRCZX+KSOFE4500885-Regular");
  const detected = page(words);
  assert.ok(detected.warnings.some(value => /font/i.test(value)), "opaque font fallback must remain visible in model metadata");
});

test("rotation changes word geometry without changing font point size", () => {
  const [entry] = pdfTextContentToWords({ textContent: { items: [textItem("Italic", "f", 20, 30, 24, 8)], styles: { f: { fontName: "AAAAAA+Arial-ItalicMT", fontFamily: "sans-serif", italic: true } } },
    viewport: { scale: 2, transform: [0, 2, 2, 0, 0, 0] } });
  assert.equal(entry.style.fontSizePt, 8);
  assert.equal(entry.style.fontName, "Arial");
  assert.equal(entry.style.italic, true);
  assert.equal(entry.width, 16);
  assert.equal(entry.height, 48);
});

test("grid preserves cell fonts, exact text boxes and independently inferred left center right alignment", () => {
  const detected = page([word("L", 24, 112, 8), word("中间", 158, 112, 24, { fontName: "宋体", fontSizePt: 12 }), word("99", 300, 112, 16)]);
  const cells = detected.tables[0].cellStyles[0];
  assert.deepEqual(cells.map(cell => cell.horizontal), ["left", "center", "right"]);
  assert.deepEqual(cells[0].bbox, { x: 24, y: 112, width: 8, height: 11 });
  assert.equal(cells[1].style.fontName, "宋体");
  assert.equal(cells[1].style.fontSizePt, 12);
  assert.equal(detected.tables[0].cellStyles[1][0], null);
});

test("short off-center text and full-width text do not receive invented center alignment", () => {
  const cells = page([word("Short", 37, 112, 18), word("Wide", 120, 112, 100), word("Inset", 240, 112, 20)]).tables[0].cellStyles[0];
  assert.equal(cells[0].horizontal, undefined);
  assert.equal(cells[1].horizontal, undefined);
  assert.equal(cells[2].horizontal, undefined);
});

test("mixed fonts remain separate runs and common style excludes conflicting attributes", () => {
  const table = page([word("中文", 24, 112, 20, { fontName: "宋体", fontSizePt: 11, bold: false }), word("ABC", 49, 112, 25, { fontName: "Arial", fontSizePt: 9, bold: false })]).tables[0];
  const cell = table.cellStyles[0][0];
  assert.equal(cell.style.fontName, undefined);
  assert.equal(cell.style.fontSizePt, undefined);
  assert.equal(cell.style.bold, false);
  assert.deepEqual(cell.runs.map(run => run.style.fontName), ["宋体", "Arial"]);
  assert.equal(cell.runs.map(run => run.text).join(""), table.rows[0][0]);
  assert.equal(cell.runs[1].x, 49);
});

test("raw mixed text and its exact coordinates survive page-form cloning without shared mutable styles", () => {
  const detected = page([word("标题", 40.125, 40.25, 24, { fontName: "宋体", fontSizePt: 12 }), word("Report", 70.5, 40.25, 30, { fontName: "Arial", fontSizePt: 10 }), word("Cell", 24, 112, 30)]);
  const model = buildWorkbookModel([detected]);
  const sheet = model.sheets.find(item => item.pageForm);
  assert.equal(sheet.pagePointScale, 0.5);
  assert.equal(sheet.pageForm.pagePointScale, 0.5);
  assert.equal(sheet.pageForm.pageWidthPt, 180);
  const block = sheet.pageForm.beforeBlocks[0];
  assert.deepEqual([block.x, block.y, block.width, block.height], [40.125, 40.25, 60.375, 11]);
  assert.deepEqual(block.runs.map(run => run.style.fontName), ["宋体", "Arial"]);
  assert.equal(block.runs.map(run => run.text).join(""), block.text);
  block.runs[0].style.fontName = "Changed";
  sheet.cellStyles[0][0].style.fontName = "Changed";
  assert.equal(detected.rawBlocks[0].runs[0].style.fontName, "宋体");
  assert.equal(detected.tables[0].cellStyles[0][0].style.fontName, "仿宋");
});

test("native runtime carries an explicit viewport-to-point scale through the real model builder", async () => {
  const model = await buildPdfTableWorkbook([{ pageNumber: 1, textContent: { items: [textItem("Heading", "f", 20, 110, 40, 12), textItem("Cell", "f", 12, 67, 20, 11)], styles: { f: { fontName: "ABCDEF+SimSun", fontFamily: "serif" } } },
    viewport: { width: 360, height: 260, scale: 2, transform: [2, 0, 0, -2, 0, 260] }, raw: {} }], { detectLines: () => grid() });
  const sheet = model.sheets.find(item => item.pageForm);
  assert.ok(sheet, "known source geometry must form one editable page");
  assert.equal(sheet.pagePointScale, 0.5);
  assert.equal(sheet.pageForm.pageHeightPt, 130);
  assert.equal(sheet.cellStyles[0][0].style.fontSizePt, 11);
});

test("missing or invalid coordinate scale stays unknown and OCR supplies no invented font", () => {
  for (const scale of [undefined, 0, -1, Infinity, NaN]) {
    const detected = page([word("Title", 30, 30, 40), word("Cell", 24, 112, 30)], { pagePointScale: scale });
    const sheet = buildWorkbookModel([detected]).sheets.find(item => item.pageForm);
    assert.equal(sheet.pagePointScale, undefined);
    assert.equal(sheet.pageForm.pagePointScale, undefined);
  }
  const words = normalizeOcrResult({ words: [{ text: "OCR", confidence: 90, bbox: { x0: 24, y0: 112, x1: 44, y1: 123 } }] });
  const cell = page(words, { source: "ocr" }).tables[0].cellStyles[0][0];
  assert.deepEqual(cell.style, {});
  assert.equal(cell.horizontal, undefined);
});

test("merged cells infer alignment against the full merged area and preserve multiline run breaks", () => {
  const lines = grid([20, 120, 220], [100, 140, 180]);
  lines[1] = { x1: 120, y1: 140, x2: 120, y2: 180 };
  const detected = page([word("Centered", 90, 104, 60), word("第二行", 102, 120, 36)], { lines });
  const table = detected.tables[0];
  assert.deepEqual(table.merges[0], { startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
  assert.equal(table.cellStyles[0][0].horizontal, "center");
  assert.equal(table.rows[0][0], "Centered\n第二行");
  assert.equal(table.cellStyles[0][0].runs.map(run => run.text).join(""), "Centered\n第二行");
  assert.equal(table.cellStyles[0][1], null);
});

test("continued pages retain the data-row style while removing the repeated header style", () => {
  function segment(pageNumber, ys, label, size, scale) {
    return page([word("Index", 25, ys[0] + 10, 30), word("Value", 125, ys[0] + 10, 30),
      word(label, 25, ys[1] + 10, 10, { fontName: "Arial", fontSizePt: size }), word("Data", 125, ys[1] + 10, 30)],
    { pageNumber, pagePointScale: scale, lines: grid([20, 120, 220], ys) });
  }
  const first = segment(1, [170, 200, 240], "1", 8, 0.5);
  const second = segment(2, [10, 40, 80], "2", 10, 0.5);
  const sheet = buildWorkbookModel([first, second]).sheets.find(item => item.pages.length === 2);
  assert.equal(sheet.rows.length, 3);
  assert.equal(sheet.cellStyles.length, 3);
  assert.deepEqual(sheet.cellStyles.map(row => row[0].style.fontSizePt), [11, 8, 10]);
  assert.equal(sheet.cellStyles[2][0].runs[0].text, "2");
  assert.equal(sheet.pagePointScale, 0.5);
});

test("a continued table with different render scales cannot advertise one reliable point scale", () => {
  const first = page([word("Index", 25, 180, 30), word("Value", 125, 180, 30), word("1", 25, 215, 10)],
    { pageNumber: 1, lines: grid([20, 120, 220], [170, 200, 240]), pagePointScale: 0.5 });
  const second = page([word("Index", 25, 20, 30), word("Value", 125, 20, 30), word("2", 25, 55, 10)],
    { pageNumber: 2, lines: grid([20, 120, 220], [10, 40, 80]), pagePointScale: 1 });
  const sheet = buildWorkbookModel([first, second]).sheets.find(item => item.pages.length === 2);
  assert.equal(sheet.pagePointScale, undefined);
  assert.equal(sheet.pageWidthPt, undefined);
});

test("raw Chinese whitespace normalization is identical in plain text and styled runs", () => {
  const detected = page([word("中文 标题", 40, 40, 80), word("Cell", 24, 112, 30)]);
  const block = detected.rawBlocks[0];
  assert.equal(block.text, "中文标题");
  assert.equal(block.runs.map(run => run.text).join(""), "中文标题");
});

test("a clearly centered line anchors a nearly full-width companion with the same center", () => {
  for (const zoom of [1, 2.5]) {
    const words = [word("材料类别", 50, 106, 40), word("入库批次（登记）", 20.8, 122, 99)]
      .map(entry => ({ ...entry, x: entry.x * zoom, y: entry.y * zoom, width: entry.width * zoom, height: entry.height * zoom }));
    const detected = page(words, { width: 360 * zoom, height: 260 * zoom, pagePointScale: 1 / zoom,
      lines: grid([20, 120, 220].map(x => x * zoom), [100, 146, 190].map(y => y * zoom)) });
    assert.equal(detected.tables[0].cellStyles[0][0].horizontal, "center");
    assert.equal(detected.tables[0].rows[0][0], "材料类别\n入库批次（登记）");
  }
});

test("multiline centering requires one clear anchor and agreement from every line", () => {
  for (const words of [
    [word("Almost full", 20.8, 106, 99)],
    [word("Almost full", 20.8, 106, 99), word("Another full", 20.4, 122, 99)],
    [word("Centered", 50, 106, 40), word("Shifted", 21, 122, 88)],
    [word("Left aligned", 23, 106, 40), word("Almost full", 20.8, 122, 99)]
  ]) {
    const detected = page(words, { lines: grid([20, 120, 220], [100, 146, 190]) });
    assert.equal(detected.tables[0].cellStyles[0][0].horizontal, undefined);
  }
});

test("sub-point center differences do not erase an otherwise supported two-line center", () => {
  const detected = page([word("分类项目", 687.359, 106, 44.17), word("登记信息（说明）", 676.8, 122, 66.25)],
    { width: 850, lines: grid([675.36, 743.04, 810], [100, 146, 190]) });
  assert.equal(detected.tables[0].cellStyles[0][0].horizontal, "center");
});
