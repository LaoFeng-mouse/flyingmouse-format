"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { writePdfTableWorkbook } = require("../pdf-table");

async function writeAndRead(t, model) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-pdf-table-writer-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const output = path.join(root, "table.xlsx");
  await writePdfTableWorkbook(model, output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  return workbook;
}

test("wide Chinese tables retain all cells and readable borders when printed one page across", async (t) => {
  const headers = ["序号", "学生姓名", "身份证号", "学历", "学院", "专业", "学号", "性别", "户口类型", "生源省份", "困难程度", "家庭人均\n年收入（元）", "在读\n年级"];
  const values = ["1", "", "001234567890123456", "本科", "", "", "000001", "", "城市", "陕西省", "", "", ""];
  const workbook = await writeAndRead(t, {
    summary: [{ pageNumber: 1, source: "text", tableCount: 1, confidence: 0.95 }], warnings: [],
    sheets: [
      { name: "P001-T01", rows: [headers, values, Array(13).fill("")], merges: [], pages: [1], kind: "grid",
        columnAnchors: [0, 35, 95, 185, 225, 280, 345, 395, 440, 500, 555, 640, 710, 750],
        bounds: { left: 0, top: 100, right: 750, bottom: 200 }, pageWidth: 842, pageHeight: 595,
        cellConfidence: [Array(13).fill(1), [1, 1, 0.6]] },
      { name: "P001-Raw", rows: [["示例学校家庭经济困难学生名单"], ["学院认定工作组成员（签字）："]], merges: [], pages: [1] }
    ]
  });
  const sheet = workbook.getWorksheet("P001-T01");
  assert.equal(sheet.pageSetup.fitToPage, true);
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.pageSetup.fitToHeight, 0, "long tables can continue vertically without microscopic scaling");
  assert.equal(sheet.pageSetup.orientation, "landscape");
  assert.equal(sheet.columnCount, 13);
  assert.deepEqual(sheet.getRow(1).values.slice(1), headers);
  assert.deepEqual(sheet.getRow(2).values.slice(1), values);
  assert.equal(sheet.getCell("C2").type, ExcelJS.ValueType.String);
  assert.match(JSON.stringify(sheet.getCell("C2").note), /60%/);
  assert.equal(sheet.getCell("L1").alignment.wrapText, true);
  assert.ok(sheet.getRow(1).height >= 30, "two Chinese header lines need enough height");
  for (const address of ["A1", "M1", "A3", "M3"]) {
    for (const edge of ["left", "right", "top", "bottom"]) assert.ok(sheet.getCell(address).border[edge]?.style, `${address} needs its ${edge} border, including empty form cells`);
  }
  assert.equal(workbook.getWorksheet("P001-Raw").getCell("A1").value, "示例学校家庭经济困难学生名单");
  assert.equal(workbook.getWorksheet("识别说明").pageSetup.fitToPage, true);
});

test("source column proportions and merged cells survive styling while notes stay readable", async (t) => {
  const workbook = await writeAndRead(t, {
    summary: [{ pageNumber: 1, source: "text", tableCount: 1, confidence: 0.9 }],
    warnings: ["P001: title and footnote retained in Raw sheet"],
    sheets: [{ name: "P001-T01", kind: "grid", pages: [1],
      rows: [["跨列标题保留全部文字", ""], ["部门", "较长的中文说明应在宽列中换行，而不修改内容"], ["", "00012"]],
      merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, { startRow: 1, startCol: 0, endRow: 2, endCol: 0 }],
      columnAnchors: [50, 140, 450], bounds: { left: 50, top: 100, right: 450, bottom: 250 }, pageWidth: 500, pageHeight: 700 }
    ]
  });
  const sheet = workbook.getWorksheet("P001-T01");
  assert.equal(sheet.getCell("B1").master.address, "A1");
  assert.equal(sheet.getCell("A3").master.address, "A2");
  assert.equal(sheet.getCell("B3").value, "00012");
  assert.ok(sheet.getColumn(2).width > sheet.getColumn(1).width * 2, "wide source column must remain wider than the narrow label column");
  const notes = workbook.getWorksheet("识别说明");
  assert.equal(notes.getCell("E5").master.address, "B5", "the explanatory sentence needs the whole available note area");
  assert.equal(notes.getCell("E6").master.address, "B6");
  assert.match(notes.getCell("B5").value, /人工复核/);
});

test("Excel opens the first actual table while retaining explanation and raw text sheets", async (t) => {
  const workbook = await writeAndRead(t, {
    summary: [], warnings: [], sheets: [
      { name: "P001-Raw", rows: [["原始标题和签名"]], pages: [1] },
      { name: "P001-T01", rows: [["项目", "数量"], ["测试", "1"]], pages: [1] }
    ]
  });
  assert.equal(workbook.worksheets[workbook.views?.[0]?.activeTab]?.name, "P001-T01");
  assert.equal(workbook.worksheets[0].name, "P001-T01", "the editable primary sheet must also be first, before diagnostics");
  assert.equal(workbook.getWorksheet("P001-Raw").getCell("A1").value, "原始标题和签名");
  assert.ok(workbook.getWorksheet("识别说明"));
});

test("a proven single-page form keeps editable title and independent signatures with its table", async (t) => {
  const beforeBlocks = [
    { text: "附表 A", x: 50, y: 80, width: 70, height: 12 },
    { text: "通用项目登记表", x: 140, y: 112, width: 360, height: 20 }
  ];
  const afterBlocks = [
    { text: "审核人（签字）：", x: 70, y: 312, width: 170, height: 12 },
    { text: "填表人（签字）：", x: 350, y: 314, width: 200, height: 12 },
    { text: "请保持电子表格格式。", x: 50, y: 350, width: 300, height: 11 },
    { text: "— 9 —", x: 50, y: 390, width: 40, height: 10 }
  ];
  const workbook = await writeAndRead(t, { summary: [], warnings: [], sheets: [
    { name: "P001-T01", source: "text", kind: "grid", pages: [1],
      rows: [["序号", "姓名", "编号", "家庭\n收入"], ["1", "测试甲", "00012", ""], ["2", "", "", ""]],
      merges: [], cellConfidence: [], columnAnchors: [50, 160, 300, 460, 590], rowAnchors: [180, 220, 260, 300],
      bounds: { left: 50, top: 180, right: 590, bottom: 300 }, pageWidth: 842, pageHeight: 595,
      pageForm: { pageWidth: 842, pageHeight: 595, beforeBlocks, afterBlocks } },
    { name: "P001-Raw", rows: [...beforeBlocks, ...afterBlocks].map(block => [block.text]), pages: [1] }
  ] });
  const sheet = workbook.getWorksheet("P001-T01");
  assert.equal(sheet.name, "P001-T01");
  const positions = new Map();
  sheet.eachRow(row => row.eachCell(cell => {
    if (!cell.isMerged || cell.master === cell) positions.set(String(cell.value), { row: row.number, col: cell.col, cell });
  }));
  for (const block of [...beforeBlocks, ...afterBlocks]) assert.ok(positions.has(block.text), `${block.text} must be editable on the primary sheet`);
  const header = positions.get("序号"), title = positions.get("通用项目登记表");
  assert.ok(title.row < header.row);
  assert.equal(sheet.getCell(header.row, 4).value, "家庭\n收入");
  assert.equal(sheet.getCell(header.row + 1, 3).value, "00012");
  const left = positions.get("审核人（签字）："), right = positions.get("填表人（签字）：");
  assert.equal(left.row, right.row);
  assert.ok(left.col < right.col && left.row > header.row + 2);
  assert.notEqual(left.cell.master.address, right.cell.master.address);
  assert.ok(positions.get("— 9 —").row > left.row);
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.pageSetup.fitToHeight, 0, "later edits may grow vertically without shrinking the form");
  assert.equal(sheet.pageSetup.paperSize, 9);
  assert.equal(sheet.pageSetup.orientation, "landscape");
  assert.equal(sheet.getCell(header.row + 2, 4).border.bottom.style, "thin");
  assert.equal(sheet.getCell(title.row, title.col).border.bottom, undefined, "title is outside the data grid");
  assert.ok(workbook.getWorksheet("P001-Raw"), "raw evidence is retained after the complete form");
});

test("a wrapping form note gets enough height in its own cell rather than relying on blank rows below it", async (t) => {
  const text = "完整说明应在当前单元格中全部可见，不能借用下一空白行。".repeat(8);
  const workbook = await writeAndRead(t, { sheets: [{ name: "P001-T01", source: "text", kind: "grid", pages: [1],
    rows: [["项目", "编号"], ["样本", "000001"]], merges: [], columnAnchors: [0, 200, 500], rowAnchors: [100, 130, 160],
    bounds: { left: 0, top: 100, right: 500, bottom: 160 }, pageWidth: 600, pageHeight: 850,
    pageForm: { pageWidth: 600, pageHeight: 850, beforeBlocks: [], afterBlocks: [
      { text, x: 0, y: 190, width: 490, height: 12 }, { text: "— 8 —", x: 0, y: 500, width: 50, height: 12 }
    ] } }] });
  const sheet = workbook.getWorksheet("P001-T01");
  let note;
  sheet.eachRow(row => row.eachCell(cell => { if (cell.value === text) note = cell; }));
  assert.ok(note && note.alignment.wrapText);
  assert.ok(sheet.getRow(note.row).height >= 60, "long note needs several lines in its actual merged cell");
});

test("unrepresentable same-line form blocks preserve the original extraction instead of failing conversion", async (t) => {
  const workbook = await writeAndRead(t, { sheets: [
    { name: "P001-T01", source: "text", kind: "grid", pages: [1], rows: [["项目", "编号"], ["样本", "000001"]],
      merges: [], columnAnchors: [0, 200, 500], rowAnchors: [100, 130, 160],
      bounds: { left: 0, top: 100, right: 500, bottom: 160 }, pageWidth: 600, pageHeight: 850,
      pageForm: { pageWidth: 600, pageHeight: 850, beforeBlocks: [], afterBlocks: [
        { text: "甲", x: 20, y: 190, width: 10, height: 12 }, { text: "乙", x: 80, y: 190, width: 10, height: 12 }
      ] } },
    { name: "P001-Raw", rows: [["甲"], ["乙"]], pages: [1] }
  ] });
  assert.equal(workbook.getWorksheet("P001-T01").getCell("A1").value, "项目");
  assert.equal(workbook.getWorksheet("P001-T01").pageSetup.fitToHeight, 0);
  assert.equal(workbook.getWorksheet("P001-Raw").getCell("A2").value, "乙");
});
