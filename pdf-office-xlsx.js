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
const REVIEW_FILL_ARGB = "FFFFE2A8";
const MAX_DISPLAY_WARNING_COUNT = 8;
const MAX_WARNING_DETAIL_CHARS = 256;
const NO_REVIEW_MESSAGE = "没有低于人工复核阈值的单元格。";
const SAFE_VALIDATION_REASONS = new Set([
  "sheet mismatch", "metadata mismatch", "table dimensions", "merge mismatch", "cell mismatch",
  "summary mismatch", "review highlight mismatch", "review note mismatch", "no editable table content",
  "review row count", "review row mismatch", "reference image count", "reference label mismatch",
  "reference image mismatch", "missing reference media", "invalid package"
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
  configureSheet(sheet, 2);
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = "扫描 PDF 表格识别说明 / Recognition summary";
  sheet.getCell("A1").font = { name: "Microsoft YaHei", size: 16, bold: true, color: { argb: COLORS.white } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 34;
  const metadata = [
    ["字段", "值"],
    ["识别引擎", String(manifest.engine?.name || "unknown")],
    ["引擎版本", String(manifest.engine?.version || "unknown")],
    ["识别语言", String(manifest.engine?.language || "ch")],
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

async function readBoundedZipEntry(packagePath, entryName) {
  const zipfile = await openZipEntries(packagePath);
  return new Promise((resolve, reject) => {
    let found = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(error);
    };
    zipfile.on("entry", (entry) => {
      if (entry.fileName !== entryName) {
        zipfile.readEntry();
        return;
      }
      if (found || entry.uncompressedSize > MAX_WORKSHEET_XML_BYTES) {
        fail(new Error("invalid package"));
        return;
      }
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = [];
        let total = 0;
        stream.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_WORKSHEET_XML_BYTES) {
            stream.destroy(new Error("invalid package"));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          found = Buffer.concat(chunks);
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      if (!found) reject(new Error("invalid package"));
      else resolve(found);
    });
    zipfile.readEntry();
  });
}

async function validateZeroReviewSheet(packagePath, reviewSheet) {
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
  const xml = (await readBoundedZipEntry(packagePath, `xl/worksheets/sheet${reviewSheet.id}.xml`)).toString("utf8");
  const rowRefs = [...xml.matchAll(/<row\b[^>]*\br="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  if (JSON.stringify(rowRefs) !== JSON.stringify(["1", "2"])) throw new Error("review row count");
  const mergedCells = new Map();
  for (const match of xml.matchAll(/<c\b(?=[^>]*\br="([A-F]2)")[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) {
    if (mergedCells.has(match[1])) throw new Error("review row mismatch");
    mergedCells.set(match[1], match[0]);
  }
  const masterTag = mergedCells.get("A2") || "";
  const masterStyle = /\bs="([^"]+)"/.exec(masterTag)?.[1] || "";
  for (const address of ["B2", "C2", "D2", "E2", "F2"]) {
    const tag = mergedCells.get(address);
    if (!tag) continue;
    const style = /\bs="([^"]+)"/.exec(tag)?.[1] || "";
    if (style !== masterStyle || /<(?:v|is|f)\b/.test(tag) || /\bt="(?!n\b)[^"]+"/.test(tag)) {
      throw new Error("review row mismatch");
    }
  }
}

async function validatePdfOfficeXlsx(packagePath, { manifest, assetRoot, fileSystem = fs } = {}) {
  try {
    const info = await fileSystem.lstat(packagePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PACKAGE_BYTES) throw new Error("invalid package");
    const expectedTables = tableDescriptors(manifest).map(expectedTable);
    const expectedAssets = await preflightReferenceAssets(manifest, assetRoot, fileSystem);
    const expectedNames = expectedSheetNames(expectedTables);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(packagePath);
    if (workbook.worksheets.length !== expectedNames.length ||
        workbook.worksheets.some((sheet, index) => sheet.name !== expectedNames[index])) throw new Error("sheet mismatch");
    const engine = manifest.engine || {};
    const infoSheet = workbook.getWorksheet("识别说明");
    if (infoSheet.getCell("B3").value !== String(engine.name || "unknown") ||
        infoSheet.getCell("B4").value !== String(engine.version || "unknown") ||
        infoSheet.getCell("B5").value !== String(engine.language || "ch") ||
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
    const expectedReview = [];
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
      expectedReview.push(...expected.review);
    }
    if (!meaningful) throw new Error("no editable table content");
    const reviewSheet = workbook.getWorksheet("待核对");
    if (expectedReview.length) {
      if (reviewSheet.rowCount !== expectedReview.length + 1) throw new Error("review row count");
      expectedReview.forEach((item, index) => {
        const actual = reviewSheet.getRow(index + 2).values.slice(1, 7);
        const expected = [item.pageNumber, item.sheetName, item.address, item.value, item.confidence, item.reference];
        if (actual.length !== expected.length || actual.some((value, cellIndex) => comparable(value) !== comparable(expected[cellIndex]))) {
          throw new Error("review row mismatch");
        }
      });
    } else {
      await validateZeroReviewSheet(packagePath, reviewSheet);
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
      reviewCellCount: expectedReview.length,
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
