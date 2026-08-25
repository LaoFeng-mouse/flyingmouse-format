// pdf-scanned-table.js — 扫描件 PDF → 可编辑 docx 表格：纯 JS 表格线检测 + 网格重建。
// 定位：当 PDF 无可提取文字（扫描件）且目标为 docx 时，检测有没有表格线；
// 有 → 逐格 OCR 重建 docx 表格；没有 → 回落现有纯文本段落。
// 纯 JS 实现（sharp 读灰度像素），不引外部 Python/OpenCV。

const sharp = require("sharp");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

// 二值化阈值（Otsu 近似）：低于阈值为前景（黑字/黑线）
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = i; }
  }
  return threshold;
}

// 检测水平线 y 坐标：对每行统计前景像素数，超过阈值（行内连续长横线）的为表格横线。
// 基于形态学「水平开运算」思路：一个像素只有当其左右各 minRun 像素同为前景才算横向结构。
function detectHorizontalLines(pix, width, height, {
  minRun = 40,           // 最小连续长度（水平开运算核宽）
  ratio = 0.35,          // 该行前景占比阈值
  threshold = 128        // 二值化阈值（<threshold 判前景）；detectTableGrid 会注入 Otsu 值
} = {}) {
  const rowFill = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let cnt = 0;
    let run = 0;
    for (let x = 0; x < width; x++) {
      if (pix[base + x] <= threshold) {
        run += 1;
        if (run >= minRun) cnt += 1;
      } else {
        run = 0;
      }
    }
    rowFill[y] = cnt;
  }
  const max = Math.max(...rowFill, 1);
  const th = max * ratio;
  // 聚相邻行（同一条线的多像素行）去重
  const lines = [];
  let runStart = -1;
  for (let y = 0; y < height; y++) {
    if (rowFill[y] > th) {
      if (runStart === -1) runStart = y;
    } else if (runStart !== -1) {
      lines.push(Math.round((runStart + y - 1) / 2)); // 线中心
      runStart = -1;
    }
  }
  if (runStart !== -1) lines.push(Math.round((runStart + height - 1) / 2));
  return lines;
}

// 检测垂直线 x 坐标：同理对每列统计（垂直开运算）
function detectVerticalLines(pix, width, height, { minRun = 40, ratio = 0.35, threshold = 128 } = {}) {
  const colFill = new Array(width).fill(0);
  for (let x = 0; x < width; x++) {
    let cnt = 0, run = 0;
    for (let y = 0; y < height; y++) {
      if (pix[y * width + x] <= threshold) {
        run += 1;
        if (run >= minRun) cnt += 1;
      } else {
        run = 0;
      }
    }
    colFill[x] = cnt;
  }
  const max = Math.max(...colFill, 1);
  const th = max * ratio;
  const lines = [];
  let runStart = -1;
  for (let x = 0; x < width; x++) {
    if (colFill[x] > th) {
      if (runStart === -1) runStart = x;
    } else if (runStart !== -1) {
      lines.push(Math.round((runStart + x - 1) / 2));
      runStart = -1;
    }
  }
  if (runStart !== -1) lines.push(Math.round((runStart + width - 1) / 2));
  return lines;
}

// 从渲染图检测表格网格：返回 { rows: [y...], cols: [x...], nRows, nCols }。无表格返回 null。
async function detectTableGrid(imagePath, options = {}) {
  const { data, info } = await sharp(imagePath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const pix = data;
  // 用 Otsu 自适应阈值二值化（较固定 128 更适配灰底/低对比扫描件；纯黑白图 Otsu≈127，与此前等价）。
  const threshold = options.threshold ?? otsuThreshold(pix);
  const hLines = detectHorizontalLines(pix, width, height, { ...options.h, threshold });
  const vLines = detectVerticalLines(pix, width, height, { ...options.v, threshold });
  if (hLines.length < 2 || vLines.length < 2) return null; // 需要至少 2 横线 + 2 竖线才成网格
  return {
    rows: hLines,
    cols: vLines,
    nRows: hLines.length - 1,
    nCols: vLines.length - 1,
    width,
    height,
    threshold
  };
}

// 从网格裁切单个单元格图（带少量 margin），返回裁剪后的 PNG buffer。
async function cropCellBuffer(imagePath, grid, r, c, margin = 2) {
  const y0 = grid.rows[r] + margin;
  const y1 = grid.rows[r + 1] - margin;
  const x0 = grid.cols[c] + margin;
  const x1 = grid.cols[c + 1] - margin;
  if (y1 <= y0 || x1 <= x0) return null;
  const { data, info } = await sharp(imagePath)
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer({ resolveWithObject: true });
  return data;
}

// 说明（跨行/跨列合并）：本重建是启发式，逐行逐列按检测到的网格线输出单元格。
// 不做自动跨行/跨列合并——因为「文字内容相同」不等于「跨行」（同列重复值如 N/A、编号、勾选、
// 日期会被误合并造成塌格），而正确合并需要逐格线连续性/几何检测，超出当前输入信息。
// 宁可每个检测格独立输出，也不要错误合并破坏表格结构。

// 把检测到的网格 + 单元格文字重建为 docx 表格（用项目的 docx 库）。
async function buildDocxTable(rows, cols, cellTexts, { title }) {
  const {
    Document, Packer, Table, TableRow, TableCell, Paragraph, TextRun,
    WidthType, AlignmentType
  } = require("docx");
  const tableRows = [];
  for (let r = 0; r < rows; r++) {
    const cs = [];
    for (let c = 0; c < cols; c++) {
      cs.push(new TableCell({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: cellTexts[r][c] || "", size: 20 })]
          })
        ]
      }));
    }
    tableRows.push(new TableRow({ children: cs }));
  }
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: title || "", bold: true, size: 32 })] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows
        })
      ]
    }]
  });
  return Packer.toBuffer(doc);
}

// 高层入口：对单张扫描页图，检测表格 → 逐格 OCR → 重建 docx 表格字节。
// worker 由调用方传入（复用 ocr.js 的 createOcrWorker，避免每次重建）。
// 返回 Buffer(docx) 或 null（无表格线时，调用方应回落纯文本段落）。
async function buildDocxFromScannedPage(imagePath, worker, { title = "" } = {}) {
  const grid = await detectTableGrid(imagePath);
  if (!grid) return null; // 无表格线 → 回落
  const cellTexts = [];
  for (let r = 0; r < grid.nRows; r++) {
    const row = [];
    for (let c = 0; c < grid.nCols; c++) {
      const buf = await cropCellBuffer(imagePath, grid, r, c);
      let text = "";
      if (buf) {
        const tmp = path.join(os.tmpdir(), `fm-cell-${crypto.randomUUID()}.png`);
        try {
          // recognize 需要文件路径，因此把裁剪格写出临时 PNG
          await fsp.writeFile(tmp, buf);
          const { data } = await worker.recognize(tmp);
          text = String(data?.text || "").replace(/\s+/g, " ").trim();
        } catch (e) {
          text = "";
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
      }
      row.push(text);
    }
    cellTexts.push(row);
  }
  return buildDocxTable(grid.nRows, grid.nCols, cellTexts, { title });
}

module.exports = { detectTableGrid, detectHorizontalLines, detectVerticalLines, otsuThreshold, cropCellBuffer, buildDocxTable, buildDocxFromScannedPage };
