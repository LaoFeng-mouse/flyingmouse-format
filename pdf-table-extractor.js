"use strict";

const LOW_CONFIDENCE = 0.75;
const MAX_WORDS_PER_PAGE = 10000;
const MAX_LINES_PER_PAGE = 2000;
const MAX_GRID_CELLS = 25000;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return clamp(numeric > 1 ? numeric / 100 : numeric);
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  if (words.length > MAX_WORDS_PER_PAGE) throw new Error("PDF page has too many text items");
  return words
    .map((entry, id) => ({ entry, id }))
    .filter(({ entry }) => entry && String(entry.text || "").trim() && [entry.x, entry.y, entry.width, entry.height]
      .every((value) => value == null || Number.isFinite(Number(value))))
    .map(({ entry, id }) => ({
      id,
      text: String(entry.text).trim(),
      x: Number(entry.x) || 0,
      y: Number(entry.y) || 0,
      width: Math.max(0, Number(entry.width) || 0),
      height: Math.max(1, Number(entry.height) || 1),
      confidence: normalizeConfidence(entry.confidence == null ? 1 : entry.confidence)
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function clusterRows(words) {
  if (!words.length) return [];
  const tolerance = Math.max(3, median(words.map((entry) => entry.height)) * 0.65);
  const rows = [];
  for (const entry of words) {
    const center = entry.y + entry.height / 2;
    let row = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (center - rows[index].center > tolerance) break;
      if (Math.abs(rows[index].center - center) <= tolerance) { row = rows[index]; break; }
    }
    if (!row) {
      row = { center, words: [] };
      rows.push(row);
    }
    row.words.push(entry);
    row.center = row.words.reduce((sum, word) => sum + word.y + word.height / 2, 0) / row.words.length;
  }
  return rows
    .sort((a, b) => a.center - b.center)
    .map((row) => ({ ...row, words: row.words.sort((a, b) => a.x - b.x) }));
}

function splitRowBlocks(rows) {
  if (rows.length < 2) return rows.length ? [rows] : [];
  const gaps = rows.slice(1).map((row, index) => row.center - rows[index].center);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const ordinaryGap = median(sortedGaps.slice(0, Math.max(1, Math.ceil(sortedGaps.length / 2))));
  const threshold = Math.max(60, ordinaryGap * 2.5);
  const blocks = [[]];
  rows.forEach((row, index) => {
    if (index > 0 && row.center - rows[index - 1].center > threshold) blocks.push([]);
    blocks[blocks.length - 1].push(row);
  });
  return blocks;
}

function clusterAnchors(rows, pageWidth) {
  const tolerance = Math.max(8, (Number(pageWidth) || 0) * 0.02);
  const anchors = [];
  const entries = rows.flatMap((row) => row.words).sort((a, b) => a.x - b.x);
  for (const entry of entries) {
    let anchor = anchors[anchors.length - 1];
    if (anchor && Math.abs(anchor.x - entry.x) > tolerance) anchor = null;
    if (!anchor) {
      anchor = { x: entry.x, samples: [] };
      anchors.push(anchor);
    }
    anchor.samples.push(entry.x);
    anchor.x = median(anchor.samples);
  }
  return anchors.sort((a, b) => a.x - b.x).map((entry) => entry.x);
}

function wordsToCells(row, anchors) {
  const cells = Array.from({ length: anchors.length }, () => []);
  for (const entry of row.words) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    anchors.forEach((anchor, index) => {
      const distance = Math.abs(entry.x - anchor);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    cells[bestIndex].push(entry);
  }
  return cells.map((entries) => entries.sort((a, b) => a.x - b.x));
}

function confidenceOfWords(words, structuralFactor = 1) {
  if (!words.length) return 0;
  return clamp((words.reduce((sum, entry) => sum + entry.confidence, 0) / words.length) * structuralFactor);
}

function makeBorderlessTable(rows, pageWidth, pageNumber) {
  if (rows.length < 2) return null;
  const anchors = clusterAnchors(rows, pageWidth);
  if (anchors.length < 2) return null;
  const cellWords = rows.map((row) => wordsToCells(row, anchors));
  const populatedRows = cellWords.filter((row) => row.filter((cell) => cell.length).length >= 2);
  if (populatedRows.length < 2) return null;
  const allWords = rows.flatMap((row) => row.words);
  return {
    rows: cellWords.map((row) => row.map((cell) => cell.map((entry) => entry.text).join(" "))),
    merges: [],
    confidence: confidenceOfWords(allWords, 0.85),
    cellConfidence: cellWords.map((row) => row.map((cell) => confidenceOfWords(cell))),
    pages: [pageNumber],
    columnAnchors: anchors,
    bounds: {
      left: Math.min(...allWords.map((entry) => entry.x)),
      top: Math.min(...allWords.map((entry) => entry.y)),
      right: Math.max(...allWords.map((entry) => entry.x + entry.width)),
      bottom: Math.max(...allWords.map((entry) => entry.y + entry.height))
    },
    wordIds: allWords.map((entry) => entry.id)
  };
}

function uniqueCoordinates(values, tolerance = 2) {
  const result = [];
  for (const value of values.sort((a, b) => a - b)) {
    const last = result[result.length - 1];
    if (last == null || Math.abs(last - value) > tolerance) result.push(value);
    else result[result.length - 1] = (last + value) / 2;
  }
  return result;
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return { horizontal: [], vertical: [] };
  if (lines.length > MAX_LINES_PER_PAGE) throw new Error("PDF page has too many vector lines");
  const horizontal = [];
  const vertical = [];
  for (const line of lines) {
    if (!line) continue;
    const x1 = Number(line.x1); const x2 = Number(line.x2);
    const y1 = Number(line.y1); const y2 = Number(line.y2);
    if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
    if (Math.abs(y2 - y1) <= 2 && Math.abs(x2 - x1) >= 8) horizontal.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    if (Math.abs(x2 - x1) <= 2 && Math.abs(y2 - y1) >= 8) vertical.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
  }
  return { horizontal, vertical };
}

function coversSegment(line, start, end, tolerance = 3) {
  const lineStart = line.y1 == null ? line.x1 : line.y1;
  const lineEnd = line.y2 == null ? line.x2 : line.y2;
  return lineStart <= start + tolerance && lineEnd >= end - tolerance;
}

function splitLineComponents(lines) {
  const normalized = normalizeLines(lines);
  const entries = [
    ...normalized.horizontal.map((line) => ({ type: "h", line })),
    ...normalized.vertical.map((line) => ({ type: "v", line }))
  ];
  const parent = entries.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const unite = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left]; const b = entries[right];
      let connected = false;
      if (a.type !== b.type) {
        const h = a.type === "h" ? a.line : b.line;
        const v = a.type === "v" ? a.line : b.line;
        connected = v.x >= h.x1 - 3 && v.x <= h.x2 + 3 && h.y >= v.y1 - 3 && h.y <= v.y2 + 3;
      } else if (a.type === "h") {
        connected = Math.abs(a.line.y - b.line.y) <= 2 && a.line.x1 <= b.line.x2 + 3 && b.line.x1 <= a.line.x2 + 3;
      } else {
        connected = Math.abs(a.line.x - b.line.x) <= 2 && a.line.y1 <= b.line.y2 + 3 && b.line.y1 <= a.line.y2 + 3;
      }
      if (connected) unite(left, right);
    }
  }
  const groups = new Map();
  entries.forEach((entry, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry.type === "h"
      ? { x1: entry.line.x1, y1: entry.line.y, x2: entry.line.x2, y2: entry.line.y }
      : { x1: entry.line.x, y1: entry.line.y1, x2: entry.line.x, y2: entry.line.y2 });
  });
  return [...groups.values()];
}

function makeGridTable(words, lines, pageNumber) {
  const normalized = normalizeLines(lines);
  const xs = uniqueCoordinates(normalized.vertical.map((line) => line.x));
  const ys = uniqueCoordinates(normalized.horizontal.map((line) => line.y));
  if (xs.length < 3 || ys.length < 3) return null;
  const rowCount = ys.length - 1;
  const columnCount = xs.length - 1;
  const size = rowCount * columnCount;
  if (!Number.isSafeInteger(size) || size > MAX_GRID_CELLS) throw new Error("PDF table grid is too large");
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const unite = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const indexOf = (row, column) => row * columnCount + column;
  for (let row = 0; row < rowCount; row += 1) {
    for (let boundary = 1; boundary < columnCount; boundary += 1) {
      const present = normalized.vertical.some((line) => Math.abs(line.x - xs[boundary]) <= 2 && coversSegment(line, ys[row], ys[row + 1]));
      if (!present) unite(indexOf(row, boundary - 1), indexOf(row, boundary));
    }
  }
  for (let boundary = 1; boundary < rowCount; boundary += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const present = normalized.horizontal.some((line) => Math.abs(line.y - ys[boundary]) <= 2 && coversSegment(line, xs[column], xs[column + 1]));
      if (!present) unite(indexOf(boundary - 1, column), indexOf(boundary, column));
    }
  }
  const groups = new Map();
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const root = find(indexOf(row, column));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ row, column });
    }
  }
  const cellWords = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => []));
  for (const entry of words) {
    const centerX = entry.x + entry.width / 2;
    const centerY = entry.y + entry.height / 2;
    const column = xs.findIndex((left, index) => index < columnCount && centerX >= left - 2 && centerX <= xs[index + 1] + 2);
    const row = ys.findIndex((top, index) => index < rowCount && centerY >= top - 2 && centerY <= ys[index + 1] + 2);
    if (row >= 0 && column >= 0) cellWords[row][column].push(entry);
  }
  const rows = Array.from({ length: rowCount }, () => Array(columnCount).fill(""));
  const cellConfidence = Array.from({ length: rowCount }, () => Array(columnCount).fill(0));
  const merges = [];
  for (const cells of groups.values()) {
    const startRow = Math.min(...cells.map((cell) => cell.row));
    const endRow = Math.max(...cells.map((cell) => cell.row));
    const startCol = Math.min(...cells.map((cell) => cell.column));
    const endCol = Math.max(...cells.map((cell) => cell.column));
    const rectangular = cells.length === (endRow - startRow + 1) * (endCol - startCol + 1);
    if (rectangular) {
      const entries = cells.flatMap((cell) => cellWords[cell.row][cell.column]).sort((a, b) => a.y - b.y || a.x - b.x);
      rows[startRow][startCol] = entries.map((entry) => entry.text).join(" ");
      cellConfidence[startRow][startCol] = confidenceOfWords(entries);
      if (cells.length > 1) merges.push({ startRow, startCol, endRow, endCol });
    } else {
      for (const cell of cells) {
        const entries = cellWords[cell.row][cell.column].sort((a, b) => a.y - b.y || a.x - b.x);
        rows[cell.row][cell.column] = entries.map((entry) => entry.text).join(" ");
        cellConfidence[cell.row][cell.column] = confidenceOfWords(entries);
      }
    }
  }
  return {
    rows,
    merges,
    confidence: confidenceOfWords(words, 0.95),
    cellConfidence,
    pages: [pageNumber],
    columnAnchors: xs,
    bounds: { left: xs[0], top: ys[0], right: xs[xs.length - 1], bottom: ys[ys.length - 1] },
    wordIds: words.filter((entry) => {
      const centerX = entry.x + entry.width / 2;
      const centerY = entry.y + entry.height / 2;
      return centerX >= xs[0] - 2 && centerX <= xs[xs.length - 1] + 2 && centerY >= ys[0] - 2 && centerY <= ys[ys.length - 1] + 2;
    }).map((entry) => entry.id)
  };
}

function rawRowsFromWords(words) {
  return clusterRows(words).map((row) => [row.words.map((entry) => entry.text).join(" ")]);
}

function detectTablesOnPage(input = {}) {
  const pageNumber = Number.isInteger(input.pageNumber) && input.pageNumber > 0 ? input.pageNumber : 1;
  const words = normalizeWords(input.words);
  const gridTables = splitLineComponents(input.lines).map((lines) => makeGridTable(words, lines, pageNumber)).filter(Boolean);
  const consumedIds = new Set(gridTables.flatMap((table) => table.wordIds));
  const remainingWords = words.filter((entry) => !consumedIds.has(entry.id));
  const borderlessTables = [];
  const rawWords = [];
  for (const rows of splitRowBlocks(clusterRows(remainingWords))) {
    const table = makeBorderlessTable(rows, input.width, pageNumber);
    if (table) borderlessTables.push(table);
    else rawWords.push(...rows.flatMap((row) => row.words));
  }
  const tables = [...gridTables, ...borderlessTables].sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
  const warnings = [];
  tables.forEach((table, index) => {
    if (table.confidence < LOW_CONFIDENCE) warnings.push(`P${String(pageNumber).padStart(3, "0")}-T${String(index + 1).padStart(2, "0")}: low confidence`);
  });
  return {
    pageNumber,
    source: input.source === "ocr" ? "ocr" : "text",
    width: Number(input.width) || 0,
    height: Number(input.height) || 0,
    tables,
    rawRows: rawRowsFromWords(rawWords),
    warnings
  };
}

function normalizedHeader(rows) {
  return (rows[0] || []).map((value) => String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " "));
}

function sameHeader(left, right) {
  const a = normalizedHeader(left.rows);
  const b = normalizedHeader(right.rows);
  return a.length === b.length && a.length > 0 && a.every((value, index) => value === b[index]);
}

function sameColumns(left, right) {
  const a = left.columnAnchors || [];
  const b = right.columnAnchors || [];
  if (a.length !== b.length || a.length < 2) return false;
  const leftWidth = Math.max(1, left.pageWidth || left.bounds?.right || 1);
  const rightWidth = Math.max(1, right.pageWidth || right.bounds?.right || 1);
  return a.every((value, index) => Math.abs(value / leftWidth - b[index] / rightWidth) <= 0.04);
}

function canContinue(previous, table, page) {
  if (!sameHeader(previous, table) || !sameColumns(previous, table)) return false;
  const previousHeight = Math.max(1, previous.pageHeight || previous.bounds?.bottom || 1);
  const currentHeight = Math.max(1, page.height || table.bounds?.bottom || 1);
  return previous.bounds?.bottom >= previousHeight * 0.75 && table.bounds?.top <= currentHeight * 0.25;
}

function cloneTableAsSheet(table, name, source) {
  return {
    name,
    source,
    rows: table.rows.map((row) => [...row]),
    merges: table.merges.map((merge) => ({ ...merge })),
    cellConfidence: table.cellConfidence.map((row) => [...row]),
    confidence: table.confidence,
    pages: [...table.pages],
    columnAnchors: [...(table.columnAnchors || [])],
    bounds: { ...table.bounds },
    pageWidth: table.pageWidth || 0,
    pageHeight: table.pageHeight || 0
  };
}

function buildWorkbookModel(pages = []) {
  const sheets = [];
  const warnings = [];
  for (const page of pages) {
    warnings.push(...(page.warnings || []));
    if (!page.tables || page.tables.length === 0) {
      sheets.push({
        name: `P${String(page.pageNumber).padStart(3, "0")}-Raw`,
        source: page.source,
        rows: page.rawRows && page.rawRows.length ? page.rawRows.map((row) => [...row]) : [[""]],
        merges: [],
        cellConfidence: [],
        confidence: 0,
        pages: [page.pageNumber]
      });
      warnings.push(`P${String(page.pageNumber).padStart(3, "0")}: no table detected; raw text retained`);
      continue;
    }
    const candidates = sheets.filter((sheet) => !sheet.name.endsWith("-Raw") && sheet.pages[sheet.pages.length - 1] === page.pageNumber - 1);
    const continued = new Set();
    page.tables.forEach((table, index) => {
      table.pageWidth = page.width;
      table.pageHeight = page.height;
      const continuation = candidates.find((sheet) => !continued.has(sheet) && canContinue(sheet, table, page));
      if (continuation) {
        continued.add(continuation);
        const rowOffset = continuation.rows.length - 1;
        continuation.rows.push(...table.rows.slice(1).map((row) => [...row]));
        continuation.cellConfidence.push(...table.cellConfidence.slice(1).map((row) => [...row]));
        continuation.merges.push(...table.merges.filter((merge) => merge.startRow > 0).map((merge) => ({
          startRow: merge.startRow + rowOffset,
          endRow: merge.endRow + rowOffset,
          startCol: merge.startCol,
          endCol: merge.endCol
        })));
        continuation.pages.push(page.pageNumber);
        continuation.confidence = Math.min(continuation.confidence, table.confidence);
        continuation.bounds = { ...table.bounds };
        continuation.pageWidth = page.width;
        continuation.pageHeight = page.height;
      } else {
        const name = `P${String(page.pageNumber).padStart(3, "0")}-T${String(index + 1).padStart(2, "0")}`;
        const sheet = cloneTableAsSheet(table, name, page.source);
        sheet.pageWidth = page.width;
        sheet.pageHeight = page.height;
        sheets.push(sheet);
      }
    });
    if (page.rawRows && page.rawRows.length) {
      sheets.push({
        name: `P${String(page.pageNumber).padStart(3, "0")}-Raw`,
        source: page.source,
        rows: page.rawRows.map((row) => [...row]),
        merges: [], cellConfidence: [], confidence: 0, pages: [page.pageNumber]
      });
      warnings.push(`P${String(page.pageNumber).padStart(3, "0")}: non-table text retained in Raw sheet`);
    }
  }
  return {
    sheets,
    warnings,
    summary: pages.map((page) => ({
      pageNumber: page.pageNumber,
      source: page.source,
      tableCount: page.tables ? page.tables.length : 0,
      confidence: page.tables && page.tables.length ? Math.min(...page.tables.map((table) => table.confidence)) : 0,
      warnings: [...(page.warnings || [])]
    }))
  };
}

module.exports = {
  LOW_CONFIDENCE,
  detectTablesOnPage,
  buildWorkbookModel
};
