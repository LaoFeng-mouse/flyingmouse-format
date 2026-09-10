// pdf-table.js — 飞鼠格式 PDF 表格提取域：PDF.js 文字坐标分行、复杂表格模型、OCR 回退、Excel 工作簿生成。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const { PDFTOPPM_PATH, DOCENGINE_PATH } = require("./config");
const { run, commandExists } = require("./utils");
const { inspectImageMetadata } = require("./image");
const { ocrAvailable, createOcrWorker } = require("./ocr");
const { loadPdfjs } = require("./pdfjs");
const { LIMITS, assertPdfPages } = require("./resource-policy");
const { buildPdfTableWorkbook, detectTableLinesFromRaw } = require("./pdf-table-runtime");

function groupPdfItemsIntoLines(items, viewport) {
  // Use the displayed page coordinate system, including /Rotate and CropBox.
  // Raw PDF y coordinates reverse both line order and glyph order on rotated pages.
  const v = viewport?.transform || [1, 0, 0, -1, 0, 0];
  const scale = Math.hypot(v[0], v[1]) || 1;
  const cleanItems = items.flatMap((item) => {
    const text = String(item?.str || "").trim();
    const t = item?.transform;
    if (!text || !Array.isArray(t) || t.length < 6 || !t.every(Number.isFinite)) return [];
    const x = v[0] * t[4] + v[2] * t[5] + v[4];
    const y = v[1] * t[4] + v[3] * t[5] + v[5];
    const dx = v[0] * t[0] + v[2] * t[1];
    const dy = v[1] * t[0] + v[3] * t[1];
    const baselineLength = Math.hypot(dx, dy) || 1;
    const width = Math.max(0, Number(item.width) || 0) * scale;
    const height = Math.max(1, Number(item.height) || Math.hypot(t[2], t[3])) * scale;
    const endX = x + dx / baselineLength * width;
    const endY = y + dy / baselineLength * width;
    return [{ text, x: Math.min(x, endX), y, end: Math.max(x, endX), height,
      bbox: [Math.min(x, endX), Math.min(y, endY) - height, Math.max(x, endX), Math.max(y, endY)],
      fontName: item.fontName, dir: item.dir }];
  }).sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  for (const item of cleanItems) {
    const previous = lines.at(-1);
    const tolerance = Math.max(2, Math.min(item.height, previous?.height || item.height) * 0.28);
    if (previous && Math.abs(previous.y - item.y) <= tolerance) {
      previous.items.push(item);
      previous.height = Math.max(previous.height, item.height);
    } else {
      lines.push({ y: item.y, height: item.height, items: [item] });
    }
  }

  function appendText(left, item, gap, previous) {
    if (!left) return item.text;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left)
      && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.text);
    const adjacentGlyphs = previous.text.length === 1 && item.text.length === 1
      && gap <= Math.max(previous.height, item.height) * 0.85;
    return left + ((cjk || adjacentGlyphs || gap <= item.height * 0.12) ? "" : " ") + item.text;
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    const fragments = [];
    let previous;
    let text = "";
    for (const item of line.items) {
      const gap = previous ? item.x - previous.end : 0;
      text = appendText(text, item, gap, previous);
      if (!fragments.length || gap > Math.max(14, line.height * 1.6)) {
        fragments.push({ x: item.x, text: item.text });
      } else {
        const fragment = fragments.at(-1);
        fragment.text = appendText(fragment.text, item, gap, previous);
      }
      previous = item;
    }
    line.text = text;
    line.fragments = fragments;
    line.bbox = [Math.min(...line.items.map((item) => item.bbox[0])),
      Math.min(...line.items.map((item) => item.bbox[1])),
      Math.max(...line.items.map((item) => item.bbox[2])),
      Math.max(...line.items.map((item) => item.bbox[3]))];
  }
  // A single line of positioned words is prose. Require repeated, nearby column
  // boundaries before making editable table cells; complex tables use the separate engine.
  const aligned = (a, b) => a && b && a.fragments.length > 1
    && a.fragments.length === b.fragments.length
    && Math.abs(a.y - b.y) <= Math.max(a.height, b.height) * 3.5
    && a.fragments.every((fragment, index) => Math.abs(fragment.x - b.fragments[index].x) <= 10)
    && a.fragments.every((fragment) => fragment.text.length < 80)
    && b.fragments.every((fragment) => fragment.text.length < 80);
  lines.forEach((line, index) => {
    line.cells = aligned(line, lines[index - 1]) || aligned(line, lines[index + 1])
      ? line.fragments.map((fragment) => fragment.text) : [line.text];
  });
  return lines;
}

function groupPdfItemsIntoRows(items, viewport) {
  return groupPdfItemsIntoLines(items, viewport).map((line) => line.cells);
}

async function extractPdfRowsByPage(inputPath) {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(inputPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });
  const pages = [];
  try {
    const pdf = await loadingTask.promise;
    assertPdfPages(pdf.numPages);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
        const content = await page.getTextContent();
        const lines = groupPdfItemsIntoLines(content.items, viewport);
        pages.push({ name: `Page ${pageNumber}`, pageNumber, width: viewport.width,
          height: viewport.height, lines, rows: lines.map((line) => line.cells) });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

function sheetName(value) {
  return String(value).replace(/[\\/?*:[\]]/g, " ").slice(0, 31) || "Sheet";
}

function applyColumnWidths(sheet, rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const length = String(cell || "").length;
      widths[index] = Math.max(widths[index] || 8, Math.min(length + 2, 48));
    });
  }
  sheet.columns = widths.map((wch) => ({ width: wch }));
}

async function renderPdfTablePage(inputPath, pageNumber, tempDir, dpi = 200) {
  const prefix = path.join(tempDir, `page-${String(pageNumber).padStart(3, "0")}`);
  await run(PDFTOPPM_PATH, [
    "-png", "-cropbox", "-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber),
    "-singlefile", inputPath, prefix
  ], { timeout: 1000 * 60 * 5 });
  const outputPath = `${prefix}.png`;
  if (!fs.existsSync(outputPath)) throw new Error(`PDF page ${pageNumber} could not be rendered for table extraction.`);
  const metadata = await inspectImageMetadata(outputPath);
  return { outputPath, metadata };
}

async function preparePdfTableOcrImage(imagePath, tempDir, pageNumber) {
  const outputPath = path.join(tempDir, `ocr-clean-${String(pageNumber).padStart(3, "0")}.png`);
  const { data, info } = await sharp(imagePath, { limitInputPixels: LIMITS.maxImagePixels })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // 擦线用较低竖线阈值：扫描件表格竖线常断裂/较淡（实测中间列分隔线仅 223px ≈ 9.5% 页高，
  // 默认 0.20 会漏掉 → 断线被 OCR 识别成 `|` 字符混进文字）。
  // 低阈值会顺带检测到字形竖笔/字母笔画，靠「跨横线」过滤兜底（见下）。
  const lines = detectTableLinesFromRaw({
    data, width: info.width, height: info.height, channels: info.channels,
    verticalMinLengthRatio: 0.05
  });
  // 只擦「表格线」：横线全擦；竖线必须跨越 ≥2 条横线（与横线交叉）才是表格列线，
  // 字形竖笔/字母笔画局限在单行内、不跨横线，绝不能擦（否则文字缺笔画 → OCR 质量崩）。
  const horizontalLines = lines.filter((line) => Math.abs(line.y2 - line.y1) <= Math.abs(line.x2 - line.x1));
  const verticalLines = lines.filter((line) => Math.abs(line.y2 - line.y1) > Math.abs(line.x2 - line.x1));
  const horizontalYs = horizontalLines.map((line) => (line.y1 + line.y2) / 2).sort((a, b) => a - b);
  const eraseLines = [
    ...horizontalLines,
    ...verticalLines.filter((line) => horizontalYs.filter((y) => y >= line.y1 - 3 && y <= line.y2 + 3).length >= 2)
  ];
  const pipeline = sharp(imagePath, { limitInputPixels: LIMITS.maxImagePixels })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1 });
  if (eraseLines.length) {
    const rectangles = eraseLines.map((line) => {
      const eraseHalfWidth = Math.max(2, Math.ceil((Number(line.thickness) || 1) / 2) + 1);
      const horizontal = Math.abs(line.y2 - line.y1) <= Math.abs(line.x2 - line.x1);
      if (horizontal) {
        return `<rect x="${Math.max(0, line.x1 - 2)}" y="${Math.max(0, line.y1 - eraseHalfWidth)}" width="${Math.max(1, line.x2 - line.x1 + 4)}" height="${eraseHalfWidth * 2}" fill="white"/>`;
      }
      return `<rect x="${Math.max(0, line.x1 - eraseHalfWidth)}" y="${Math.max(0, line.y1 - 2)}" width="${eraseHalfWidth * 2}" height="${Math.max(1, line.y2 - line.y1 + 4)}" fill="white"/>`;
    }).join("");
    const overlay = Buffer.from(`<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg">${rectangles}</svg>`);
    pipeline.composite([{ input: overlay }]);
  }
  await pipeline.png().toFile(outputPath);
  return outputPath;
}

async function recognizePdfTablePage(worker, imagePath, tempDir, pageNumber) {
  const ocrImagePath = await preparePdfTableOcrImage(imagePath, tempDir, pageNumber);
  const result = await worker.recognize(ocrImagePath, {}, { text: true, blocks: true });
  return result;
}

// 调用文档引擎（docengine table = camelot）提取表格，返回 camelot 的 tables 数组；失败/无引擎返回 []。
async function extractTablesViaDocengine(inputPath) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-camelot-"));
  const jsonPath = path.join(tempDir, "tables.json");
  try {
    await run(DOCENGINE_PATH, ["table", inputPath, jsonPath], { timeout: 1000 * 60 * 10 });
    if (!fs.existsSync(jsonPath)) return [];
    const data = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
    return Array.isArray(data.tables) ? data.tables : [];
  } catch (error) {
    return [];
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// camelot 的 tables 数组转成 writePdfTableWorkbook 需要的 model 结构。
function camelotTablesToModel(tables) {
  const summary = [];
  const sheets = [];
  tables.forEach((table, index) => {
    const accuracy = Number.isFinite(table.accuracy) ? table.accuracy : 100;
    summary.push({
      pageNumber: table.page,
      source: `camelot-${table.flavor}`,
      tableCount: 1,
      confidence: accuracy / 100,
      warnings: []
    });
    sheets.push({
      name: `P${String(table.page).padStart(3, "0")}-T${String(index + 1).padStart(2, "0")}`,
      rows: Array.isArray(table.cells) ? table.cells : [],
      merges: [],
      cellConfidence: undefined
    });
  });
  return { summary, sheets, warnings: [] };
}

// camelot 结果质量门槛：平均准确率 + 非空单元格比例，避免「裁剪/特殊布局」表格被 camelot 错乱提取后不回退。
function camelotTablesQualityOk(tables) {
  if (!tables.length) return false;
  let totalAccuracy = 0;
  let totalCells = 0;
  let nonEmptyCells = 0;
  for (const t of tables) {
    totalAccuracy += Number.isFinite(t.accuracy) ? t.accuracy : 0;
    for (const row of (t.cells || [])) {
      for (const cell of row) {
        totalCells += 1;
        if (String(cell ?? "").trim() !== "") nonEmptyCells += 1;
      }
    }
  }
  const avgAccuracy = totalAccuracy / tables.length;
  const fillRatio = totalCells ? nonEmptyCells / totalCells : 0;
  return avgAccuracy >= 60 && fillRatio >= 0.5;
}

async function extractComplexPdfTableModel(inputPath) {
  // 优先用文档引擎（docengine table = camelot）提取表格；引擎缺失、无结果或质量差时回退到 PDF.js 自研提取。
  if (DOCENGINE_PATH) {
    const tables = await extractTablesViaDocengine(inputPath);
    if (camelotTablesQualityOk(tables)) {
      return camelotTablesToModel(tables);
    }
  }

  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(inputPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });
  const pdf = await loadingTask.promise;
  assertPdfPages(pdf.numPages);
  const canRender = await commandExists(PDFTOPPM_PATH, ["-v"]);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-table-"));
  const rendered = new Map();
  let worker = null;
  let ocrBudgetChecked = false;

  const ensureRendered = async (pageNumber) => {
    if (!canRender) return null;
    if (!rendered.has(pageNumber)) rendered.set(pageNumber, renderPdfTablePage(inputPath, pageNumber, tempDir));
    return rendered.get(pageNumber);
  };

  try {
    async function* pages() {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        try {
          const viewport = page.getViewport({ scale: 200 / 72, rotation: page.rotate || 0 });
          yield {
            pageNumber,
            width: viewport.width,
            height: viewport.height,
            viewport,
            textContent: await page.getTextContent()
          };
        } finally {
          page.cleanup();
        }
      }
    }

    return await buildPdfTableWorkbook(pages(), {
      renderPage: canRender ? async (page) => {
        const image = await ensureRendered(page.pageNumber);
        const { data: raw, info } = await sharp(image.outputPath, { limitInputPixels: LIMITS.maxImagePixels })
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data: raw, width: info.width, height: info.height, channels: info.channels };
      } : null,
      ocrPage: canRender && ocrAvailable() ? async (page) => {
        if (!ocrBudgetChecked) {
          assertPdfPages(pdf.numPages, { ocr: true });
          ocrBudgetChecked = true;
        }
        if (!worker) {
          worker = await createOcrWorker();
          await worker.setParameters({ user_defined_dpi: "200" });
        }
        const image = await ensureRendered(page.pageNumber);
        return recognizePdfTablePage(worker, image.outputPath, tempDir, page.pageNumber);
      } : null
    });
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await loadingTask.destroy().catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function addPdfTableNotes(sheet, rows, confidenceRows) {
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    const confidence = confidenceRows?.[rowIndex]?.[columnIndex];
    if (value && Number.isFinite(confidence) && confidence < 0.75) {
      sheet.getCell(rowIndex + 1, columnIndex + 1).note = `低置信识别 / Low-confidence extraction: ${Math.round(confidence * 100)}%`;
    }
  }));
}

async function writePdfTableWorkbook(model, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const explanation = workbook.addWorksheet("识别说明");
  explanation.addRows([
    ["FlyingMouse PDF → Excel 智能表格提取 / Smart table extraction"],
    ["页码 / Page", "来源 / Source", "表格数 / Tables", "置信度 / Confidence", "警告 / Warnings"],
    ...(model.summary || []).map((entry) => [
      entry.pageNumber,
      entry.source,
      entry.tableCount,
      Math.round((entry.confidence || 0) * 100) / 100,
      (entry.warnings || []).join("; ")
    ]),
    [],
    ["提示 / Note", "扫描件、复杂表头和合并单元格可能需要人工复核；低置信单元格带有批注。 / Scans, complex headers, and merged cells may require review; low-confidence cells include notes."],
    ...(model.warnings || []).map((warning) => ["Warning", warning])
  ]);
  explanation.getRow(1).font = { bold: true, size: 14 };
  explanation.getRow(2).font = { bold: true };
  applyColumnWidths(explanation, explanation.getSheetValues().slice(1));

  for (const item of model.sheets || []) {
    const rows = item.rows?.length ? item.rows : [[""]];
    const sheet = workbook.addWorksheet(sheetName(item.name));
    sheet.addRows(rows);
    for (const merge of item.merges || []) {
      sheet.mergeCells(merge.startRow + 1, merge.startCol + 1, merge.endRow + 1, merge.endCol + 1);
    }
    addPdfTableNotes(sheet, rows, item.cellConfidence);
    applyColumnWidths(sheet, rows);
  }
  await workbook.xlsx.writeFile(outputPath);
}

module.exports = {
  groupPdfItemsIntoLines,
  groupPdfItemsIntoRows,
  extractPdfRowsByPage,
  sheetName,
  applyColumnWidths,
  renderPdfTablePage,
  preparePdfTableOcrImage,
  recognizePdfTablePage,
  extractComplexPdfTableModel,
  addPdfTableNotes,
  writePdfTableWorkbook
};
