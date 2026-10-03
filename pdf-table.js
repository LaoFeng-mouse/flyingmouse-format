// pdf-table.js — 飞鼠格式 PDF 表格提取域：PDF.js 文字坐标分行、复杂表格模型、OCR 回退、Excel 工作簿生成。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const { rewriteXlsxNormalFont } = require("./xlsx-normal-font");
const { annotatePdfTextRenderStyles } = require("./pdf-text-render-style");
const { PDFTOPPM_PATH, DOCENGINE_PATH } = require("./config");
const { run, commandExists } = require("./utils");
const { inspectImageMetadata } = require("./image");
const { ocrAvailable, createOcrWorker } = require("./ocr");
const { loadPdfjs } = require("./pdfjs");
const { imageCoverageFromOperators, ocrImageCoverageFromOperators } = require("./pdf-classifier");
const { LIMITS, assertPdfPages } = require("./resource-policy");
const { buildPdfTableWorkbook, detectTableLinesFromRaw } = require("./pdf-table-runtime");
const { reportConversionProgress } = require("./conversion-progress");

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
        const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
        const lines = groupPdfItemsIntoLines(content.items, viewport);
        pages.push({ name: `Page ${pageNumber}`, pageNumber, width: viewport.width,
          height: viewport.height, lines, rows: lines.map((line) => line.cells),
          imageCoverage: imageCoverageFromOperators(operators, pdfjsLib.OPS, viewport),
          ocrImageCoverage: await ocrImageCoverageFromOperators(operators, pdfjsLib.OPS, viewport, page.objs),
          blank: !lines.length && operators.fnArray.length === 0 });
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

function pdfCellDisplayWidth(value) {
  return String(value ?? "").split(/\r?\n/).reduce((maximum, line) => Math.max(maximum,
    Array.from(line).reduce((width, character) => width + (/\p{Mark}/u.test(character) ? 0
      : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u.test(character) ? 2
        : character === "\t" ? 4 : 1), 0)), 0);
}

function applyColumnWidths(sheet, rows, item = {}) {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const widths = Array(count).fill(8);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], Math.min(pdfCellDisplayWidth(cell) + 2, 48));
    });
  }
  // Grid models carry edges; borderless models carry each column's left anchor.
  // Keep those relative widths instead of letting a long ID determine every column.
  const anchors = item.columnAnchors || [];
  const edges = anchors.length === count ? [...anchors, item.bounds?.right] : anchors;
  if (edges.length === count + 1 && edges.every(Number.isFinite)
    && edges.every((edge, index) => index === 0 || edge > edges[index - 1])) {
    const pageWidth = Math.max(Number(item.pageWidth) || 0, edges.at(-1));
    const landscape = Number(item.pageWidth) > Number(item.pageHeight) || count > 8;
    const scale = (landscape ? 770 : 523) / Math.max(1, pageWidth);
    for (let column = 0; column < count; column += 1) {
      widths[column] = Math.max(5, Math.min(60, (edges[column + 1] - edges[column]) * scale / 5.25));
    }
  }
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = Math.round(width * 100) / 100; });
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
      pages: [Number(table.page)],
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

async function extractComplexPdfTableModel(inputPath, options = {}) {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(inputPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });
  let tempDir;
  const rendered = new Map();
  let worker = null;
  let ocrBudgetChecked = false;
  try {
    const pdf = await loadingTask.promise;
    assertPdfPages(pdf.numPages);
    // An accurate result on one native page says nothing about omitted pages.
    // Keep accepted native tables, but independently extract every other page.
    const byPage = new Map();
    if (options.extractTablesViaDocengine || DOCENGINE_PATH) {
      const tables = await (options.extractTablesViaDocengine || extractTablesViaDocengine)(inputPath);
      for (const table of tables) {
        const pageNumber = Number(table.page);
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) continue;
        if (options.classification?.pages?.some(page => page.pageNumber === pageNumber && page.kind === "scanned")) continue;
        if (!byPage.has(pageNumber)) byPage.set(pageNumber, []);
        byPage.get(pageNumber).push({ ...table, page: pageNumber });
      }
    }
    for (const [pageNumber, tables] of byPage) {
      if (!camelotTablesQualityOk(tables)) byPage.delete(pageNumber);
    }
    const nativeModel = camelotTablesToModel([...byPage.values()].flat().sort((a, b) => a.page - b.page));
    let completedPages = byPage.size;
    reportConversionProgress({ stage: "converting", completed: completedPages, total: pdf.numPages, unit: "pages" });
    if (byPage.size === pdf.numPages) return nativeModel;

    const canRender = Boolean(options.renderPage) || await commandExists(PDFTOPPM_PATH, ["-v"]);
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-table-"));
    const ensureRendered = async (pageNumber) => {
      if (!canRender) return null;
      if (!rendered.has(pageNumber)) rendered.set(pageNumber, renderPdfTablePage(inputPath, pageNumber, tempDir));
      return rendered.get(pageNumber);
    };
    async function* pages() {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (byPage.has(pageNumber)) continue;
        const page = await pdf.getPage(pageNumber);
        try {
          const viewport = page.getViewport({ scale: 200 / 72, rotation: page.rotate || 0 });
          let textContent = await page.getTextContent();
          // getTextContent exposes only a generic family. Resolve the actual
          // embedded font names before page.cleanup releases their objects.
          const operatorList = await page.getOperatorList();
          for (const [fontId, style] of Object.entries(textContent.styles || {})) {
            if (!page.commonObjs?.has(fontId)) continue;
            const font = page.commonObjs.get(fontId);
            if (typeof font?.name === "string") style.fontName = font.name;
            if (typeof font?.bold === "boolean") style.bold = font.bold;
            if (typeof font?.italic === "boolean") style.italic = font.italic;
          }
          textContent = annotatePdfTextRenderStyles({ textContent, operatorList, OPS: pdfjsLib.OPS });
          const hasText = textContent.items.some(item => String(item.str || "").trim());
          const blank = !hasText && operatorList.fnArray.length === 0;
          yield {
            pageNumber,
            width: viewport.width,
            height: viewport.height,
            viewport,
            textContent,
            blank
          };
          // The async iterator resumes only after the consumer has finished
          // this page's native/OCR table extraction, including retries.
          reportConversionProgress({ stage: "converting", completed: ++completedPages, total: pdf.numPages, unit: "pages" });
        } finally {
          page.cleanup();
        }
      }
    }

    const fallbackModel = await buildPdfTableWorkbook(pages(), {
      renderPage: options.renderPage || (canRender ? async (page) => {
        const image = await ensureRendered(page.pageNumber);
        const { data: raw, info } = await sharp(image.outputPath, { limitInputPixels: LIMITS.maxImagePixels })
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data: raw, width: info.width, height: info.height, channels: info.channels };
      } : null),
      ocrPage: options.ocrPage || (canRender && ocrAvailable() ? async (page) => {
        reportConversionProgress({ stage: "recognizing", completed: completedPages, total: pdf.numPages, unit: "pages" });
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
      } : null)
    });
    return {
      sheets: [...nativeModel.sheets, ...fallbackModel.sheets].sort((a, b) => a.pages[0] - b.pages[0]),
      summary: [...nativeModel.summary, ...fallbackModel.summary].sort((a, b) => a.pageNumber - b.pageNumber),
      warnings: [...nativeModel.warnings, ...fallbackModel.warnings]
    };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await loadingTask.destroy().catch(() => {});
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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

function formatPdfWorkbookSheet(sheet, rows, { item = {}, table = false, headerRows = [], merges = item.merges || [], rowOffset = 0, compact = false } = {}) {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const landscape = Number(item.pageWidth) > Number(item.pageHeight) || count > 8;
  sheet.pageSetup = {
    orientation: landscape ? "landscape" : "portrait", paperSize: 9,
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    printArea: `A1:${sheet.getCell(Math.max(1, rows.length), count).address}`
  };
  sheet.properties.defaultRowHeight = compact ? 14 : 22;
  sheet.views = [{ showGridLines: !table }];
  const border = { style: "thin", color: { argb: "FF737373" } };
  const mergedAreas = merges.map((range) => ({ top: range.startRow + 1 + rowOffset, left: range.startCol + 1,
    bottom: range.endRow + 1 + rowOffset, right: range.endCol + 1 }));
  for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
    const actualRow = rowIndex + rowOffset;
    const row = sheet.getRow(actualRow);
    const originalHeight = compact && item.rowAnchors?.length === rows.length + 1
      ? (item.rowAnchors[rowIndex] - item.rowAnchors[rowIndex - 1]) * (landscape ? 770 : 523) / item.pageWidth : 0;
    row.height = Math.max(row.height || 0, compact ? Math.max(14, originalHeight) : 22);
    for (let column = 1; column <= count; column += 1) {
      const cell = row.getCell(column);
      if (cell.isMerged && cell.master !== cell) continue;
      const heading = headerRows.includes(rowIndex);
      cell.font = { name: "Microsoft YaHei", size: 10, bold: heading };
      cell.alignment = { vertical: "middle", horizontal: heading ? "center" : "left", wrapText: true };
      if (table) cell.border = { left: border, right: border, top: border, bottom: border };
      if (heading) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F3F7" } };
      const merge = mergedAreas.find((area) => area.top === actualRow && area.left === column);
      let width = sheet.getColumn(column).width || 8;
      if (merge) for (let other = column + 1; other <= merge.right; other += 1) width += sheet.getColumn(other).width || 8;
      const lines = String(cell.value ?? "").split(/\r?\n/).reduce((total, line) => total + Math.max(1,
        Math.ceil(compact ? pdfCellDisplayWidth(line) * 5 / Math.max(1, width * 5.25 - 3)
          : pdfCellDisplayWidth(line) / Math.max(1, width - 2))), 0);
      const requiredHeight = Math.min(409, compact ? lines * 12 + 2 : lines * 14 + 6);
      const rowSpan = merge ? merge.bottom - merge.top + 1 : 1;
      for (let targetRow = actualRow; targetRow < actualRow + rowSpan; targetRow += 1) {
        const target = sheet.getRow(targetRow);
        target.height = Math.max(target.height || (compact ? 14 : 22), Math.ceil(requiredHeight / rowSpan));
      }
    }
  }
}

function pdfFormBlockRows(blocks) {
  const rows = [];
  for (const block of [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const center = block.y + block.height / 2;
    const previous = rows.at(-1);
    if (previous && Math.abs(previous.center - center) <= Math.max(previous.height, block.height) * 0.65) {
      previous.blocks.push(block);
      previous.height = Math.max(previous.height, block.height);
    } else rows.push({ center, height: block.height, blocks: [block] });
  }
  return rows.map((row) => row.blocks.sort((a, b) => a.x - b.x));
}

function isPdfIdentifierHeader(value) {
  const header = String(value || "").toLocaleLowerCase()
    .replace(/[（(][^（）()]*[)）]/g, "").replace(/[\s_\-:：]/g, "");
  return /^(?:身份证(?:号|号码)?|身份證(?:號|號碼)?|证件号(?:码)?|證件號(?:碼)?|学号|學號|工号|工號|编号|編號|编码|編碼|代码|代碼|账号|帳號|賬號|账户号|銀行帳號|银行账号|银行卡号|卡号|卡號|手机号(?:码)?|手機號(?:碼)?|电话号码|電話號碼|邮编|郵編|邮政编码|郵政編碼|(?:学生|员工|客户|供应商|物料|商品|产品|订单|合同|档案|会员)(?:编号|编码|代码|号)|id|identifier|code|student(?:id|number|no)|employee(?:id|number|no)|account(?:number|no)|cardnumber|serial(?:number|no)|order(?:number|no)|documentnumber|identificationnumber|passportnumber|phonenumber|mobile(?:number)?|zipcode|postalcode|postcode)$/.test(header);
}

function sourceExcelFont(style = {}, fallback = {}) {
  return { name: style.fontName || fallback.name || "Arial",
    size: Number.isFinite(style.fontSizePt) && style.fontSizePt > 0 ? style.fontSizePt : fallback.size || 11,
    bold: typeof style.bold === "boolean" ? style.bold : Boolean(fallback.bold),
    italic: typeof style.italic === "boolean" ? style.italic : Boolean(fallback.italic) };
}

function pointColumnWidth(points) {
  const pixels = points / 0.75;
  // OOXML widths already include cell padding. The explicit FangSong 12
  // Normal style has a six-point digit advance:
  // eight pixels at 96 DPI and twelve at 144 DPI. Actual cell fonts stay
  // separate; this avoids Calibri 11's 150% display rounding drift.
  return Math.max(0.01, Math.round(pixels / 8 * 256) / 256);
}

function sourceCellText(cell, text, runs, fallback, pointScale) {
  cell.font = fallback;
  const styles = (runs || []).map(run => sourceExcelFont(run.style, fallback));
  const positionedSpaces = Number.isFinite(pointScale) && runs?.some((run,index)=>index>0 && /^[ \t]+/.test(run.text));
  if (!positionedSpaces && new Set(styles.map(style => JSON.stringify(style))).size < 2) { cell.value = text; return; }
  const richText = []; let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i], start = String(text).indexOf(run.text, cursor);
    if (start < 0) { cell.value = text; return; }
    if (start > cursor) richText.push({ text: String(text).slice(cursor, start), font: fallback });
    const leading=i>0 && positionedSpaces ? run.text.match(/^[ \t]+/)?.[0] : null;
    if(leading) {
      const previous=runs[i-1], gap=Math.max(0,(run.x-previous.x-previous.width)*pointScale);
      // PDF.js inserts layout spaces whose advance is the measured gap,
      // not the CJK face's full half-em space. Preserve their text while
      // using a bounded, known quarter-em space metric for placement.
      const spaceSize=gap/(0.25*leading.length);
      richText.push({text:leading,font:spaceSize<=styles[i].size*1.05
        ? {...styles[i],name:"Times New Roman",size:Math.max(1,spaceSize)} : styles[i]});
      if(run.text.length>leading.length)richText.push({text:run.text.slice(leading.length),font:styles[i]});
    } else richText.push({ text: run.text, font: styles[i] });
    cursor = start + run.text.length;
  }
  if (cursor < String(text).length) richText.push({ text: String(text).slice(cursor), font: fallback });
  cell.value = { richText };
}

function writeSourcePdfFormSheet(sheet, item) {
  const form = item.pageForm, scale = form?.pagePointScale ?? item.pagePointScale;
  if (!Number.isFinite(scale) || scale <= 0 || !item.cellStyles?.some(row => row.some(cell => cell?.style?.fontSizePt))) return false;
  const pageWidth=form.pageWidth*scale,pageHeight=form.pageHeight*scale;
  const shortSide=Math.min(pageWidth,pageHeight),longSide=Math.max(pageWidth,pageHeight);
  const paper = [[9,595.28,841.89],[1,612,792],[5,612,1008],[8,841.89,1190.55],[11,419.53,595.28]]
    .find(([,width,height])=>Math.abs(shortSide-width)<2 && Math.abs(longSide-height)<2);
  if (!paper) return false;
  const count = item.rows[0].length, edges = item.columnAnchors;
  const blocks = [...form.beforeBlocks, ...form.afterBlocks];
  const left = Math.min(item.bounds.left, ...blocks.map(block => block.x));
  const top = Math.min(item.bounds.top, ...blocks.map(block => block.y));
  const right = Math.max(item.bounds.right, ...blocks.map(block => block.x + block.width));
  const gutter = (item.bounds.left - left) * scale;
  const columnOffset = gutter > 0.5 ? 1 : 0;
  const blockColumn = block => {
    if (columnOffset && block.x < edges[0] - 0.5 / scale) return 1;
    let index = edges.findIndex(edge => edge > block.x + 0.1) - 1;
    if (index < 0) index = block.x >= edges.at(-1) ? count - 1 : 0;
    return Math.max(0, Math.min(count - 1, index)) + 1 + columnOffset;
  };
  // Reject ambiguous placement before writing any cells, so the existing
  // conservative extraction remains available without a half-built sheet.
  for (const group of pdfFormBlockRows(blocks)) {
    const starts = group.map(blockColumn);
    if (starts.some((value, index) => index > 0 && value <= starts[index - 1])) return false;
  }
  const points = edges.slice(1).map((edge, index) => (edge - edges[index]) * scale);
  if(item.rowAnchors.slice(1).some((value,index)=>(value-item.rowAnchors[index])*scale>409)
    || blocks.some(block=>Math.max(block.height*scale,sourceExcelFont(block.style).size*1.25)>409))return false;
  // PDF glyphs may touch a border; Excel reserves horizontal cell padding.
  // Borrow at most eight points from an adjacent roomy header, keeping the
  // overall table rectangle fixed instead of clipping an existing line.
  const headerMinimum = points.map((_,c) => {
    const runs=item.cellStyles[0]?.[c]?.runs || [], lines=[];
    for(const run of runs) {
      let line=lines.find(entry=>Math.abs(entry.y-run.y)<Math.max(1,run.height*0.35));
      if(!line)lines.push(line={y:run.y,left:run.x,right:run.x+run.width});
      else {line.left=Math.min(line.left,run.x);line.right=Math.max(line.right,run.x+run.width);}
    }
    return lines.length ? Math.max(...lines.map(line=>(line.right-line.left)*scale))+8.25 : 0;
  });
  const originalWidths=[...points];
  for(let c=0;c<count;c+=1) {
    if((item.merges||[]).some(merge=>merge.startRow===0 && c>=merge.startCol && c<=merge.endCol))continue;
    const missing=Math.ceil((headerMinimum[c]-points[c])*2)/2;
    if(missing<=0 || missing>8)continue;
    const donor=[c-1,c+1].find(index=>index>=0 && index<count && points[index]-headerMinimum[index]>=missing
      && originalWidths[index]-(points[index]-missing)<=8
      && !(item.merges||[]).some(merge=>merge.startRow===0 && index>=merge.startCol && index<=merge.endCol));
    if(donor!==undefined){points[c]+=missing;points[donor]-=missing;}
  }
  const outputEdges=[item.bounds.left];
  for(const width of points)outputEdges.push(outputEdges.at(-1)+width/scale);
  // ExcelJS omits an otherwise unstyled column whose width equals its
  // default sentinel, 9. Make that value explicit in the worksheet too,
  // so an omitted 54-point column never inherits Excel's locale default.
  sheet.properties.defaultColWidth = 9;
  if (columnOffset) sheet.getColumn(1).width = pointColumnWidth(gutter);
  points.forEach((width, index) => { sheet.getColumn(index + 1 + columnOffset).width = pointColumnWidth(width); });
  const fonts = item.cellStyles.flat().map(cell => cell?.style).filter(style => style?.fontName);
  const fontCounts = new Map();
  for (const style of fonts) fontCounts.set(style.fontName, (fontCounts.get(style.fontName) || 0) + 1);
  const commonName = [...fontCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || "Arial";
  const commonSize = fonts.map(style => style.fontSizePt).filter(Number.isFinite).sort((a,b)=>a-b);
  const bodyFont = { name: commonName, size: commonSize[Math.floor(commonSize.length / 2)] || 11, bold: false, italic: false };
  const physicalRows = item.rowAnchors.slice(1).map((value, index) => (value - item.rowAnchors[index]) * scale);
  const normalHeights = physicalRows.slice(1).sort((a,b)=>a-b);
  const normalHeight = normalHeights[Math.floor(normalHeights.length / 2)] || 15;
  sheet.properties.defaultRowHeight = Math.round(normalHeight * 2) / 2;
  // Let Excel derive the font descent instead of ExcelJS's generic 55 value.
  sheet.properties.dyDescent = undefined;
  let rowNumber = 0, cursor = top * scale;
  const newRow = height => { rowNumber += 1; sheet.getRow(rowNumber).height = Math.min(409, Math.max(0.75, height)); return rowNumber; };
  const gap = target => {
    while (target-cursor>0.5) {
      const height=Math.min(409,target-cursor);newRow(height);cursor+=height;
    }
  };
  const append = groupBlocks => {
    for (const group of pdfFormBlockRows(groupBlocks)) {
      gap(Math.min(...group.map(block => block.y)) * scale);
      const height = Math.max(...group.map(block => Math.max(block.height * scale, sourceExcelFont(block.style, bodyFont).size * 1.25)));
      const row = newRow(height);
      const starts = group.map(blockColumn);
      group.forEach((block,index) => {
        const centered = group.length === 1 && block.width > (item.bounds.right-item.bounds.left)*0.35
          && Math.abs(block.x+block.width/2-(item.bounds.left+item.bounds.right)/2)*scale < 4;
        const start = centered ? 1 + columnOffset : starts[index];
        let end = index + 1 < starts.length ? starts[index+1]-1 : count + columnOffset;
        let centeredSpan = centered;
        if(!centered) {
          for(let candidate=start;candidate<=end;candidate+=1) {
            const colLeft=start===1 && columnOffset?left:outputEdges[start-1-columnOffset];
            const colRight=outputEdges[candidate-columnOffset];
            if(colRight-colLeft < block.width+4/scale)continue;
            if(Math.abs((colLeft+colRight-block.width)/2-block.x)*scale<1) {
              centeredSpan=true;end=candidate;break;
            }
          }
        }
        if (end>start) sheet.mergeCells(row,start,row,end);
        const cell = sheet.getCell(row,start), font = sourceExcelFont(block.style,bodyFont);
        sourceCellText(cell,block.text,block.runs,font,scale);
        const columnLeft = start===1 && columnOffset ? left : outputEdges[start-1-columnOffset];
        const padding = Math.max(0,(block.x-columnLeft)*scale);
        cell.alignment={horizontal:centeredSpan?"center":"left",vertical:"middle",wrapText:false,
          ...(centeredSpan?{}:{indent:Math.max(0,Math.round(padding/(font.size*1.5)))})};
      });
      cursor += height;
    }
  };
  append(form.beforeBlocks); gap(item.bounds.top * scale);
  const tableOffset = rowNumber;
  const border = {style:"thin",color:{argb:"FF000000"}};
  for (let r=0;r<item.rows.length;r+=1) {
    const row = newRow(physicalRows[r]);
    for(let c=0;c<count;c+=1) {
      const cell=sheet.getCell(row,c+1+columnOffset), source=item.cellStyles[r]?.[c];
      const font=sourceExcelFont(source?.style,bodyFont);
      sourceCellText(cell,item.rows[r][c],source?.runs,font,scale);
      cell.alignment={horizontal:source?.horizontal || "left",vertical:"middle",wrapText:true};
      cell.border={left:border,right:border,top:border,bottom:border};
      if(r>0 && isPdfIdentifierHeader(item.rows[0][c]))cell.numFmt="@";
    }
    const merged=(item.merges||[]).some(merge=>r>=merge.startRow && r<=merge.endRow);
    // Uniform normal data rows remain automatic: Excel may grow them on edit.
    if(r>0 && !merged && Math.abs(physicalRows[r]-normalHeight)<0.3)sheet.getRow(row).height=undefined;
    cursor+=physicalRows[r];
  }
  for(const merge of item.merges||[])sheet.mergeCells(merge.startRow+1+tableOffset,merge.startCol+1+columnOffset,
    merge.endRow+1+tableOffset,merge.endCol+1+columnOffset);
  append(form.afterBlocks);
  sheet.pageSetup={orientation:pageWidth>pageHeight?"landscape":"portrait",paperSize:paper[0],
    fitToPage:false,scale:100,fitToWidth:1,fitToHeight:0,
    // The left margin and column widths place the source rectangle. The
    // right print boundary needs spare space for printer-metric rounding;
    // at 100% this does not move or stretch any source content.
    margins:{left:left*scale/72,right:0.15,top:top*scale/72,bottom:0.15,header:0,footer:0},
    printArea:`A1:${sheet.getCell(rowNumber,count+columnOffset).address}`};
  sheet.views=[{showGridLines:false,zoomScale:90,topLeftCell:"A1"}];
  return true;
}

function writePdfFormSheet(sheet, item) {
  if (writeSourcePdfFormSheet(sheet, item)) return "source";
  const form = item.pageForm;
  const count = item.rows[0].length;
  const edges = item.columnAnchors;
  const landscape = form.pageWidth > form.pageHeight || count > 8;
  const scale = (landscape ? 770 : 523) / form.pageWidth;
  const tableWidth = item.bounds.right - item.bounds.left;
  const tableCenter = (item.bounds.left + item.bounds.right) / 2;
  const rows = [], blockCells = [], extraHeights = new Map();
  let cursorY;
  const spacer = (nextY) => {
    if (cursorY != null && (nextY - cursorY) * scale > 3) {
      rows.push(Array(count).fill(""));
      extraHeights.set(rows.length, Math.min(55, (nextY - cursorY) * scale));
    }
  };
  const appendBlocks = (blocks, above) => {
    for (const group of pdfFormBlockRows(blocks)) {
      spacer(Math.min(...group.map((block) => block.y)));
      const values = Array(count).fill("");
      const starts = group.map((block) => {
        let column = edges.findIndex((edge) => edge > block.x + 1) - 1;
        if (column < 0) column = block.x >= edges.at(-1) ? count - 1 : 0;
        return Math.max(0, Math.min(count - 1, column));
      });
      if (starts.some((column, index) => index > 0 && column <= starts[index - 1])) {
        return false;
      }
      rows.push(values);
      let height = 14;
      group.forEach((block, index) => {
        const centered = group.length === 1 && block.width > tableWidth * 0.35
          && Math.abs(block.x + block.width / 2 - tableCenter) <= tableWidth * 0.12;
        const start = centered ? 0 : starts[index];
        const end = index + 1 < group.length ? starts[index + 1] - 1 : count - 1;
        values[start] = block.text;
        const fontSize = Math.max(9, Math.min(20, Math.round(block.height * scale * 10) / 10));
        height = Math.max(height, fontSize * 1.3 + 3);
        blockCells.push({ row: rows.length, start: start + 1, end: end + 1,
          fontSize, centered, bold: above && centered && fontSize >= 13 });
      });
      extraHeights.set(rows.length, height);
      cursorY = Math.max(...group.map((block) => block.y + block.height));
    }
    return true;
  };
  if (!appendBlocks(form.beforeBlocks, true)) return false;
  spacer(item.bounds.top);
  const tableOffset = rows.length;
  rows.push(...item.rows.map((row) => [...row]));
  cursorY = item.bounds.bottom;
  if (!appendBlocks(form.afterBlocks, false)) return false;
  applyColumnWidths(sheet, item.rows, item);
  for (const block of blockCells) {
    let widthPoints = 0;
    for (let column = block.start; column <= block.end; column += 1) widthPoints += sheet.getColumn(column).width * 5.25;
    const text = rows[block.row - 1][block.start - 1];
    const lineCount = String(text).split(/\r?\n/).reduce((total, line) => total
      + Math.max(1, Math.ceil(pdfCellDisplayWidth(line) * block.fontSize / 2 / Math.max(1, widthPoints - 4))), 0);
    const requiredHeight = lineCount * block.fontSize * 1.3 + 3;
    if (requiredHeight > 409) return false; // A spreadsheet row cannot display an arbitrarily long paragraph.
    extraHeights.set(block.row, Math.max(extraHeights.get(block.row) || 0, requiredHeight));
  }
  sheet.addRows(rows);
  for (const merge of item.merges || []) sheet.mergeCells(merge.startRow + tableOffset + 1, merge.startCol + 1,
    merge.endRow + tableOffset + 1, merge.endCol + 1);
  for (const block of blockCells) {
    if (block.end > block.start) sheet.mergeCells(block.row, block.start, block.row, block.end);
    const cell = sheet.getCell(block.row, block.start);
    cell.font = { name: "Microsoft YaHei", size: block.fontSize, bold: block.bold };
    cell.alignment = { vertical: "middle", horizontal: block.centered ? "center" : "left", wrapText: true };
  }
  formatPdfWorkbookSheet(sheet, item.rows, { item, table: true, headerRows: [1], rowOffset: tableOffset, compact: true });
  for (const [row, height] of extraHeights) sheet.getRow(row).height = height;
  const sourceDataHeights = (item.rowAnchors || []).slice(2).map((height, index) =>
    (height - item.rowAnchors[index + 1]) * scale).filter((height) => height > 0).sort((a, b) => a - b);
  sheet.properties.defaultRowHeight = Math.min(409, Math.max(14, sourceDataHeights[Math.floor(sourceDataHeights.length / 2)] || 14));
  const identifierColumns = item.rows[0].map(isPdfIdentifierHeader);
  for (let index = 1; index < item.rows.length; index += 1) {
    const specialMergedRow = (item.merges || []).some((merge) => index >= merge.startRow && index <= merge.endRow);
    // Leaving ht/customHeight absent lets Excel grow a normal row when the user
    // enters wrapped text. Fixed source heights otherwise silently hide edits.
    if (!specialMergedRow) sheet.getRow(index + tableOffset + 1).height = undefined;
    identifierColumns.forEach((identifier, column) => {
      if (!identifier) return;
      const cell = sheet.getCell(index + tableOffset + 1, column + 1);
      if (!cell.isMerged || cell.master === cell) cell.numFmt = "@";
    });
  }
  item.rows.forEach((row, index) => row.forEach((value, column) => {
    const confidence = item.cellConfidence?.[index]?.[column];
    if (value && Number.isFinite(confidence) && confidence < 0.75) sheet.getCell(index + tableOffset + 1, column + 1).note =
      `低置信识别 / Low-confidence extraction: ${Math.round(confidence * 100)}%`;
  }));
  sheet.pageSetup.fitToHeight = 0;
  sheet.pageSetup.printArea = `A1:${sheet.getCell(rows.length, count).address}`;
  sheet.views = [{ showGridLines: false, zoomScale: 90, topLeftCell: "A1" }];
  return true;
}

async function writePdfTableWorkbook(model, outputPath) {
  const workbook = new ExcelJS.Workbook();
  let firstTable, sourceFormWritten = false;
  const layoutWarnings = [];
  const orderedSheets = [...(model.sheets || [])].sort((a, b) => Number(String(a.name).endsWith("-Raw")) - Number(String(b.name).endsWith("-Raw")));
  for (const item of orderedSheets) {
    const rows = item.rows?.length ? item.rows : [[""]];
    const sheet = workbook.addWorksheet(sheetName(item.name));
    const table = !String(item.name).endsWith("-Raw");
    const formWritten = table && item.pageForm && writePdfFormSheet(sheet, item);
    if (formWritten === "source") sourceFormWritten = true;
    if (table && item.pageForm && !formWritten) layoutWarnings.push(`${item.name}: complex text placement retained in Raw sheet`);
    if (!formWritten) {
      sheet.addRows(rows);
      for (const merge of item.merges || []) sheet.mergeCells(merge.startRow + 1, merge.startCol + 1, merge.endRow + 1, merge.endCol + 1);
      addPdfTableNotes(sheet, rows, item.cellConfidence);
      applyColumnWidths(sheet, rows, item);
      formatPdfWorkbookSheet(sheet, rows, { item, table, headerRows: table ? [1] : [] });
    }
    if (table && !firstTable) firstTable = sheet;
  }
  const explanation = workbook.addWorksheet("识别说明");
  const explanationRows = [
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
    ...[...(model.warnings || []), ...layoutWarnings].map((warning) => ["Warning", warning])
  ];
  explanation.addRows(explanationRows);
  explanation.mergeCells("A1:E1");
  const noteRow = 4 + (model.summary || []).length;
  const explanationMerges = [{ startRow: 0, startCol: 0, endRow: 0, endCol: 4 }];
  for (let row = noteRow; row <= explanationRows.length; row += 1) {
    explanation.mergeCells(row, 2, row, 5);
    explanationMerges.push({ startRow: row - 1, startCol: 1, endRow: row - 1, endCol: 4 });
  }
  explanation.columns = [{ width: 16 }, { width: 22 }, { width: 14 }, { width: 18 }, { width: 30 }];
  formatPdfWorkbookSheet(explanation, explanationRows, { headerRows: [1, 2], merges: explanationMerges });
  explanation.getCell("A1").font = { name: "Microsoft YaHei", bold: true, size: 14 };

  if (firstTable) workbook.views = [{ activeTab: workbook.worksheets.indexOf(firstTable), firstSheet: 0 }];
  if (sourceFormWritten) {
    const buffer = await workbook.xlsx.writeBuffer();
    await fsp.writeFile(outputPath, await rewriteXlsxNormalFont(buffer));
  } else await workbook.xlsx.writeFile(outputPath);
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
