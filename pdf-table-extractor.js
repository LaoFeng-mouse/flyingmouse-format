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

function normalizeTextStyle(value) {
  const style = {};
  if (!value || typeof value !== "object") return style;
  for (const key of ["fontName", "fontFamily", "sourceFontName"]) {
    if (typeof value[key] === "string" && value[key].trim()) style[key] = value[key].trim();
  }
  if (Number.isFinite(value.fontSizePt) && value.fontSizePt > 0) style.fontSizePt = value.fontSizePt;
  for (const key of ["bold", "italic"]) if (typeof value[key] === "boolean") style[key] = value[key];
  return style;
}

function wordBounds(words) {
  const x = Math.min(...words.map(word => word.x));
  const y = Math.min(...words.map(word => word.y));
  return { x, y, width: Math.max(...words.map(word => word.x + word.width)) - x,
    height: Math.max(...words.map(word => word.y + word.height)) - y };
}

function commonTextStyle(words) {
  if (!words.length) return {};
  const style = { ...words[0].style };
  for (const key of Object.keys(style)) {
    if (!words.every(word => word.style?.[key] === style[key])) delete style[key];
  }
  return style;
}

function textRuns(words, preserveLines = false, mergeChinese = false) {
  const rows = preserveLines ? clusterRows(words).map(row => row.words) : [words];
  return rows.flatMap((row, rowIndex) => row.map((word, index) => {
    let prefix = index ? " " : rowIndex ? "\n" : "";
    if (mergeChinese && index && /[\u4e00-\u9fff]$/.test(row[index - 1].text) && /^[\u4e00-\u9fff]/.test(word.text)) prefix = "";
    const text = mergeChinese ? word.text.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1") : word.text;
    return { text: prefix + text, x: word.x, y: word.y, width: word.width, height: word.height, style: { ...word.style } };
  }));
}

function horizontalAlignment(words, bounds) {
  if (!bounds || !words.length) return undefined;
  const width = bounds.right - bounds.left;
  const lines = clusterRows(words).map(row => {
    const box = wordBounds(row.words);
    const left = box.x - bounds.left, right = bounds.right - box.x - box.width;
    const tolerance = Math.max(0.75, Math.min(box.height * 0.2, width * 0.02));
    return { box, left, right, tolerance };
  });
  const alignments = lines.map(({ box, left, right, tolerance }) => {
    if (left < -tolerance || right < -tolerance || left + right <= tolerance * 2) return undefined;
    if (Math.abs(left - right) <= tolerance && Math.min(left, right) > tolerance) return "center";
    const edge = Math.max(1, box.height * 0.6);
    if (left <= edge && right > edge + tolerance && right - left > tolerance * 2) return "left";
    if (right <= edge && left > edge + tolerance && left - right > tolerance * 2) return "right";
    return undefined;
  });
  if (alignments[0] && alignments.every(value => value === alignments[0])) return alignments[0];
  // A nearly full-width line cannot establish alignment by itself. A second
  // line with clear margins can establish the shared center, provided every
  // line agrees within the geometry tolerance and stays inside the cell.
  if (lines.length > 1 && alignments.includes("center")
    && lines.every(({ left, right, tolerance }) => left >= -tolerance && right >= -tolerance
      && Math.abs(left - right) / 2 <= tolerance)) return "center";
  return undefined;
}

function cellTextStyle(words, bounds, nativeText = true) {
  if (!words.length) return null;
  const horizontal = nativeText ? horizontalAlignment(words, bounds) : undefined;
  return { style: commonTextStyle(words), bbox: wordBounds(words), runs: textRuns(words, nativeText),
    ...(horizontal ? { horizontal } : {}) };
}

function cloneTextMetadata(value) {
  if (!value) return value;
  return { ...value, ...(value.style ? { style: { ...value.style } } : {}),
    ...(value.bbox ? { bbox: { ...value.bbox } } : {}),
    ...(value.runs ? { runs: value.runs.map(run => ({ ...run, style: { ...run.style } })) } : {}) };
}

function pagePointMetadata(page) {
  const scale = page.pagePointScale;
  if (!Number.isFinite(scale) || scale <= 0) return {};
  return { pagePointScale: scale,
    ...(Number.isFinite(page.width) && page.width > 0 ? { pageWidthPt: page.width * scale } : {}),
    ...(Number.isFinite(page.height) && page.height > 0 ? { pageHeightPt: page.height * scale } : {}) };
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
      confidence: normalizeConfidence(entry.confidence == null ? 1 : entry.confidence),
      style: normalizeTextStyle(entry.style)
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

function gridCellText(words, preserveLines) {
  if (!preserveLines) return words.map((entry) => entry.text).join(" ");
  return clusterRows(words).map((row) => row.words.map((entry) => entry.text).join(" ")).join("\n");
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
  // Independent signatures, prose and page numbers can happen to share one
  // x anchor. Require two repeated occupied columns on nearby rows before
  // advertising an unruled table; rejected text remains in the Raw sheet.
  const nearbyRepeatedColumns = cellWords.slice(1).some((row, index) => {
    const previous = cellWords[index];
    const repeated = row.filter((cell, column) => cell.length && previous[column].length).length;
    const height = median([...rows[index].words, ...rows[index + 1].words].map(word => word.height));
    return repeated >= 2 && rows[index + 1].center - rows[index].center <= Math.max(24, height * 3.5);
  });
  if (!nearbyRepeatedColumns) return null;
  const allWords = rows.flatMap((row) => row.words);
  return {
    rows: cellWords.map((row) => row.map((cell) => cell.map((entry) => entry.text).join(" "))),
    merges: [],
    confidence: confidenceOfWords(allWords, 0.85),
    cellConfidence: cellWords.map((row) => row.map((cell) => confidenceOfWords(cell))),
    cellStyles: cellWords.map(row => row.map(cell => cellTextStyle(cell, null, false))),
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

function makeGridTable(words, lines, pageNumber, allowDamagedMergeRecovery = false) {
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
  const cellStyles = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));
  const merges = [];
  const damagedMergeCandidates = [];
  for (const cells of groups.values()) {
    const startRow = Math.min(...cells.map((cell) => cell.row));
    const endRow = Math.max(...cells.map((cell) => cell.row));
    const startCol = Math.min(...cells.map((cell) => cell.column));
    const endCol = Math.max(...cells.map((cell) => cell.column));
    const rectangular = cells.length === (endRow - startRow + 1) * (endCol - startCol + 1);
    const populatedCells = cells.filter((cell) => cellWords[cell.row][cell.column].length > 0).length;
    if (rectangular && populatedCells <= 1) {
      const entries = cells.flatMap((cell) => cellWords[cell.row][cell.column]).sort((a, b) => a.y - b.y || a.x - b.x);
      rows[startRow][startCol] = gridCellText(entries, !allowDamagedMergeRecovery);
      cellConfidence[startRow][startCol] = confidenceOfWords(entries);
      cellStyles[startRow][startCol] = cellTextStyle(entries,
        { left: xs[startCol], top: ys[startRow], right: xs[endCol + 1], bottom: ys[endRow + 1] }, !allowDamagedMergeRecovery);
      if (cells.length > 1) merges.push({ startRow, startCol, endRow, endCol });
    } else {
      if (rectangular && cells.length > 1) {
        damagedMergeCandidates.push({ cells, startRow, endRow, startCol, endCol, populatedCells });
      }
      for (const cell of cells) {
        const entries = cellWords[cell.row][cell.column].sort((a, b) => a.y - b.y || a.x - b.x);
        rows[cell.row][cell.column] = gridCellText(entries, !allowDamagedMergeRecovery);
        cellConfidence[cell.row][cell.column] = confidenceOfWords(entries);
        cellStyles[cell.row][cell.column] = cellTextStyle(entries,
          { left: xs[cell.column], top: ys[cell.row], right: xs[cell.column + 1], bottom: ys[cell.row + 1] }, !allowDamagedMergeRecovery);
      }
    }
  }
  for (const candidate of damagedMergeCandidates) {
    if (!allowDamagedMergeRecovery) continue;
    const span = candidate.endRow - candidate.startRow + 1;
    const header = String(rows[0]?.[candidate.startCol] || "").toLocaleLowerCase().replace(/\s+/g, "");
    const isProductName = /名称|品名|productname|itemname/.test(header);
    if (candidate.startCol !== candidate.endCol || span < 3 || !isProductName || candidate.populatedCells > Math.ceil(span / 2)) continue;
    const entries = candidate.cells.flatMap((cell) => cellWords[cell.row][cell.column]).sort((a, b) => a.y - b.y || a.x - b.x);
    rows[candidate.startRow][candidate.startCol] = entries.map((entry) => entry.text).join(" ");
    cellConfidence[candidate.startRow][candidate.startCol] = confidenceOfWords(entries);
    cellStyles[candidate.startRow][candidate.startCol] = cellTextStyle(entries, null, false);
    for (let row = candidate.startRow + 1; row <= candidate.endRow; row += 1) {
      rows[row][candidate.startCol] = "";
      cellConfidence[row][candidate.startCol] = 0;
      cellStyles[row][candidate.startCol] = null;
    }
    merges.push({ startRow: candidate.startRow, startCol: candidate.startCol, endRow: candidate.endRow, endCol: candidate.endCol });
  }
  return {
    rows,
    merges,
    confidence: confidenceOfWords(words, 0.95),
    cellConfidence,
    cellStyles,
    pages: [pageNumber],
    columnAnchors: xs,
    rowAnchors: ys,
    bounds: { left: xs[0], top: ys[0], right: xs[xs.length - 1], bottom: ys[ys.length - 1] },
    damagedMergeCandidates: damagedMergeCandidates.map((candidate) => ({
      startRow: candidate.startRow, endRow: candidate.endRow,
      startCol: candidate.startCol, endCol: candidate.endCol,
      populatedCells: candidate.populatedCells
    })),
    wordIds: words.filter((entry) => {
      const centerX = entry.x + entry.width / 2;
      const centerY = entry.y + entry.height / 2;
      return centerX >= xs[0] - 2 && centerX <= xs[xs.length - 1] + 2 && centerY >= ys[0] - 2 && centerY <= ys[ys.length - 1] + 2;
    }).map((entry) => entry.id)
  };
}

function rawRowsFromWords(words) {
  // mergeCnSpaces 同源逻辑（pdf-table-runtime.js）：删除汉字间空格
  // （OCR 拆字 `纳税 人 名 称` → `纳税人名称`），汉字与英文/数字间空格保留。
  // 此处内联而非 require，避免 runtime↔extractor 模块依赖纠缠。
  const mergeCnSpaces = (text) => String(text || "").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
  return clusterRows(words).map((row) => [mergeCnSpaces(row.words.map((entry) => entry.text).join(" "))]);
}

function rawBlocksFromWords(words, pageWidth) {
  return clusterRows(words).flatMap((row) => {
    const gapLimit = Math.max(12, median(row.words.map((word) => word.height)) * 2.5, Number(pageWidth) * 0.025);
    const groups = [];
    for (const word of row.words) {
      const group = groups.at(-1);
      if (!group || word.x - Math.max(...group.map((entry) => entry.x + entry.width)) > gapLimit) groups.push([word]);
      else group.push(word);
    }
    return groups.map((group) => {
      const x = Math.min(...group.map((word) => word.x));
      const y = Math.min(...group.map((word) => word.y));
      return {
        text: group.map((word) => word.text).join(" ").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1"),
        x, y, width: Math.max(...group.map((word) => word.x + word.width)) - x,
        height: Math.max(...group.map((word) => word.y + word.height)) - y,
        style: commonTextStyle(group),
        runs: textRuns(group, false, true)
      };
    });
  });
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function numericText(value) {
  const text = String(value || "").replace(/\s+/g, "");
  // Arithmetic repair only understands unsigned decimal tokens. Do not erase
  // signs, grouping separators or units and reinterpret a different number.
  return /^\d+(?:\.\d+)?$/.test(text) ? text : "";
}

function repairQuantityText(value) {
  const text = numericText(value);
  // Fractional quantities are valid source data, not dropped decimal points.
  return /^\d+$/.test(text) ? text : "";
}

function formatDecimal(value) {
  return Number(value.toFixed(2)).toString();
}

function arithmeticPair(row, priceIndex, quantityIndex, totalIndex) {
  const rawPrice = numericText(row[priceIndex]);
  const rawQuantity = repairQuantityText(row[quantityIndex]);
  const rawTotal = numericText(row[totalIndex]);
  const total = Number(rawTotal);
  if (!rawPrice || !rawQuantity || !Number.isFinite(total) || total <= 0) return null;
  const candidates = [];
  const add = (price, quantity, candidateTotal, penalty = 0) => {
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000 || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(candidateTotal)) return;
    const priceText = formatDecimal(price);
    const quantityText = String(quantity);
    const totalText = formatDecimal(candidateTotal);
    candidates.push({
      priceText, quantityText, totalText, penalty,
      score: editDistance(priceText, rawPrice) + editDistance(quantityText, rawQuantity) + editDistance(totalText, rawTotal) + penalty
    });
  };
  const priceCandidates = new Set([Number(rawPrice)]);
  if (!rawPrice.includes(".")) {
    if (rawPrice.length >= 2) priceCandidates.add(Number(rawPrice) / 10);
    if (rawPrice.length >= 3) priceCandidates.add(Number(rawPrice) / 100);
  }
  const quantity = Number(rawQuantity);
  if (Number.isInteger(quantity) && quantity > 0) {
    for (const price of priceCandidates) add(price, quantity, price * quantity);
  }
  for (const price of priceCandidates) {
    const inferredQuantity = total / price;
    if (Math.abs(inferredQuantity - Math.round(inferredQuantity)) <= 0.001) add(price, Math.round(inferredQuantity), total, 1);
  }
  if (Number.isInteger(quantity) && quantity > 0) {
    const price = total / quantity;
    if (Math.abs(price * quantity - total) <= 0.01 && Math.abs(price * 100 - Math.round(price * 100)) <= 0.001) add(price, quantity, total, 1);
  }
  candidates.sort((a, b) => a.score - b.score || a.penalty - b.penalty || Number(a.priceText) - Number(b.priceText));
  return candidates[0] && candidates[0].score <= 3 ? candidates[0] : null;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return a;
}

function repairDominantArithmeticOutliers(table, priceIndex, quantityIndex, totalIndex) {
  const dataRows = table.rows.slice(1).filter((row) => {
    const price = Number(numericText(row[priceIndex]));
    const quantity = Number(repairQuantityText(row[quantityIndex]));
    const total = Number(numericText(row[totalIndex]));
    return price > 0 && Number.isInteger(quantity) && quantity > 0 && total > 0;
  });
  if (dataRows.length < 6) return 0;
  const explicitPrices = [...new Set(dataRows
    .map((row) => numericText(row[priceIndex]))
    .filter((value) => value.includes("."))
    .map((value) => formatDecimal(Number(value))))];
  const canonicalPrice = (row) => {
    const raw = numericText(row[priceIndex]);
    const normalized = formatDecimal(Number(raw));
    if (raw.includes(".")) return normalized;
    const decimalCandidate = explicitPrices
      .map((value) => ({ value, distance: editDistance(value, raw) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return decimalCandidate && decimalCandidate.distance <= 1 ? decimalCandidate.value : normalized;
  };
  const priceCounts = new Map();
  for (const row of dataRows) {
    const value = canonicalPrice(row);
    priceCounts.set(value, (priceCounts.get(value) || 0) + 1);
  }
  const [dominantPriceText, dominantCount] = [...priceCounts].sort((a, b) => b[1] - a[1])[0] || [];
  if (!dominantPriceText || dominantCount < Math.max(4, Math.ceil(dataRows.length * 0.5))) return 0;
  const dominantPrice = Number(dominantPriceText);
  const trustedQuantities = dataRows
    .filter((row) => canonicalPrice(row) === dominantPriceText)
    .map((row) => Number(repairQuantityText(row[quantityIndex])))
    .filter((value) => Number.isInteger(value) && value > 0);
  const quantityStep = trustedQuantities.reduce((step, value) => step ? greatestCommonDivisor(step, value) : value, 0);
  if (quantityStep < 2) return 0;
  const maximumQuantity = Math.max(...trustedQuantities, quantityStep) * 2;
  const candidateQuantities = [];
  for (let quantity = quantityStep; quantity <= maximumQuantity; quantity += quantityStep) candidateQuantities.push(quantity);

  let corrected = 0;
  table.rows.slice(1).forEach((row, offset) => {
    const rowIndex = offset + 1;
    const rawPrice = numericText(row[priceIndex]);
    const rawQuantity = repairQuantityText(row[quantityIndex]);
    const rawTotal = numericText(row[totalIndex]);
    if (!rawPrice || !rawQuantity || !rawTotal || formatDecimal(Number(rawPrice)) === dominantPriceText) return;
    const priceDistance = editDistance(dominantPriceText, rawPrice);
    if (priceDistance > 2) return;
    const candidates = candidateQuantities.map((quantity) => {
      const quantityText = String(quantity);
      const totalText = formatDecimal(dominantPrice * quantity);
      return {
        quantityText,
        totalText,
        quantityDistance: editDistance(quantityText, rawQuantity),
        totalDistance: editDistance(totalText, rawTotal)
      };
    }).sort((a, b) => (a.quantityDistance + a.totalDistance) - (b.quantityDistance + b.totalDistance));
    const best = candidates[0];
    if (!best || best.quantityDistance > 1 || best.totalDistance > 4) return;
    const confidence = [priceIndex, quantityIndex, totalIndex]
      .map((column) => Number(table.cellConfidence?.[rowIndex]?.[column]))
      .filter(Number.isFinite);
    const hasLowConfidenceCell = confidence.length === 3 && Math.min(...confidence) < LOW_CONFIDENCE;
    if (!hasLowConfidenceCell) return;
    for (const [column, value] of [[priceIndex, dominantPriceText], [quantityIndex, best.quantityText], [totalIndex, best.totalText]]) {
      const cellConfidence = Number(table.cellConfidence?.[rowIndex]?.[column]);
      if (!Number.isFinite(cellConfidence) || cellConfidence >= LOW_CONFIDENCE) continue;
      if (String(row[column] || "").trim() === value) continue;
      row[column] = value;
      if (table.cellConfidence[rowIndex]) table.cellConfidence[rowIndex][column] = Math.min(table.cellConfidence[rowIndex][column] || 1, 0.7);
      corrected += 1;
    }
  });
  return corrected;
}

function repairExactDecimalPrices(table, priceIndex, quantityIndex, totalIndex) {
  let corrected = 0;
  table.rows.slice(1).forEach((row, offset) => {
    const rawPrice = numericText(row[priceIndex]);
    const rawQuantity = repairQuantityText(row[quantityIndex]);
    const rawTotal = numericText(row[totalIndex]);
    if (!/^\d{2,4}$/.test(rawPrice) || !/^\d+$/.test(rawQuantity) || !rawTotal) return;
    const quantity = Number(rawQuantity);
    const total = Number(rawTotal);
    const integerPrice = Number(rawPrice);
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(total) || total <= 0) return;
    if (Math.abs(integerPrice * quantity - total) <= 0.01) return;
    const candidates = [10, 100, 1000]
      .filter((divisor) => rawPrice.length > Math.log10(divisor))
      .map((divisor) => integerPrice / divisor)
      .filter((price) => Math.abs(price * quantity - total) <= 0.01);
    if (candidates.length !== 1) return;
    const rowIndex = offset + 1;
    // Even exact multiplication cannot prove a high-confidence price is wrong
    // (discounts, pack sizes and source errors are legitimate possibilities).
    const priceConfidence = Number(table.cellConfidence?.[rowIndex]?.[priceIndex]);
    if (!Number.isFinite(priceConfidence) || priceConfidence >= LOW_CONFIDENCE) return;
    row[priceIndex] = formatDecimal(candidates[0]);
    if (table.cellConfidence[rowIndex]) table.cellConfidence[rowIndex][priceIndex] = Math.min(table.cellConfidence[rowIndex][priceIndex] || 1, 0.7);
    corrected += 1;
  });
  return corrected;
}

function repairArithmeticColumns(table) {
  if (table.kind !== "grid" || table.rows.length < 4) return 0;
  const header = table.rows[0].map((value) => String(value || "").toLocaleLowerCase().replace(/\s+/g, ""));
  const priceIndex = header.findIndex((value) => /单价|unitprice|price/.test(value));
  const quantityIndex = header.findIndex((value) => /数量|qty|quantity/.test(value));
  if (priceIndex < 0 || quantityIndex < 0) return 0;
  let totalIndex = header.findIndex((value) => /金额|合计|total|amount/.test(value));
  if (totalIndex < 0 && quantityIndex + 1 < header.length) totalIndex = quantityIndex + 1;
  if (totalIndex < 0 || new Set([priceIndex, quantityIndex, totalIndex]).size < 3) return 0;
  let corrected = repairExactDecimalPrices(table, priceIndex, quantityIndex, totalIndex);
  corrected += repairDominantArithmeticOutliers(table, priceIndex, quantityIndex, totalIndex);
  const repairs = table.rows.slice(1).map((row) => arithmeticPair(row, priceIndex, quantityIndex, totalIndex));
  if (repairs.filter(Boolean).length < 3) return corrected;
  repairs.forEach((pair, index) => {
    if (!pair) return;
    const rowIndex = index + 1;
    const confidence = [priceIndex, quantityIndex, totalIndex]
      .map((column) => Number(table.cellConfidence?.[rowIndex]?.[column]))
      .filter(Number.isFinite);
    if (confidence.length === 3 && Math.min(...confidence) >= LOW_CONFIDENCE) return;
    for (const [column, value] of [[priceIndex, pair.priceText], [quantityIndex, pair.quantityText], [totalIndex, pair.totalText]]) {
      const cellConfidence = Number(table.cellConfidence?.[rowIndex]?.[column]);
      if (!Number.isFinite(cellConfidence) || cellConfidence >= LOW_CONFIDENCE) continue;
      if (String(table.rows[rowIndex][column] || "").trim() === value) continue;
      table.rows[rowIndex][column] = value;
      if (table.cellConfidence[rowIndex]) table.cellConfidence[rowIndex][column] = Math.min(table.cellConfidence[rowIndex][column] || 1, 0.7);
      corrected += 1;
    }
  });
  return corrected;
}

function repairSequentialIndex(table) {
  if (table.kind !== "grid" || table.rows.length < 5 || !table.rows[0]?.length) return 0;
  let endRow = table.rows.findIndex((row, index) => index > 0 && row.some((value) => /合\s*计|total/i.test(String(value || ""))));
  if (endRow < 0) endRow = table.rows.length;
  const dataRows = table.rows.slice(1, endRow);
  if (dataRows.length < 4) return 0;
  const parsed = dataRows.map((row) => {
    const match = String(row[0] || "").match(/\d{1,4}/);
    return match ? Number(match[0]) : null;
  });
  const matches = parsed.filter((value, index) => value === index + 1).length;
  if (matches < Math.max(3, Math.ceil(dataRows.length * 0.6))) return 0;
  let corrected = 0;
  dataRows.forEach((row, index) => {
    const expected = String(index + 1);
    if (String(row[0] || "").trim() === expected) return;
    row[0] = expected;
    if (table.cellConfidence[index + 1]) table.cellConfidence[index + 1][0] = Math.min(table.cellConfidence[index + 1][0] || 1, 0.7);
    corrected += 1;
  });
  return corrected;
}

function recoverProductNameMerges(table) {
  if (table.kind !== "grid" || !Array.isArray(table.damagedMergeCandidates)) return 0;
  let recovered = 0;
  for (const candidate of table.damagedMergeCandidates) {
    const span = candidate.endRow - candidate.startRow + 1;
    const header = String(table.rows[0]?.[candidate.startCol] || "").toLocaleLowerCase().replace(/\s+/g, "");
    if (candidate.startCol !== candidate.endCol || span < 3 || !/名称|品名|productname|itemname/.test(header)) continue;
    if (candidate.populatedCells > Math.ceil(span / 2)) continue;
    if (table.merges.some((merge) => merge.startRow === candidate.startRow && merge.startCol === candidate.startCol && merge.endRow === candidate.endRow && merge.endCol === candidate.endCol)) continue;
    const values = [];
    for (let row = candidate.startRow; row <= candidate.endRow; row += 1) {
      const value = String(table.rows[row]?.[candidate.startCol] || "").trim();
      if (value) values.push(value);
      if (row > candidate.startRow) {
        table.rows[row][candidate.startCol] = "";
        if (table.cellConfidence[row]) table.cellConfidence[row][candidate.startCol] = 0;
      }
    }
    table.rows[candidate.startRow][candidate.startCol] = values.join(" ");
    table.merges.push({ startRow: candidate.startRow, startCol: candidate.startCol, endRow: candidate.endRow, endCol: candidate.endCol });
    recovered += 1;
  }
  return recovered;
}

function removeUnsafeOcrDataMerges(table) {
  if (table.kind !== "grid" || !table.rows[0]) return 0;
  const original = table.merges.length;
  table.merges = table.merges.filter((merge) => {
    if (merge.startRow <= 0 || merge.endRow <= merge.startRow || merge.startCol !== merge.endCol) return true;
    const header = String(table.rows[0][merge.startCol] || "").toLocaleLowerCase().replace(/\s+/g, "");
    const isUnsafeDataColumn = /单价|数量|金额|合计|price|qty|quantity|amount|total|否.*是|是.*否|包.*邮/.test(header);
    if (!isUnsafeDataColumn) return true;
    return Number(table.cellConfidence?.[merge.startRow]?.[merge.startCol]) >= LOW_CONFIDENCE;
  });
  return original - table.merges.length;
}

function detectTablesOnPage(input = {}) {
  const pageNumber = Number.isInteger(input.pageNumber) && input.pageNumber > 0 ? input.pageNumber : 1;
  const words = normalizeWords(input.words);
  const gridTables = splitLineComponents(input.lines)
    .map((lines) => makeGridTable(words, lines, pageNumber, input.source === "ocr"))
    .filter(Boolean);
  gridTables.forEach((table) => { table.kind = "grid"; });
  const consumedIds = new Set(gridTables.flatMap((table) => table.wordIds));
  const remainingWords = words.filter((entry) => !consumedIds.has(entry.id));
  const borderlessTables = [];
  const rawWords = [];
  for (const rows of splitRowBlocks(clusterRows(remainingWords))) {
    const table = makeBorderlessTable(rows, input.width, pageNumber);
    if (table) {
      table.kind = "borderless";
      borderlessTables.push(table);
    }
    else rawWords.push(...rows.flatMap((row) => row.words));
  }
  const rejectedIds = new Set();
  const tables = [...gridTables, ...borderlessTables]
    .filter((table) => {
      const columnCount = table.rows[0]?.length || 0;
      const isWideOcrProse = input.source === "ocr"
        && table.kind === "borderless"
        && (columnCount >= 13 || (table.rows.length < 3 && columnCount >= 4));
      if (isWideOcrProse) table.wordIds.forEach((id) => rejectedIds.add(id));
      return !isWideOcrProse;
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
  rawWords.push(...words.filter((entry) => rejectedIds.has(entry.id)));
  const warnings = [];
  const unresolvedFonts = new Set(words.filter(word => word.style.sourceFontName && !word.style.fontName).map(word => word.style.sourceFontName));
  if (unresolvedFonts.size) warnings.push(`P${String(pageNumber).padStart(3, "0")}: ${unresolvedFonts.size} PDF font names unresolved; generic font family retained`);
  tables.forEach((table, index) => {
    const corrected = input.source === "ocr" ? repairArithmeticColumns(table) : 0;
    if (corrected) warnings.push(`P${String(pageNumber).padStart(3, "0")}-T${String(index + 1).padStart(2, "0")}: ${corrected} numeric cells corrected by arithmetic consistency`);
    if (table.confidence < LOW_CONFIDENCE) warnings.push(`P${String(pageNumber).padStart(3, "0")}-T${String(index + 1).padStart(2, "0")}: low confidence`);
  });
  return {
    pageNumber,
    source: input.source === "ocr" ? "ocr" : "text",
    width: Number(input.width) || 0,
    height: Number(input.height) || 0,
    ...pagePointMetadata(input),
    tables,
    rawRows: rawRowsFromWords(rawWords),
    rawBlocks: rawBlocksFromWords(rawWords, input.width),
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

function firstInteger(row) {
  const match = String(row?.[0] || "").trim().match(/^\d+$/);
  return match ? Number(match[0]) : null;
}

function hasSequentialRows(previous, table) {
  const previousIndex = firstInteger(previous.rows?.[previous.rows.length - 1]);
  const nextIndex = firstInteger(table.rows?.[0]);
  return Number.isInteger(previousIndex) && Number.isInteger(nextIndex) && nextIndex === previousIndex + 1;
}

function sharedRepeatedCodeColumn(previous, table) {
  if (previous.kind !== "grid" || table.kind !== "grid") return false;
  const columnCount = Math.min(previous.rows?.[0]?.length || 0, table.rows?.[0]?.length || 0);
  const tokens = (value) => String(value || "").toLocaleLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
  for (let column = 0; column < columnCount; column += 1) {
    const previousCounts = new Map();
    for (const row of previous.rows || []) {
      for (const token of new Set(tokens(row[column]))) previousCounts.set(token, (previousCounts.get(token) || 0) + 1);
    }
    const nextTokens = new Set((table.rows || []).flatMap((row) => tokens(row[column])));
    if ([...previousCounts].some(([token, count]) => count >= 2 && nextTokens.has(token))) return true;
  }
  return false;
}

function canContinue(previous, table, page) {
  if (!sameColumns(previous, table)) return false;
  const previousHeight = Math.max(1, previous.pageHeight || previous.bounds?.bottom || 1);
  const currentHeight = Math.max(1, page.height || table.bounds?.bottom || 1);
  const touchesPageBreak = previous.bounds?.bottom >= previousHeight * 0.75 && table.bounds?.top <= currentHeight * 0.25;
  return touchesPageBreak && (sameHeader(previous, table) || hasSequentialRows(previous, table) || sharedRepeatedCodeColumn(previous, table));
}

function cloneTableAsSheet(table, name, source) {
  return {
    name,
    source,
    rows: table.rows.map((row) => [...row]),
    merges: table.merges.map((merge) => ({ ...merge })),
    cellConfidence: table.cellConfidence.map((row) => [...row]),
    cellStyles: (table.cellStyles || table.rows.map(row => row.map(() => null))).map(row => row.map(cloneTextMetadata)),
    confidence: table.confidence,
    pages: [...table.pages],
    columnAnchors: [...(table.columnAnchors || [])],
    rowAnchors: [...(table.rowAnchors || [])],
    bounds: { ...table.bounds },
    pageWidth: table.pageWidth || 0,
    pageHeight: table.pageHeight || 0,
    ...pagePointMetadata({ width: table.pageWidth, height: table.pageHeight, pagePointScale: table.pagePointScale }),
    kind: table.kind || "unknown",
    damagedMergeCandidates: (table.damagedMergeCandidates || []).map((candidate) => ({ ...candidate }))
  };
}

function singlePageForm(page) {
  if (page.source !== "text" || page.tables?.length !== 1 || ![page.width, page.height].every(Number.isFinite)
    || !(page.width > 0 && page.height > 0)) return null;
  const table = page.tables[0];
  const blocks = page.rawBlocks;
  const count = table.rows?.[0]?.length || 0;
  const increasing = (values, length) => Array.isArray(values) && values.length === length
    && values.every((value, index) => Number.isFinite(value) && (index === 0 || value > values[index - 1]));
  if (table.kind !== "grid" || count < 2 || !increasing(table.columnAnchors, count + 1)
    || !increasing(table.rowAnchors, table.rows.length + 1) || !blocks?.length || blocks.length > 80) return null;
  const bounds = table.bounds;
  if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)) return null;
  const tolerance = Math.max(1, page.height * 0.0015);
  if (bounds.left < -tolerance || bounds.top < -tolerance || bounds.right > page.width + tolerance
    || bounds.bottom > page.height + tolerance || bounds.right <= bounds.left || bounds.bottom <= bounds.top
    || Math.abs(table.columnAnchors[0] - bounds.left) > tolerance
    || Math.abs(table.columnAnchors.at(-1) - bounds.right) > tolerance
    || Math.abs(table.rowAnchors[0] - bounds.top) > tolerance
    || Math.abs(table.rowAnchors.at(-1) - bounds.bottom) > tolerance) return null;
  const beforeBlocks = [], afterBlocks = [];
  for (const block of blocks) {
    if (![block.x, block.y, block.width, block.height].every(Number.isFinite) || block.width <= 0 || block.height <= 0
      || block.x < -tolerance || block.y < -tolerance || block.x + block.width > page.width + tolerance
      || block.y + block.height > page.height + tolerance) return null;
    if (block.y + block.height <= bounds.top + tolerance) beforeBlocks.push(cloneTextMetadata(block));
    else if (block.y >= bounds.bottom - tolerance) afterBlocks.push(cloneTextMetadata(block));
    else return null; // Sidebars and overlapping text cannot be safely attached to this form.
  }
  return { pageWidth: page.width, pageHeight: page.height, ...pagePointMetadata(page), beforeBlocks, afterBlocks };
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
        rawBlocks: (page.rawBlocks || []).map(cloneTextMetadata),
        ...pagePointMetadata(page),
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
      if (Number.isFinite(page.pagePointScale) && page.pagePointScale > 0) table.pagePointScale = page.pagePointScale;
      const continuation = candidates.find((sheet) => !continued.has(sheet) && canContinue(sheet, table, page));
      if (continuation) {
        continued.add(continuation);
        // One coordinate factor cannot describe pages rendered at different
        // scales. Font sizes in runs remain independently expressed in points.
        if (continuation.pagePointScale !== table.pagePointScale) {
          delete continuation.pagePointScale;
          delete continuation.pageWidthPt;
          delete continuation.pageHeightPt;
        }
        const firstDataRow = sameHeader(continuation, table) ? 1 : 0;
        const rowOffset = continuation.rows.length - firstDataRow;
        continuation.rows.push(...table.rows.slice(firstDataRow).map((row) => [...row]));
        continuation.cellConfidence.push(...table.cellConfidence.slice(firstDataRow).map((row) => [...row]));
        continuation.cellStyles.push(...(table.cellStyles || table.rows.map(row => row.map(() => null))).slice(firstDataRow).map(row => row.map(cloneTextMetadata)));
        continuation.merges.push(...table.merges.filter((merge) => merge.startRow >= firstDataRow).map((merge) => ({
          startRow: merge.startRow + rowOffset,
          endRow: merge.endRow + rowOffset,
          startCol: merge.startCol,
          endCol: merge.endCol
        })));
        continuation.damagedMergeCandidates.push(...(table.damagedMergeCandidates || [])
          .filter((candidate) => candidate.startRow >= firstDataRow)
          .map((candidate) => ({
            ...candidate,
            startRow: candidate.startRow + rowOffset,
            endRow: candidate.endRow + rowOffset
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
        if (pages.length === 1) {
          const form = singlePageForm(page);
          if (form) sheet.pageForm = form;
        }
        sheets.push(sheet);
      }
    });
    if (page.rawRows && page.rawRows.length) {
      sheets.push({
        name: `P${String(page.pageNumber).padStart(3, "0")}-Raw`,
        source: page.source,
        rows: page.rawRows.map((row) => [...row]),
        merges: [], cellConfidence: [], confidence: 0, pages: [page.pageNumber],
        rawBlocks: (page.rawBlocks || []).map(cloneTextMetadata),
        ...pagePointMetadata(page)
      });
      warnings.push(`P${String(page.pageNumber).padStart(3, "0")}: non-table text retained in Raw sheet`);
    }
  }
  for (const sheet of sheets.filter((candidate) => !candidate.name.endsWith("-Raw"))) {
    const recoveredMerges = sheet.source === "ocr" ? recoverProductNameMerges(sheet) : 0;
    if (recoveredMerges) warnings.push(`${sheet.name}: ${recoveredMerges} product-name merge recovered from damaged grid lines`);
    const removedMerges = sheet.source === "ocr" ? removeUnsafeOcrDataMerges(sheet) : 0;
    if (removedMerges) warnings.push(`${sheet.name}: ${removedMerges} unsafe data merges removed`);
    const corrected = sheet.source === "ocr" ? repairArithmeticColumns(sheet) : 0;
    if (corrected) warnings.push(`${sheet.name}: ${corrected} numeric cells corrected by arithmetic consistency`);
    const sequenceCorrected = sheet.source === "ocr" ? repairSequentialIndex(sheet) : 0;
    if (sequenceCorrected) warnings.push(`${sheet.name}: ${sequenceCorrected} index cells corrected by sequence consistency`);
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
