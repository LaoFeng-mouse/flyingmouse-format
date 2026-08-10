const assert = require("node:assert/strict");
const { test } = require("node:test");

const { detectTablesOnPage, buildWorkbookModel } = require("../pdf-table-extractor");

function word(text, x, y, confidence = 1, width = 40, height = 14) {
  return { text, x, y, width, height, confidence };
}

test("detects a regular borderless table from repeated row and column anchors", () => {
  const page = detectTablesOnPage({
    pageNumber: 1,
    width: 320,
    height: 200,
    source: "text",
    words: [
      word("Item", 10, 10), word("Qty", 110, 10), word("Price", 210, 10),
      word("Apple", 10, 40), word("2", 110, 40), word("3.50", 210, 40),
      word("Banana", 10, 70), word("3", 110, 70), word("4.20", 210, 70)
    ]
  });

  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0].rows, [
    ["Item", "Qty", "Price"],
    ["Apple", "2", "3.50"],
    ["Banana", "3", "4.20"]
  ]);
  assert.deepEqual(page.tables[0].merges, []);
});

test("separates two borderless tables divided by a large vertical gap", () => {
  const page = detectTablesOnPage({
    pageNumber: 2,
    width: 300,
    height: 400,
    source: "text",
    words: [
      word("A", 10, 10), word("B", 120, 10),
      word("1", 10, 40), word("2", 120, 40),
      word("C", 10, 220), word("D", 120, 220),
      word("3", 10, 250), word("4", 120, 250)
    ]
  });
  assert.equal(page.tables.length, 2);
  assert.deepEqual(page.tables.map((table) => table.rows[0]), [["A", "B"], ["C", "D"]]);
});

test("separates multiple ruled tables and still detects a borderless table", () => {
  const grid = (left, top) => [
    ...[top, top + 30, top + 60].map((y) => ({ x1: left, y1: y, x2: left + 100, y2: y })),
    ...[left, left + 50, left + 100].map((x) => ({ x1: x, y1: top, x2: x, y2: top + 60 }))
  ];
  const page = detectTablesOnPage({
    pageNumber: 1, width: 400, height: 400, source: "text",
    lines: [...grid(0, 0), ...grid(200, 0)],
    words: [
      word("A", 5, 5), word("B", 55, 5), word("1", 5, 35), word("2", 55, 35),
      word("C", 205, 5), word("D", 255, 5), word("3", 205, 35), word("4", 255, 35),
      word("E", 10, 220), word("F", 130, 220), word("5", 10, 250), word("6", 130, 250)
    ]
  });
  assert.equal(page.tables.length, 3);
  assert.deepEqual(page.tables.map((table) => table.rows[0]), [["A", "B"], ["C", "D"], ["E", "F"]]);
});

test("grid lines infer a merged header cell", () => {
  const horizontal = [0, 30, 60, 90].map((y) => ({ x1: 0, y1: y, x2: 300, y2: y }));
  const vertical = [
    { x1: 0, y1: 0, x2: 0, y2: 90 },
    { x1: 100, y1: 30, x2: 100, y2: 90 },
    { x1: 200, y1: 0, x2: 200, y2: 90 },
    { x1: 300, y1: 0, x2: 300, y2: 90 }
  ];
  const page = detectTablesOnPage({
    pageNumber: 1,
    width: 300,
    height: 90,
    source: "text",
    lines: [...horizontal, ...vertical],
    words: [
      word("Merged header", 20, 8, 1, 150), word("C", 220, 8),
      word("A1", 20, 38), word("B1", 120, 38), word("C1", 220, 38),
      word("A2", 20, 68), word("B2", 120, 68), word("C2", 220, 68)
    ]
  });
  assert.equal(page.tables.length, 1);
  assert.deepEqual(page.tables[0].rows[0], ["Merged header", "", "C"]);
  assert.deepEqual(page.tables[0].merges, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]);
});

test("workbook model continues matching tables across pages and removes repeated headers", () => {
  const pages = [1, 2].map((pageNumber) => detectTablesOnPage({
    pageNumber,
    width: 250,
    height: 120,
    source: "text",
    words: [
      word("Name", 10, pageNumber === 1 ? 70 : 5), word("Value", 130, pageNumber === 1 ? 70 : 5),
      word(pageNumber === 1 ? "Mouse" : "Cat", 10, pageNumber === 1 ? 100 : 35), word(String(pageNumber), 130, pageNumber === 1 ? 100 : 35)
    ]
  }));
  const model = buildWorkbookModel(pages);
  assert.equal(model.sheets.length, 1);
  assert.equal(model.sheets[0].name, "P001-T01");
  assert.deepEqual(model.sheets[0].rows, [["Name", "Value"], ["Mouse", "1"], ["Cat", "2"]]);
  assert.deepEqual(model.sheets[0].pages, [1, 2]);
});

test("missing grid segments do not merge populated OCR rows into one cell", () => {
  const horizontal = [0, 30, 60, 90].map((y) => ({ x1: 0, y1: y, x2: 200, y2: y }));
  const vertical = [
    { x1: 0, y1: 0, x2: 0, y2: 90 },
    { x1: 100, y1: 0, x2: 100, y2: 90 },
    { x1: 200, y1: 0, x2: 200, y2: 90 }
  ];
  // The middle horizontal rule is missing only in column two. OCR still found
  // distinct values in both physical rows, so this is damage, not a merge.
  horizontal.splice(2, 1, { x1: 0, y1: 60, x2: 100, y2: 60 });
  const table = detectTablesOnPage({
    pageNumber: 1, width: 200, height: 90, source: "ocr", lines: [...horizontal, ...vertical],
    words: [
      word("H1", 10, 5), word("H2", 110, 5),
      word("A", 10, 35), word("480", 110, 35),
      word("B", 10, 65), word("240", 110, 65)
    ]
  }).tables[0];
  assert.deepEqual(table.rows.map((row) => row[1]), ["H2", "480", "240"]);
  assert.deepEqual(table.merges, []);
});

test("a damaged multirow product-name cell is recovered without merging sequence cells", () => {
  const horizontal = [0, 20, 40, 60, 80, 100].flatMap((y) => {
    if ([40, 60, 80].includes(y)) return [{ x1: 0, y1: y, x2: 50, y2: y }];
    return [{ x1: 0, y1: y, x2: 100, y2: y }];
  });
  const vertical = [0, 50, 100].map((x) => ({ x1: x, y1: 0, x2: x, y2: 100 }));
  const table = detectTablesOnPage({
    pageNumber: 1, width: 100, height: 100, source: "ocr", lines: [...horizontal, ...vertical],
    words: [
      word("序号", 5, 2), word("产品名称", 55, 2),
      word("1", 5, 22), word("A005", 55, 42),
      word("2", 5, 42), word("3", 5, 62), word("4", 5, 82)
    ]
  }).tables[0];
  assert.deepEqual(table.rows.slice(1).map((row) => row[0]), ["1", "2", "3", "4"]);
  assert.deepEqual(table.merges, [{ startRow: 1, startCol: 1, endRow: 4, endCol: 1 }]);
});

test("OCR product tables repair unit price and quantity only when totals prove the arithmetic", () => {
  const xs = [0, 70, 140, 210];
  const ys = [0, 30, 60, 90, 120];
  const page = detectTablesOnPage({
    pageNumber: 1, width: 210, height: 120, source: "ocr",
    lines: [
      ...ys.map((y) => ({ x1: 0, y1: y, x2: 210, y2: y })),
      ...xs.map((x) => ({ x1: x, y1: 0, x2: x, y2: 120 }))
    ],
    words: [
      word("单价", 5, 5), word("数量", 75, 5), word("金额", 145, 5),
      word("53", 5, 35), word("120", 75, 35), word("3816", 145, 35),
      word("53", 5, 65), word("7120", 75, 65), word("3816", 145, 65),
      word("8.95", 5, 95), word("1152", 75, 95), word("4550.4", 145, 95)
    ]
  });
  assert.deepEqual(page.tables[0].rows.slice(1), [
    ["5.3", "720", "3816"],
    ["5.3", "720", "3816"],
    ["3.95", "1152", "4550.4"]
  ]);
  assert.match(page.warnings.join("\n"), /arithmetic consistency/i);
});

test("workbook model continues numbered ruled rows when the next page omits the header", () => {
  const table = (rows, top, bottom) => ({
    rows,
    merges: [],
    cellConfidence: rows.map((row) => row.map(() => 0.9)),
    confidence: 0.9,
    pages: [1],
    columnAnchors: [10, 40, 80, 140],
    bounds: { left: 10, top, right: 140, bottom }
  });
  const model = buildWorkbookModel([
    { pageNumber: 1, width: 150, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      table([["序", "产品", "数量"], ["11", "Circus Girl", "480"], ["12", "Christmas", "480"]], 40, 190)
    ] },
    { pageNumber: 2, width: 150, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      table([["13", "Ocean", "720"], ["14", "Halloween", "960"]], 2, 80)
    ] }
  ]);
  assert.equal(model.sheets.length, 1);
  assert.deepEqual(model.sheets[0].rows.map((row) => row[0]), ["序", "11", "12", "13", "14"]);
  assert.deepEqual(model.sheets[0].pages, [1, 2]);
});

test("workbook model continues a ruled product table when OCR loses row numbers but keeps a repeated code column", () => {
  const table = (rows, top, bottom, pageNumber) => ({
    kind: "grid",
    rows,
    merges: [],
    cellConfidence: rows.map((row) => row.map(() => 0.8)),
    confidence: 0.8,
    pages: [pageNumber],
    columnAnchors: [10, 40, 90, 150],
    bounds: { left: 10, top, right: 150, bottom }
  });
  const model = buildWorkbookModel([
    { pageNumber: 1, width: 160, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      table([["", "CHJ-XZD1-A", "480"], ["", "CHJ-XZD1-B", "480"]], 40, 195, 1)
    ] },
    { pageNumber: 2, width: 160, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      table([["13", "CHJ-XZD1-C", "720"], ["14", "CHJ-XZD1-D", "960"]], 2, 80, 2)
    ] }
  ]);
  assert.equal(model.sheets.length, 1);
  assert.deepEqual(model.sheets[0].pages, [1, 2]);
  assert.equal(model.sheets[0].rows.length, 4);
});

test("continued OCR tables apply arithmetic repair using the first-page header", () => {
  const make = (rows, top, bottom, pageNumber) => ({
    kind: "grid", rows, merges: [], confidence: 0.8, pages: [pageNumber],
    cellConfidence: rows.map((row) => row.map(() => 0.8)),
    columnAnchors: [0, 50, 100, 150, 200], bounds: { left: 0, top, right: 200, bottom }
  });
  const model = buildWorkbookModel([
    { pageNumber: 1, width: 200, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      make([["SKU", "单价", "数量", "金额"], ["CODE-X1", "5.3", "480", "2544"], ["CODE-X2", "5.3", "720", "3816"]], 20, 195, 1)
    ] },
    { pageNumber: 2, width: 200, height: 200, source: "ocr", warnings: [], rawRows: [], tables: [
      make([["CODE-X3", "53", "120", "3816"]], 2, 60, 2)
    ] }
  ]);
  assert.equal(model.sheets.length, 1);
  assert.deepEqual(model.sheets[0].rows.at(-1), ["CODE-X3", "5.3", "720", "3816"]);
  assert.match(model.warnings.join("\n"), /arithmetic consistency/i);
});

test("a dominant sequential index repairs OCR noise after page continuation", () => {
  const rows = [["序号", "名称"], ["", "A"], ["2", "B"], ["ig", "C"], ["4", "D"], ["5 |", "E"]];
  const model = buildWorkbookModel([{ pageNumber: 1, width: 100, height: 100, source: "ocr", warnings: [], rawRows: [], tables: [{
    kind: "grid", rows, merges: [], confidence: 0.8, pages: [1],
    cellConfidence: rows.map((row) => row.map(() => 0.8)), columnAnchors: [0, 50, 100],
    bounds: { left: 0, top: 0, right: 100, bottom: 100 }
  }] }]);
  assert.deepEqual(model.sheets[0].rows.slice(1).map((row) => row[0]), ["1", "2", "3", "4", "5"]);
  assert.match(model.warnings.join("\n"), /sequence/i);
});

test("wide OCR prose alignment is retained as Raw instead of advertised as a table", () => {
  const words = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 14; column += 1) {
      words.push(word(`w${row}-${column}`, 10 + column * 20, 10 + row * 30, 0.8, 14));
    }
  }
  const page = detectTablesOnPage({ pageNumber: 2, width: 320, height: 200, source: "ocr", words });
  assert.equal(page.tables.length, 0);
  assert.match(page.rawRows.flat().join(" "), /w0-0/);
  assert.match(page.rawRows.flat().join(" "), /w3-13/);
});

test("two-line OCR watermark alignment is retained as Raw", () => {
  const page = detectTablesOnPage({
    pageNumber: 2, width: 320, height: 120, source: "ocr",
    words: [
      word("扫描", 10, 10), word("全", 70, 10), word("能", 130, 10), word("王", 190, 10),
      word("watermark", 10, 40), word("id", 190, 40)
    ]
  });
  assert.equal(page.tables.length, 0);
  assert.match(page.rawRows.flat().join(" "), /扫描/);
});

test("workbook model keeps different headers separate", () => {
  const first = detectTablesOnPage({
    pageNumber: 1, width: 200, height: 100, source: "text",
    words: [word("Name", 10, 10), word("Value", 100, 10), word("A", 10, 40), word("1", 100, 40)]
  });
  const second = detectTablesOnPage({
    pageNumber: 2, width: 200, height: 100, source: "text",
    words: [word("Code", 10, 10), word("Total", 100, 10), word("B", 10, 40), word("2", 100, 40)]
  });
  assert.deepEqual(buildWorkbookModel([first, second]).sheets.map((sheet) => sheet.name), ["P001-T01", "P002-T01"]);
});

test("continues two matching tables independently across adjacent pages", () => {
  const makePage = (pageNumber, top) => detectTablesOnPage({
    pageNumber, width: 300, height: 100, source: "text",
    lines: [
      ...[top, top + 20, top + 40].flatMap((y) => [
        { x1: 0, y1: y, x2: 100, y2: y }, { x1: 160, y1: y, x2: 260, y2: y }
      ]),
      ...[0, 50, 100].map((x) => ({ x1: x, y1: top, x2: x, y2: top + 40 })),
      ...[160, 210, 260].map((x) => ({ x1: x, y1: top, x2: x, y2: top + 40 }))
    ],
    words: [
      word("A", 5, top + 2), word("V", 55, top + 2), word(`a${pageNumber}`, 5, top + 22), word(String(pageNumber), 55, top + 22),
      word("B", 165, top + 2), word("V", 215, top + 2), word(`b${pageNumber}`, 165, top + 22), word(String(pageNumber), 215, top + 22)
    ]
  });
  const model = buildWorkbookModel([makePage(1, 60), makePage(2, 0)]);
  assert.equal(model.sheets.length, 2);
  assert.deepEqual(model.sheets.map((sheet) => sheet.pages), [[1, 2], [1, 2]]);
  assert.deepEqual(model.sheets[0].rows.map((row) => row[0]), ["A", "a1", "a2"]);
  assert.deepEqual(model.sheets[1].rows.map((row) => row[0]), ["B", "b1", "b2"]);
});

test("matching generic headers are not continued unless tables touch page edges", () => {
  const pages = [1, 2].map((pageNumber) => detectTablesOnPage({
    pageNumber, width: 200, height: 200, source: "text",
    words: [word("Name", 10, 60), word("Value", 100, 60), word(`Row${pageNumber}`, 10, 90), word(String(pageNumber), 100, 90)]
  }));
  assert.equal(buildWorkbookModel(pages).sheets.length, 2);
});

test("narrative text outside a detected table is retained in a Raw sheet", () => {
  const page = detectTablesOnPage({
    pageNumber: 4, width: 300, height: 400, source: "text",
    words: [
      word("Quarterly narrative", 10, 10, 1, 180),
      word("Name", 10, 180), word("Value", 120, 180),
      word("Mouse", 10, 210), word("1", 120, 210)
    ]
  });
  const model = buildWorkbookModel([page]);
  assert.deepEqual(model.sheets.map((sheet) => sheet.name), ["P004-T01", "P004-Raw"]);
  assert.match(model.sheets[1].rows.flat().join(" "), /narrative/);
});

test("does not turn an L-shaped union into an overlapping rectangular merge", () => {
  const horizontal = [0, 30, 60].flatMap((y) => y === 30
    ? [{ x1: 100, y1: y, x2: 200, y2: y }]
    : [{ x1: 0, y1: y, x2: 200, y2: y }]);
  const vertical = [
    { x1: 0, y1: 0, x2: 0, y2: 60 },
    { x1: 100, y1: 30, x2: 100, y2: 60 },
    { x1: 200, y1: 0, x2: 200, y2: 60 }
  ];
  const table = detectTablesOnPage({
    pageNumber: 1, width: 200, height: 60, source: "text", lines: [...horizontal, ...vertical],
    words: [word("Top", 10, 5), word("Left", 10, 35), word("Right", 110, 35)]
  }).tables[0];
  assert.deepEqual(table.merges, []);
  assert.match(table.rows.flat().join(" "), /Top/);
  assert.match(table.rows.flat().join(" "), /Right/);
});

test("rejects non-finite coordinates and oversized vector grids", () => {
  const finite = detectTablesOnPage({
    pageNumber: 1, width: 100, height: 100, source: "text",
    words: [word("Bad", Number.POSITIVE_INFINITY, 10), word("Only", 10, 20)]
  });
  assert.doesNotMatch(finite.rawRows.flat().join(" "), /Bad/);

  const lines = [];
  for (let index = 0; index < 600; index += 1) {
    lines.push({ x1: index * 3, y1: 0, x2: index * 3, y2: 1800 });
    lines.push({ x1: 0, y1: index * 3, x2: 1800, y2: index * 3 });
  }
  assert.throws(() => detectTablesOnPage({ pageNumber: 1, width: 1800, height: 1800, source: "text", lines, words: [] }), /grid is too large/i);
});

test("pages without a table become Raw sheets without losing text", () => {
  const page = detectTablesOnPage({
    pageNumber: 3,
    width: 300,
    height: 200,
    source: "text",
    words: [word("A paragraph, not a table.", 10, 20, 1, 220)]
  });
  assert.equal(page.tables.length, 0);
  const model = buildWorkbookModel([page]);
  assert.equal(model.sheets[0].name, "P003-Raw");
  assert.match(model.sheets[0].rows.flat().join(" "), /paragraph/);
});

test("low OCR confidence is retained and surfaced as a warning", () => {
  const page = detectTablesOnPage({
    pageNumber: 1,
    width: 200,
    height: 100,
    source: "ocr",
    words: [
      word("Name", 10, 10, 0.55), word("Value", 100, 10, 0.55),
      word("Mouse", 10, 40, 0.5), word("1", 100, 40, 0.5)
    ]
  });
  assert.ok(page.tables[0].confidence < 0.75);
  const model = buildWorkbookModel([page]);
  assert.ok(model.warnings.length > 0);
  assert.equal(model.sheets[0].rows[1][0], "Mouse");
});
