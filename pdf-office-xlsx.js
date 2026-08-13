const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { openZipEntries } = require("./zip-util");

const HARD_TABLE_CONFIDENCE = 0.65;
const REVIEW_CELL_CONFIDENCE = 0.85;
const MAX_TABLE_ROWS = 20_000;
const MAX_TABLE_COLUMNS = 256;
const MAX_TABLE_CELLS = 200_000;
const MAX_TOTAL_CELLS = 500_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_WORKSHEET_XML_BYTES = 16 * 1024 * 1024;
const MAX_CORE_XML_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_COMPRESSION_RATIO = 200;
const MAX_ENGINE_METADATA_CHARS = 256;
const REVIEW_FILL_ARGB = "FFFFE2A8";
const MAX_DISPLAY_WARNING_COUNT = 8;
const MAX_WARNING_DETAIL_CHARS = 256;
const NO_REVIEW_MESSAGE = "没有低于人工复核阈值的单元格。";
const SAFE_VALIDATION_REASONS = new Set([
  "sheet mismatch", "metadata mismatch", "table dimensions", "merge mismatch", "cell mismatch",
  "summary mismatch", "review highlight mismatch", "review note mismatch", "no editable table content",
  "review row count", "review row mismatch", "reference image count", "reference label mismatch",
  "reference image mismatch", "missing reference media", "invalid package", "xml dimension mismatch",
  "xml merge mismatch", "xml row mismatch", "xml column mismatch", "xml formula mismatch", "xml hyperlink mismatch"
]);

const ERROR_MESSAGES = Object.freeze({
  PDF_TABLE_NOT_DETECTED: Object.freeze({
    zhCN: "未检测到可用表格，无法生成结构化 Excel。",
    enUS: "No usable table was detected, so a structured Excel workbook cannot be created."
  }),
  PDF_TABLE_OCR_LOW_QUALITY: Object.freeze({
    zhCN: "表格识别质量低于安全阈值，请使用更清晰的文件后重试。",
    enUS: "Table recognition quality is below the safe threshold. Try again with a clearer file."
  }),
  PDF_OFFICE_OUTPUT_INVALID: Object.freeze({
    zhCN: "生成的 Excel 文件未通过完整性检查，未替换原文件。",
    enUS: "The generated Excel workbook failed integrity validation and did not replace the existing file."
  })
});

function stableError(code) {
  const messages = ERROR_MESSAGES[code] || ERROR_MESSAGES.PDF_OFFICE_OUTPUT_INVALID;
  const error = new Error(messages.enUS);
  error.code = ERROR_MESSAGES[code] ? code : "PDF_OFFICE_OUTPUT_INVALID";
  error.messages = { ...messages };
  return error;
}

function isStable(error) {
  return Boolean(error && Object.hasOwn(ERROR_MESSAGES, error.code));
}

function confidence(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value);
}

function engineMetadata(manifest) {
  const source = manifest?.engine;
  if (source !== undefined && (source === null || typeof source !== "object" || Array.isArray(source))) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  const defaults = { name: "unknown", version: "unknown", language: "ch" };
  const output = {};
  for (const key of Object.keys(defaults)) {
    const value = source?.[key] === undefined ? defaults[key] : source[key];
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_ENGINE_METADATA_CHARS ||
        /[\u0000-\u001f\u007f]/.test(value)) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    output[key] = value;
  }
  return output;
}

function safeSheetName(pageNumber, tableNumber) {
  return `P${String(pageNumber).padStart(3, "0")}-T${String(tableNumber).padStart(2, "0")}`;
}

function tableDescriptors(manifest) {
  if (!manifest || !Array.isArray(manifest.pages)) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  const descriptors = [];
  let totalCells = 0;
  for (const [pageIndex, page] of manifest.pages.entries()) {
    if (!page || !Array.isArray(page.tables)) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0
      ? page.pageNumber
      : pageIndex + 1;
    for (const [tableIndex, table] of page.tables.entries()) {
      if (!table || !Number.isSafeInteger(table.rowCount) || !Number.isSafeInteger(table.columnCount) ||
          table.rowCount < 1 || table.rowCount > MAX_TABLE_ROWS ||
          table.columnCount < 1 || table.columnCount > MAX_TABLE_COLUMNS) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      const tableCells = table.rowCount * table.columnCount;
      if (!Number.isSafeInteger(tableCells) || tableCells > MAX_TABLE_CELLS) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      totalCells += tableCells;
      if (!Number.isSafeInteger(totalCells) || totalCells > MAX_TOTAL_CELLS || !Array.isArray(table.cells)) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      const tableConfidence = confidence(table.confidence);
      if (!Number.isFinite(tableConfidence) || tableConfidence < 0 || tableConfidence > 1) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      if (tableConfidence < HARD_TABLE_CONFIDENCE) throw stableError("PDF_TABLE_OCR_LOW_QUALITY");
      descriptors.push({
        page,
        pageIndex,
        pageNumber,
        table,
        tableIndex,
        sheetName: safeSheetName(pageNumber, tableIndex + 1)
      });
    }
  }
  if (descriptors.length === 0) throw stableError("PDF_TABLE_NOT_DETECTED");
  const names = descriptors.map((item) => item.sheetName);
  if (new Set(names).size !== names.length) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  return descriptors;
}

function normalizeCellText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function recognizedCellValue(text) {
  const value = normalizeCellText(text);
  return { value: value === "" ? null : value, numFmt: "@" };
}

function cellAddress(row, column) {
  let letters = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  }
  return `${letters}${row + 1}`;
}

function expectedTable(descriptor) {
  const { table } = descriptor;
  const occupied = Array.from({ length: table.rowCount }, () => Array(table.columnCount).fill(false));
  const values = Array.from({ length: table.rowCount }, () => Array(table.columnCount).fill(null));
  const formats = Array.from({ length: table.rowCount }, () => Array(table.columnCount).fill("@"));
  const merges = [];
  const review = [];
  let meaningful = 0;
  for (const sourceCell of table.cells) {
    if (!sourceCell || !Number.isSafeInteger(sourceCell.row) || !Number.isSafeInteger(sourceCell.column) ||
        !Number.isSafeInteger(sourceCell.rowSpan) || !Number.isSafeInteger(sourceCell.columnSpan) ||
        sourceCell.row < 0 || sourceCell.column < 0 || sourceCell.rowSpan < 1 || sourceCell.columnSpan < 1 ||
        sourceCell.row + sourceCell.rowSpan > table.rowCount ||
        sourceCell.column + sourceCell.columnSpan > table.columnCount) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    for (let row = sourceCell.row; row < sourceCell.row + sourceCell.rowSpan; row += 1) {
      for (let column = sourceCell.column; column < sourceCell.column + sourceCell.columnSpan; column += 1) {
        if (occupied[row][column]) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
        occupied[row][column] = true;
      }
    }
    const parsed = recognizedCellValue(sourceCell.text);
    values[sourceCell.row][sourceCell.column] = parsed.value;
    formats[sourceCell.row][sourceCell.column] = parsed.numFmt;
    if (parsed.value !== null && String(parsed.value).trim()) meaningful += 1;
    if (sourceCell.rowSpan > 1 || sourceCell.columnSpan > 1) {
      merges.push(`${cellAddress(sourceCell.row, sourceCell.column)}:${cellAddress(
        sourceCell.row + sourceCell.rowSpan - 1,
        sourceCell.column + sourceCell.columnSpan - 1
      )}`);
    }
    const cellConfidence = confidence(sourceCell.confidence);
    if (!Number.isFinite(cellConfidence) || cellConfidence < 0 || cellConfidence > 1) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    if (cellConfidence < REVIEW_CELL_CONFIDENCE) {
      review.push({
        pageNumber: descriptor.pageNumber,
        sheetName: descriptor.sheetName,
        address: cellAddress(sourceCell.row, sourceCell.column),
        value: normalizeCellText(sourceCell.text),
        confidence: cellConfidence,
        reference: `第 ${descriptor.pageNumber} 页`
      });
    }
  }
  return { ...descriptor, values, formats, merges: merges.sort(), review, meaningful };
}

async function trustedRoot(assetRoot, fileSystem) {
  if (typeof assetRoot !== "string" || !path.isAbsolute(assetRoot)) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  try {
    const info = await fileSystem.lstat(assetRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("untrusted root");
    const realRoot = await fileSystem.realpath(assetRoot);
    if (path.resolve(assetRoot).toLowerCase() !== path.resolve(realRoot).toLowerCase()) throw new Error("redirected root");
    return path.resolve(realRoot);
  } catch {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function preflightReferenceAssets(manifest, assetRoot, fileSystem) {
  const root = await trustedRoot(assetRoot, fileSystem);
  const assets = [];
  let totalBytes = 0;
  for (const page of manifest.pages) {
    const name = page?.referenceImage;
    if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") ||
        path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    const lexicalPath = path.resolve(root, ...name.split("/"));
    if (!contained(root, lexicalPath)) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    try {
      const info = await fileSystem.lstat(lexicalPath);
      const realPath = await fileSystem.realpath(lexicalPath);
      if (!info.isFile() || info.isSymbolicLink() || path.resolve(realPath).toLowerCase() !== lexicalPath.toLowerCase() ||
          !contained(root, path.resolve(realPath)) || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_ASSET_BYTES) {
        throw new Error("untrusted asset");
      }
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error("asset budget");
      const extension = path.extname(name).slice(1).toLowerCase();
      if (!new Set(["png", "jpeg", "jpg", "gif", "bmp"]).has(extension)) throw new Error("unsupported image");
      assets.push({ page, path: lexicalPath, extension: extension === "jpg" ? "jpeg" : extension });
    } catch {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
  }
  return assets;
}

const COLORS = Object.freeze({
  navy: "FF21405F",
  blue: "FFDCE8F2",
  border: "FFD2D9E0",
  body: "FFFFFFFF",
  note: "FFF4F7FA",
  review: REVIEW_FILL_ARGB,
  text: "FF1F2937",
  white: "FFFFFFFF"
});

function border() {
  return {
    top: { style: "thin", color: { argb: COLORS.border } },
    left: { style: "thin", color: { argb: COLORS.border } },
    bottom: { style: "thin", color: { argb: COLORS.border } },
    right: { style: "thin", color: { argb: COLORS.border } }
  };
}

function configureSheet(sheet, freezeRows = 1) {
  sheet.views = [{ state: "frozen", ySplit: freezeRows, showGridLines: false }];
  sheet.pageSetup = {
    orientation: "landscape",
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  sheet.properties.defaultRowHeight = 22;
}

function safeWarningDetails(warnings) {
  const source = Array.isArray(warnings) ? warnings : [];
  if (source.length === 0) return "无 / None";
  const visible = source.slice(0, MAX_DISPLAY_WARNING_COUNT).map((warning) => {
    const value = typeof warning === "string" ? warning : "";
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : "[redacted]";
  });
  if (source.length > MAX_DISPLAY_WARNING_COUNT) visible.push(`+${source.length - MAX_DISPLAY_WARNING_COUNT}`);
  return visible.join("; ").slice(0, MAX_WARNING_DETAIL_CHARS);
}

function summaryRows(manifest, expectedTables) {
  return manifest.pages.map((page, index) => {
    const tables = expectedTables.filter((item) => item.pageIndex === index);
    const average = tables.length
      ? tables.reduce((sum, item) => sum + confidence(item.table.confidence), 0) / tables.length
      : 0;
    const warnings = Array.isArray(page.warnings) ? page.warnings : [];
    const classification = /^[A-Za-z0-9_.:-]{1,32}$/.test(String(page.classification || ""))
      ? String(page.classification)
      : "unknown";
    return [
      Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1,
      classification,
      tables.length,
      average,
      warnings.length,
      Number.isFinite(page.elapsedMs) && page.elapsedMs >= 0 ? page.elapsedMs : 0,
      safeWarningDetails(warnings)
    ];
  });
}

function styleTableSheet(sheet, expected) {
  configureSheet(sheet, 1);
  for (let rowIndex = 1; rowIndex <= expected.table.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.height = rowIndex === 1 ? 30 : 24;
    for (let columnIndex = 1; columnIndex <= expected.table.columnCount; columnIndex += 1) {
      const cell = row.getCell(columnIndex);
      cell.font = { name: "Microsoft YaHei", size: 10, bold: rowIndex === 1, color: { argb: rowIndex === 1 ? COLORS.white : COLORS.text } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowIndex === 1 ? COLORS.navy : COLORS.body } };
      cell.alignment = { vertical: "middle", horizontal: rowIndex === 1 ? "center" : "left", wrapText: true };
      cell.border = border();
    }
  }
  for (let columnIndex = 1; columnIndex <= expected.table.columnCount; columnIndex += 1) {
    let width = 12;
    for (let rowIndex = 0; rowIndex < expected.table.rowCount; rowIndex += 1) {
      const value = expected.values[rowIndex][columnIndex - 1];
      if (value !== null && !(value instanceof Date)) width = Math.max(width, Math.min(30, String(value).length * 1.7 + 3));
    }
    sheet.getColumn(columnIndex).width = width;
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: expected.table.columnCount } };
  sheet.printArea = `A1:${cellAddress(expected.table.rowCount - 1, expected.table.columnCount - 1)}`;
}

function addInfoSheet(workbook, manifest, expectedTables) {
  const sheet = workbook.addWorksheet("识别说明");
  const engine = engineMetadata(manifest);
  configureSheet(sheet, 2);
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = "扫描 PDF 表格识别说明 / Recognition summary";
  sheet.getCell("A1").font = { name: "Microsoft YaHei", size: 16, bold: true, color: { argb: COLORS.white } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 34;
  const metadata = [
    ["字段", "值"],
    ["识别引擎", engine.name],
    ["引擎版本", engine.version],
    ["识别语言", engine.language],
    ["表格失败阈值", HARD_TABLE_CONFIDENCE],
    ["人工复核阈值", REVIEW_CELL_CONFIDENCE],
    ["使用提示", "黄色单元格需结合“原件对照”复核；表格单元格均可编辑。"]
  ];
  metadata.forEach((values, index) => {
    const row = sheet.getRow(index + 2);
    row.values = values;
    row.height = index === 6 ? 34 : 23;
    row.eachCell((cell, column) => {
      cell.font = { name: "Microsoft YaHei", size: 10, bold: index === 0 || column === 1, color: { argb: COLORS.text } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index === 0 ? COLORS.blue : COLORS.body } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = border();
    });
  });
  sheet.getCell("B6").numFmt = "0%";
  sheet.getCell("B7").numFmt = "0%";
  const summaryStart = 10;
  sheet.getRow(summaryStart).values = ["页码", "分类", "表格数", "平均表格置信度", "警告数", "耗时(ms)", "警告详情"];
  sheet.getRow(summaryStart).eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = border();
  });
  summaryRows(manifest, expectedTables).forEach((values, index) => {
    const row = sheet.getRow(summaryStart + index + 1);
    row.values = values;
    row.eachCell((cell) => { cell.font = { name: "Microsoft YaHei", size: 10 }; cell.border = border(); cell.alignment = { vertical: "middle", wrapText: true }; });
    row.getCell(4).numFmt = "0.0%";
  });
  sheet.columns = [{ width: 20 }, { width: 34 }, { width: 12 }, { width: 18 }, { width: 10 }, { width: 12 }, { width: 34 }];
  sheet.printArea = `A1:G${summaryStart + manifest.pages.length}`;
  return sheet;
}

function addTableSheet(workbook, expected) {
  const sheet = workbook.addWorksheet(expected.sheetName);
  for (const merge of expected.merges) sheet.mergeCells(merge);
  for (let row = 0; row < expected.table.rowCount; row += 1) {
    for (let column = 0; column < expected.table.columnCount; column += 1) {
      const excelCell = sheet.getCell(row + 1, column + 1);
      if (expected.values[row][column] !== null) {
        excelCell.value = expected.values[row][column];
        excelCell.numFmt = expected.formats[row][column];
      }
    }
  }
  styleTableSheet(sheet, expected);
  for (const item of expected.review) {
    const excelCell = sheet.getCell(item.address);
    excelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.review } };
    excelCell.note = reviewNote(item);
  }
  return sheet;
}

function addReviewSheet(workbook, reviewItems) {
  const sheet = workbook.addWorksheet("待核对");
  configureSheet(sheet, 1);
  sheet.getRow(1).values = ["页码", "表格工作表", "单元格", "识别值", "置信度", "原件位置"];
  sheet.getRow(1).height = 28;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = border();
  });
  reviewItems.forEach((item, index) => {
    const row = sheet.getRow(index + 2);
    row.values = [item.pageNumber, item.sheetName, item.address, item.value, item.confidence, item.reference];
    row.eachCell((cell) => { cell.font = { name: "Microsoft YaHei", size: 10, color: { argb: COLORS.text } }; cell.border = border(); cell.alignment = { vertical: "middle", wrapText: true }; });
    row.getCell(5).numFmt = "0.0%";
    row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.review } };
  });
  if (!reviewItems.length) {
    sheet.mergeCells("A2:F2");
    sheet.getCell("A2").value = NO_REVIEW_MESSAGE;
    sheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.note } };
    sheet.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };
  }
  sheet.columns = [{ width: 10 }, { width: 16 }, { width: 12 }, { width: 32 }, { width: 12 }, { width: 16 }];
  sheet.autoFilter = reviewItems.length ? "A1:F1" : undefined;
  sheet.printArea = `A1:F${Math.max(2, reviewItems.length + 1)}`;
  return sheet;
}

async function addReferenceSheet(workbook, assets, fileSystem) {
  const sheet = workbook.addWorksheet("原件对照");
  configureSheet(sheet, 1);
  sheet.pageSetup.orientation = "portrait";
  sheet.pageSetup.fitToWidth = 1;
  sheet.pageSetup.fitToHeight = 0;
  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").value = "原件对照 / Original reference（黄色单元格请在此核对）";
  sheet.getCell("A1").font = { name: "Microsoft YaHei", size: 15, bold: true, color: { argb: COLORS.white } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 34;
  let anchorRow = 2;
  for (const [assetIndex, asset] of assets.entries()) {
    const labelRow = anchorRow;
    if (assetIndex > 0) sheet.getRow(labelRow - 1).addPageBreak();
    sheet.mergeCells(labelRow, 1, labelRow, 8);
    sheet.getCell(labelRow, 1).value = `第 ${asset.page.pageNumber} 页 / Page ${asset.page.pageNumber}`;
    sheet.getCell(labelRow, 1).font = { name: "Microsoft YaHei", size: 11, bold: true, color: { argb: COLORS.text } };
    sheet.getCell(labelRow, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blue } };
    sheet.getCell(labelRow, 1).alignment = { vertical: "middle" };
    sheet.getRow(labelRow).height = 26;
    const buffer = await fileSystem.readFile(asset.path);
    const imageId = workbook.addImage({ buffer, extension: asset.extension });
    const sourceWidth = Number(asset.page.width) || 1653;
    const sourceHeight = Number(asset.page.height) || 2339;
    const width = 500;
    const height = Math.max(300, Math.min(680, Math.round(width * sourceHeight / sourceWidth)));
    const imageRows = Math.ceil(height / 20);
    sheet.addImage(imageId, { tl: { col: 0, row: labelRow }, ext: { width, height }, editAs: "oneCell" });
    for (let row = labelRow + 1; row <= labelRow + imageRows; row += 1) sheet.getRow(row).height = 15;
    anchorRow = labelRow + imageRows + 3;
  }
  for (let column = 1; column <= 8; column += 1) sheet.getColumn(column).width = 12;
  sheet.printArea = `A1:H${Math.max(2, anchorRow - 1)}`;
  return sheet;
}

function expectedSheetNames(expectedTables) {
  return ["识别说明", ...expectedTables.map((item) => item.sheetName), "待核对", "原件对照"];
}

function reviewNote(item) {
  return `识别置信度 ${(item.confidence * 100).toFixed(1)}%；请对照第 ${item.pageNumber} 页原件复核。`;
}

function comparable(value) {
  if (value instanceof Date) return `date:${value.toISOString().slice(0, 10)}`;
  if (value === null || value === undefined) return "null:";
  return `${typeof value}:${String(value)}`;
}

function notePresent(note) {
  if (typeof note === "string") return note.length > 0;
  return Boolean(note && Array.isArray(note.texts) && note.texts.length);
}

function noteText(note) {
  if (typeof note === "string") return note;
  if (!note || !Array.isArray(note.texts)) return "";
  return note.texts.map((part) => String(part?.text || "")).join("");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeZipEntryName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/") || name.includes("\0")) return false;
  const candidate = name.endsWith("/") ? name.slice(0, -1) : name;
  return Boolean(candidate) && candidate.split("/").every((part) => part && part !== "." && part !== "..");
}

function xmlEntryLimit(name) {
  if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return MAX_WORKSHEET_XML_BYTES;
  if (name === "xl/workbook.xml" || name === "xl/sharedStrings.xml" || name === "xl/styles.xml" || name.endsWith(".rels")) {
    return MAX_CORE_XML_BYTES;
  }
  return name.endsWith(".xml") ? MAX_CORE_XML_BYTES : MAX_ZIP_ENTRY_BYTES;
}

async function inspectXlsxPackage(packagePath) {
  let zipfile;
  try { zipfile = await openZipEntries(packagePath); }
  catch { throw new Error("invalid package"); }
  return new Promise((resolve, reject) => {
    const names = new Set();
    const buffers = new Map();
    let entryCount = 0;
    let aggregate = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(new Error("invalid package"));
    };
    zipfile.on("entry", (entry) => {
      entryCount += 1;
      const declared = Number(entry.uncompressedSize);
      const compressed = Number(entry.compressedSize);
      const limit = xmlEntryLimit(entry.fileName);
      if (entryCount > MAX_ZIP_ENTRIES || !safeZipEntryName(entry.fileName) || names.has(entry.fileName) ||
          !Number.isSafeInteger(declared) || declared < 0 || declared > limit ||
          !Number.isSafeInteger(compressed) || compressed < 0 ||
          (declared > 64 * 1024 && (compressed === 0 || declared / compressed > MAX_ZIP_COMPRESSION_RATIO))) return fail();
      names.add(entry.fileName);
      aggregate += declared;
      if (!Number.isSafeInteger(aggregate) || aggregate > MAX_PACKAGE_BYTES || /^xl\/externalLinks\//.test(entry.fileName)) return fail();
      const wanted = !entry.fileName.endsWith("/") && (entry.fileName.endsWith(".xml") || entry.fileName.endsWith(".rels"));
      if (!wanted) { zipfile.readEntry(); return; }
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return fail();
        const chunks = [];
        let length = 0;
        stream.on("data", (chunk) => {
          length += chunk.length;
          if (length > declared || length > limit) { stream.destroy(); fail(); return; }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          if (settled || length !== declared) return fail();
          buffers.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      resolve({ names, buffers });
    });
    zipfile.readEntry();
  });
}

function decodeXmlAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function tokenizeXml(buffer, handlers = {}) {
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("invalid package");
  const stack = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (start > cursor) handlers.text?.(xml.slice(cursor, start));
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0) throw new Error("invalid package");
      cursor = end + 3;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < xml.length; end += 1) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= xml.length) throw new Error("invalid package");
    const raw = xml.slice(start + 1, end).trim();
    cursor = end + 1;
    if (!raw || raw.startsWith("?")) continue;
    if (raw.startsWith("!")) throw new Error("invalid package");
    const closing = raw.startsWith("/");
    const selfClosing = !closing && raw.endsWith("/");
    const body = (closing ? raw.slice(1) : selfClosing ? raw.slice(0, -1) : raw).trim();
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(body);
    if (!nameMatch) throw new Error("invalid package");
    const name = nameMatch[0];
    const attrs = {};
    let rest = body.slice(name.length);
    while (rest.trim()) {
      rest = rest.trimStart();
      const attr = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/s.exec(rest);
      if (!attr || Object.hasOwn(attrs, attr[1])) throw new Error("invalid package");
      attrs[attr[1]] = decodeXmlAttribute(attr[3]);
      rest = rest.slice(attr[0].length);
    }
    if (closing) {
      if (stack.pop() !== name) throw new Error("invalid package");
      handlers.close?.(name);
    } else {
      handlers.open?.(name, attrs, selfClosing);
      if (selfClosing) handlers.close?.(name);
      else stack.push(name);
    }
  }
  if (stack.length) throw new Error("invalid package");
}

function localName(name) { return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name; }

function parseRelationships(buffer) {
  const relationships = [];
  const ids = new Set();
  tokenizeXml(buffer, { open(name, attrs) {
    if (localName(name) !== "Relationship") return;
    if (!attrs.Id || !attrs.Type || !attrs.Target || String(attrs.TargetMode || "").toLowerCase() === "external") {
      throw new Error("invalid package");
    }
    if (ids.has(attrs.Id)) throw new Error("invalid package");
    ids.add(attrs.Id);
    relationships.push(attrs);
  } });
  return relationships;
}

function relationshipTarget(sourcePart, target) {
  if (typeof target !== "string" || !target || target.includes("\\") || target.includes("\0") || target.includes("%") ||
      target.includes("?") || target.includes("#") || path.posix.isAbsolute(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    throw new Error("invalid package");
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target));
  if (!resolved || resolved === ".." || resolved.startsWith("../")) throw new Error("invalid package");
  return resolved;
}

function mergeCoverage(merges) {
  const covered = new Set();
  for (const merge of merges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(merge);
    if (!match) throw new Error("merge mismatch");
    const startColumn = columnNumber(match[1]);
    const endColumn = columnNumber(match[3]);
    const startRow = Number(match[2]);
    const endRow = Number(match[4]);
    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = startColumn; column <= endColumn; column += 1) {
        if (row !== startRow || column !== startColumn) covered.add(cellAddress(row - 1, column - 1));
      }
    }
  }
  return covered;
}

function columnNumber(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function rectangleAddresses(lastRow, lastColumn) {
  const output = new Set();
  for (let row = 1; row <= lastRow; row += 1) {
    for (let column = 1; column <= lastColumn; column += 1) output.add(cellAddress(row - 1, column - 1));
  }
  return output;
}

function referenceXmlLayout(manifest) {
  const allowed = new Set(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1"]);
  const rows = new Set([1]);
  const merges = ["A1:H1"];
  let anchorRow = 2;
  let lastContentRow = 1;
  manifest.pages.forEach((page, index) => {
    const labelRow = anchorRow;
    if (index > 0) rows.add(labelRow - 1);
    merges.push(`A${labelRow}:H${labelRow}`);
    for (let column = 1; column <= 8; column += 1) allowed.add(cellAddress(labelRow - 1, column - 1));
    const width = 500;
    const height = Math.max(300, Math.min(680, Math.round(width * (Number(page.height) || 2339) / (Number(page.width) || 1653))));
    const imageRows = Math.ceil(height / 20);
    for (let row = labelRow; row <= labelRow + imageRows; row += 1) rows.add(row);
    lastContentRow = labelRow + imageRows;
    anchorRow = labelRow + imageRows + 3;
  });
  return { allowed, rows, merges: merges.sort(), dimension: `A1:H${lastContentRow}`, maxColumn: 8 };
}

function worksheetXmlSpec(name, expectedTables, expectedReview, manifest) {
  if (name === "识别说明") {
    const lastRow = 10 + manifest.pages.length;
    const allowed = new Set(["A1", "B1", "C1", "D1", "E1", "F1", "G1"]);
    for (let row = 2; row <= 8; row += 1) { allowed.add(`A${row}`); allowed.add(`B${row}`); }
    for (let row = 10; row <= lastRow; row += 1) for (let column = 1; column <= 7; column += 1) allowed.add(cellAddress(row - 1, column - 1));
    return { allowed, rows: new Set([1, 2, 3, 4, 5, 6, 7, 8, ...Array.from({ length: lastRow - 9 }, (_, i) => i + 10)]), merges: ["A1:G1"], dimension: `A1:G${lastRow}`, maxColumn: 7, comments: new Set() };
  }
  const table = expectedTables.find((item) => item.sheetName === name);
  if (table) return {
    allowed: rectangleAddresses(table.table.rowCount, table.table.columnCount),
    rows: new Set(Array.from({ length: table.table.rowCount }, (_, i) => i + 1)),
    merges: table.merges,
    dimension: `A1:${cellAddress(table.table.rowCount - 1, table.table.columnCount - 1)}`,
    maxColumn: table.table.columnCount,
    comments: new Set(table.review.map((item) => item.address))
  };
  if (name === "待核对") {
    const rows = Math.max(2, expectedReview.length + 1);
    return { allowed: rectangleAddresses(rows, 6), rows: new Set(Array.from({ length: rows }, (_, i) => i + 1)),
      merges: expectedReview.length ? [] : ["A2:F2"], dimension: `A1:F${rows}`, maxColumn: 6, comments: new Set() };
  }
  if (name === "原件对照") return { ...referenceXmlLayout(manifest), comments: new Set() };
  throw new Error("sheet mismatch");
}

function parseWorksheetXml(buffer) {
  const result = { cells: new Map(), rows: new Set(), merges: [], columns: [], dimension: "", hyperlinks: false, formula: false };
  let activeCell = null;
  tokenizeXml(buffer, {
    open(name, attrs) {
      const local = localName(name);
      if (local === "dimension") result.dimension = attrs.ref || "";
      else if (local === "row") result.rows.add(Number(attrs.r));
      else if (local === "col") result.columns.push([Number(attrs.min), Number(attrs.max)]);
      else if (local === "mergeCell") result.merges.push(attrs.ref || "");
      else if (local === "hyperlink") result.hyperlinks = true;
      else if (local === "c") {
        if (!/^[A-Z]+[1-9]\d*$/.test(attrs.r || "") || result.cells.has(attrs.r)) throw new Error("cell mismatch");
        activeCell = { hasData: false };
        result.cells.set(attrs.r, activeCell);
      } else if (local === "f") { result.formula = true; if (activeCell) activeCell.hasData = true; }
      else if (activeCell) activeCell.hasData = true;
    },
    close(name) { if (localName(name) === "c") activeCell = null; },
    text(value) { if (activeCell && value.trim()) activeCell.hasData = true; }
  });
  result.merges.sort();
  return result;
}

function parseWorkbookSheets(buffer) {
  const sheets = [];
  tokenizeXml(buffer, { open(name, attrs) {
    if (localName(name) === "sheet") sheets.push({ name: attrs.name, relationshipId: attrs["r:id"] });
  } });
  return sheets;
}

function parseCommentRefs(buffer) {
  const refs = new Set();
  tokenizeXml(buffer, { open(name, attrs) {
    if (localName(name) === "comment") {
      if (!/^[A-Z]+[1-9]\d*$/.test(attrs.ref || "") || refs.has(attrs.ref)) throw new Error("review note mismatch");
      refs.add(attrs.ref);
    }
  } });
  return refs;
}

function worksheetRelationshipsPath(sheetPath) {
  return `${path.posix.dirname(sheetPath)}/_rels/${path.posix.basename(sheetPath)}.rels`;
}

function validateWorksheetXmlPackage(packageInfo, expectedNames, expectedTables, expectedReview, manifest) {
  const workbookXml = packageInfo.buffers.get("xl/workbook.xml");
  const workbookRelsXml = packageInfo.buffers.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !workbookRelsXml) throw new Error("invalid package");
  for (const [name, buffer] of packageInfo.buffers) if (name.endsWith(".rels")) parseRelationships(buffer);
  const sheets = parseWorkbookSheets(workbookXml);
  if (sheets.length !== expectedNames.length || sheets.some((sheet, index) => sheet.name !== expectedNames[index] || !sheet.relationshipId)) {
    throw new Error("sheet mismatch");
  }
  const workbookRels = new Map(parseRelationships(workbookRelsXml).map((relationship) => [relationship.Id, relationship]));
  const referencedComments = new Set();
  const referencedSheets = new Set();
  sheets.forEach((sheet) => {
    const relationship = workbookRels.get(sheet.relationshipId);
    if (!relationship || !relationship.Type.endsWith("/worksheet")) throw new Error("sheet mismatch");
    const sheetPath = relationshipTarget("xl/workbook.xml", relationship.Target);
    if (referencedSheets.has(sheetPath)) throw new Error("sheet mismatch");
    referencedSheets.add(sheetPath);
    const xml = packageInfo.buffers.get(sheetPath);
    if (!xml || !/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath)) throw new Error("sheet mismatch");
    const spec = worksheetXmlSpec(sheet.name, expectedTables, expectedReview, manifest);
    const actual = parseWorksheetXml(xml);
    if (actual.formula) throw new Error("xml formula mismatch");
    if (actual.hyperlinks) throw new Error("xml hyperlink mismatch");
    if (actual.dimension !== spec.dimension) throw new Error("xml dimension mismatch");
    if (JSON.stringify(actual.merges) !== JSON.stringify([...spec.merges].sort())) throw new Error("xml merge mismatch");
    if (actual.columns.some(([min, max]) => !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > spec.maxColumn)) {
      throw new Error("xml column mismatch");
    }
    if ([...actual.rows].some((row) => !spec.rows.has(row))) throw new Error("xml row mismatch");
    const covered = mergeCoverage(spec.merges);
    for (const [address, cell] of actual.cells) {
      if (!spec.allowed.has(address) || (covered.has(address) && cell.hasData)) throw new Error("cell mismatch");
    }
    const relsPath = worksheetRelationshipsPath(sheetPath);
    const rels = packageInfo.buffers.has(relsPath) ? parseRelationships(packageInfo.buffers.get(relsPath)) : [];
    const commentRelationships = rels.filter((item) => item.Type.endsWith("/comments"));
    if (commentRelationships.length > 1) throw new Error("review note mismatch");
    let comments = new Set();
    if (commentRelationships.length) {
      const commentsPath = relationshipTarget(sheetPath, commentRelationships[0].Target);
      const commentsXml = packageInfo.buffers.get(commentsPath);
      if (!commentsXml || referencedComments.has(commentsPath)) throw new Error("review note mismatch");
      referencedComments.add(commentsPath);
      comments = parseCommentRefs(commentsXml);
    }
    if (comments.size !== spec.comments.size || [...comments].some((address) => !spec.comments.has(address) || covered.has(address))) {
      throw new Error("review note mismatch");
    }
  });
  for (const name of packageInfo.names) {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name) && !referencedSheets.has(name)) throw new Error("sheet mismatch");
    if (/^xl\/comments\d+\.xml$/.test(name) && !referencedComments.has(name)) throw new Error("review note mismatch");
  }
}

function validateZeroReviewSheet(reviewSheet) {
  const merges = [...(reviewSheet.model.merges || [])];
  if (reviewSheet.rowCount !== 2 || merges.length !== 1 || merges[0] !== "A2:F2" ||
      reviewSheet.getCell("A2").value !== NO_REVIEW_MESSAGE || notePresent(reviewSheet.getCell("A2").note)) {
    throw new Error("review row count");
  }
  for (const column of ["B", "C", "D", "E", "F"]) {
    const cell = reviewSheet.getCell(`${column}2`);
    if (!cell.isMerged || cell.master?.address !== "A2" || notePresent(cell.note)) {
      throw new Error("review row mismatch");
    }
  }
}

async function validatePdfOfficeXlsx(packagePath, { manifest, assetRoot, fileSystem = fs } = {}) {
  try {
    const info = await fileSystem.lstat(packagePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PACKAGE_BYTES) throw new Error("invalid package");
    const engine = engineMetadata(manifest);
    const expectedTables = tableDescriptors(manifest).map(expectedTable);
    const expectedAssets = await preflightReferenceAssets(manifest, assetRoot, fileSystem);
    const expectedNames = expectedSheetNames(expectedTables);
    const expectedReview = expectedTables.flatMap((expected) => expected.review);
    const packageInfo = await inspectXlsxPackage(packagePath);
    validateWorksheetXmlPackage(packageInfo, expectedNames, expectedTables, expectedReview, manifest);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(packagePath);
    if (workbook.worksheets.length !== expectedNames.length ||
        workbook.worksheets.some((sheet, index) => sheet.name !== expectedNames[index])) throw new Error("sheet mismatch");
    const infoSheet = workbook.getWorksheet("识别说明");
    if (infoSheet.getCell("B3").value !== engine.name ||
        infoSheet.getCell("B4").value !== engine.version ||
        infoSheet.getCell("B5").value !== engine.language ||
        Number(infoSheet.getCell("B6").value) !== HARD_TABLE_CONFIDENCE ||
        Number(infoSheet.getCell("B7").value) !== REVIEW_CELL_CONFIDENCE) throw new Error("metadata mismatch");
    const expectedSummaries = summaryRows(manifest, expectedTables);
    expectedSummaries.forEach((expected, index) => {
      const actual = infoSheet.getRow(11 + index).values.slice(1, 8);
      if (actual.length !== expected.length || actual.some((value, cellIndex) => comparable(value) !== comparable(expected[cellIndex]))) {
        throw new Error("summary mismatch");
      }
    });
    if (infoSheet.rowCount !== 10 + expectedSummaries.length) throw new Error("summary mismatch");

    let meaningful = 0;
    const validatedReview = [];
    for (const expected of expectedTables) {
      const sheet = workbook.getWorksheet(expected.sheetName);
      if (!sheet || sheet.rowCount !== expected.table.rowCount || sheet.columnCount !== expected.table.columnCount) throw new Error("table dimensions");
      const actualMerges = [...(sheet.model.merges || [])].sort();
      if (JSON.stringify(actualMerges) !== JSON.stringify(expected.merges)) throw new Error("merge mismatch");
      for (let row = 0; row < expected.table.rowCount; row += 1) {
        for (let column = 0; column < expected.table.columnCount; column += 1) {
          const actual = sheet.getCell(row + 1, column + 1);
          if (actual.isMerged && actual.master?.address !== actual.address) continue;
          if (comparable(actual.value) !== comparable(expected.values[row][column])) {
            const mismatch = new Error("cell mismatch");
            mismatch.location = `${expected.sheetName}!${cellAddress(row, column)}`;
            throw mismatch;
          }
          if (expected.values[row][column] !== null && String(expected.values[row][column]).trim()) meaningful += 1;
        }
      }
      const expectedReviewByAddress = new Map(expected.review.map((item) => [item.address, item]));
      for (let row = 1; row <= expected.table.rowCount; row += 1) {
        for (let column = 1; column <= expected.table.columnCount; column += 1) {
          const actual = sheet.getCell(row, column);
          if (actual.isMerged && actual.master?.address !== actual.address) continue;
          const reviewItem = expectedReviewByAddress.get(actual.address);
          const highlighted = actual.fill?.fgColor?.argb === REVIEW_FILL_ARGB;
          const hasNote = notePresent(actual.note);
          if (highlighted !== Boolean(reviewItem)) throw new Error("review highlight mismatch");
          if (hasNote !== Boolean(reviewItem) || (reviewItem && noteText(actual.note) !== reviewNote(reviewItem))) {
            throw new Error("review note mismatch");
          }
        }
      }
      validatedReview.push(...expected.review);
    }
    if (!meaningful) throw new Error("no editable table content");
    const reviewSheet = workbook.getWorksheet("待核对");
    if (validatedReview.length) {
      if (reviewSheet.rowCount !== validatedReview.length + 1) throw new Error("review row count");
      validatedReview.forEach((item, index) => {
        const actual = reviewSheet.getRow(index + 2).values.slice(1, 7);
        const expected = [item.pageNumber, item.sheetName, item.address, item.value, item.confidence, item.reference];
        if (actual.length !== expected.length || actual.some((value, cellIndex) => comparable(value) !== comparable(expected[cellIndex]))) {
          throw new Error("review row mismatch");
        }
      });
    } else {
      validateZeroReviewSheet(reviewSheet);
    }
    const referenceSheet = workbook.getWorksheet("原件对照");
    const images = referenceSheet.getImages();
    if (images.length !== manifest.pages.length) throw new Error("reference image count");
    const expectedLabels = manifest.pages.map((page, index) => {
      const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1;
      return `第 ${pageNumber} 页 / Page ${pageNumber}`;
    });
    const actualLabels = [];
    referenceSheet.getColumn(1).eachCell((cell) => {
      if (/^第 \d+ 页 \/ Page \d+$/.test(String(cell.value || ""))) actualLabels.push(cell.value);
    });
    if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels) ||
        new Set(images.map((image) => image.imageId)).size !== images.length) {
      throw new Error("reference label mismatch");
    }
    for (const [index, image] of images.entries()) {
      const media = workbook.getImage(image.imageId);
      if (!media || (!media.buffer && !media.filename)) throw new Error("missing reference media");
      const actualBytes = media.buffer || await fileSystem.readFile(media.filename);
      const expectedBytes = await fileSystem.readFile(expectedAssets[index].path);
      if (sha256(actualBytes) !== sha256(expectedBytes)) throw new Error("reference image mismatch");
    }
    return {
      sheetNames: expectedNames,
      tableSheets: expectedTables.map((item) => item.sheetName),
      reviewCellCount: validatedReview.length,
      referenceImageCount: images.length
    };
  } catch (error) {
    if (isStable(error)) throw error;
    const output = stableError("PDF_OFFICE_OUTPUT_INVALID");
    if (SAFE_VALIDATION_REASONS.has(error?.message)) output.reason = error.message;
    if (error?.message === "cell mismatch" && /^P\d{3,}-T\d{2,}![A-Z]+\d+$/.test(error.location || "")) {
      output.location = error.location;
    }
    throw output;
  }
}

async function existingOutputInfo(outputPath, fileSystem) {
  try {
    return await fileSystem.lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

async function publishAtomically(temporaryPath, outputPath, fileSystem) {
  const existing = await existingOutputInfo(outputPath, fileSystem);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  if (!existing) {
    try { await fileSystem.rename(temporaryPath, outputPath); return; }
    catch { throw stableError("PDF_OFFICE_OUTPUT_INVALID"); }
  }
  const backupPath = `${outputPath}.backup-${crypto.randomUUID()}`;
  try { await fileSystem.rename(outputPath, backupPath); }
  catch { throw stableError("PDF_OFFICE_OUTPUT_INVALID"); }
  try {
    await fileSystem.rename(temporaryPath, outputPath);
  } catch {
    try { await fileSystem.rename(backupPath, outputPath); }
    catch {
      try { await fileSystem.copyFile(backupPath, outputPath); await fileSystem.rm(backupPath, { force: true }); }
      catch {}
    }
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  try { await fileSystem.rm(backupPath, { force: true }); } catch {}
}

async function writePdfOfficeXlsx({
  manifest,
  assetRoot,
  outputPath,
  fileSystem = fs,
  validateWorkbook = validatePdfOfficeXlsx
}) {
  if (typeof outputPath !== "string" || !outputPath) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  const temporaryPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
  try {
    engineMetadata(manifest);
    const expectedTables = tableDescriptors(manifest).map(expectedTable);
    const assets = await preflightReferenceAssets(manifest, assetRoot, fileSystem);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "FlyingMouse Format";
    workbook.company = "FlyingMouse Format";
    workbook.created = new Date("2000-01-01T00:00:00.000Z");
    workbook.modified = new Date("2000-01-01T00:00:00.000Z");
    workbook.calcProperties.fullCalcOnLoad = true;
    addInfoSheet(workbook, manifest, expectedTables);
    expectedTables.forEach((expected) => addTableSheet(workbook, expected));
    const reviewItems = expectedTables.flatMap((expected) => expected.review);
    addReviewSheet(workbook, reviewItems);
    await addReferenceSheet(workbook, assets, fileSystem);
    await workbook.xlsx.writeFile(temporaryPath);
    const temporaryInfo = await fileSystem.lstat(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.size < 1 || temporaryInfo.size > MAX_PACKAGE_BYTES) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    const validation = await validateWorkbook(temporaryPath, { manifest, assetRoot, fileSystem });
    await publishAtomically(temporaryPath, outputPath, fileSystem);
    return validation;
  } catch (error) {
    try {
      const info = await fileSystem.lstat(temporaryPath);
      if (info.isFile() && !info.isSymbolicLink()) await fileSystem.rm(temporaryPath, { force: true });
    } catch {}
    if (isStable(error)) throw error;
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

module.exports = {
  HARD_TABLE_CONFIDENCE,
  REVIEW_CELL_CONFIDENCE,
  validatePdfOfficeXlsx,
  writePdfOfficeXlsx
};
