"use strict";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function multiplyMatrices(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function pdfTextContentToWords({ textContent, viewport }) {
  const items = textContent && Array.isArray(textContent.items) ? textContent.items : [];
  const viewportTransform = viewport && Array.isArray(viewport.transform)
    ? viewport.transform.map(Number)
    : [1, 0, 0, 1, 0, 0];
  const scale = Math.max(0.000001, Number(viewport && viewport.scale) || 1);

  return items.flatMap((item) => {
    const text = String(item && item.str != null ? item.str : "").trim();
    if (!text || !item || !Array.isArray(item.transform) || item.transform.length < 6) return [];
    const matrix = multiplyMatrices(viewportTransform, item.transform.map(Number));
    if (!matrix.every(Number.isFinite)) return [];

    const advanceLength = Math.max(0, Number(item.width) || 0) * scale;
    const viewportXAxisLength = Math.hypot(viewportTransform[0], viewportTransform[1]) || scale;
    const advanceX = viewportTransform[0] / viewportXAxisLength * advanceLength;
    const advanceY = viewportTransform[1] / viewportXAxisLength * advanceLength;
    let ascenderX = matrix[2];
    let ascenderY = matrix[3];
    const requestedHeight = Math.max(0, Number(item.height) || 0) * scale;
    const matrixHeight = Math.hypot(ascenderX, ascenderY);
    if (requestedHeight && matrixHeight) {
      ascenderX *= requestedHeight / matrixHeight;
      ascenderY *= requestedHeight / matrixHeight;
    }
    const corners = [
      [matrix[4], matrix[5]],
      [matrix[4] + advanceX, matrix[5] + advanceY],
      [matrix[4] + ascenderX, matrix[5] + ascenderY],
      [matrix[4] + advanceX + ascenderX, matrix[5] + advanceY + ascenderY]
    ];
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return [{
      text,
      x: cleanNumber(x),
      y: cleanNumber(y),
      width: cleanNumber(Math.max(...xs) - x),
      height: cleanNumber(Math.max(...ys) - y),
      confidence: 1
    }];
  });
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return clamp(numeric > 1 ? numeric / 100 : numeric, 0, 1);
}

function normalizeOcrResult(result) {
  const root = result && result.data ? result.data : result;
  if (!root || typeof root !== "object") return [];
  const candidates = [];
  const seenObjects = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const childKeys = ["blocks", "paragraphs", "lines", "words", "symbols"];
    const populatedChildren = childKeys.filter((key) => Array.isArray(value[key]) && value[key].length);
    if (populatedChildren.length) {
      populatedChildren.forEach((key) => visit(value[key]));
      return;
    }
    const bbox = value.bbox;
    if (bbox && value.text != null && [bbox.x0, bbox.y0, bbox.x1, bbox.y1].every((entry) => Number.isFinite(Number(entry)))) {
      candidates.push(value);
      return;
    }
  }
  visit(root);

  const seenWords = new Set();
  return candidates.flatMap((entry) => {
    const text = String(entry.text || "").trim();
    if (!text) return [];
    const bbox = entry.bbox;
    const x = Number(bbox.x0);
    const y = Number(bbox.y0);
    const width = Math.max(0, Number(bbox.x1) - x);
    const height = Math.max(0, Number(bbox.y1) - y);
    const key = `${text}\u0000${x}\u0000${y}\u0000${width}\u0000${height}`;
    if (seenWords.has(key)) return [];
    seenWords.add(key);
    return [{ text, x, y, width, height, confidence: normalizeConfidence(entry.confidence) }];
  }).sort((left, right) => left.y - right.y || left.x - right.x);
}

function pixelIntensity(data, offset, channels) {
  if (channels === 1 || channels === 2) return Number(data[offset]);
  return (Number(data[offset]) + Number(data[offset + 1]) + Number(data[offset + 2])) / 3;
}

function findRuns(length, isDark, minimumLength) {
  const runs = [];
  let start = -1;
  for (let position = 0; position <= length; position += 1) {
    const dark = position < length && isDark(position);
    if (dark && start < 0) start = position;
    if (!dark && start >= 0) {
      const end = position - 1;
      if (end - start + 1 >= minimumLength) runs.push({ start, end });
      start = -1;
    }
  }
  return runs;
}

function overlapRatio(first, second) {
  const overlap = Math.max(0, Math.min(first.end, second.end) - Math.max(first.start, second.start) + 1);
  return overlap / Math.max(1, Math.min(first.end - first.start + 1, second.end - second.start + 1));
}

function mergeParallelRuns(candidates) {
  const sorted = [...candidates].sort((left, right) => left.axis - right.axis || left.start - right.start);
  const groups = [];
  for (const candidate of sorted) {
    const group = groups[groups.length - 1];
    const last = group && group.members[group.members.length - 1];
    if (group && candidate.axis - last.axis <= 1 && overlapRatio(candidate, last) >= 0.7) {
      group.members.push(candidate);
      group.start = Math.min(group.start, candidate.start);
      group.end = Math.max(group.end, candidate.end);
    } else {
      groups.push({ members: [candidate], start: candidate.start, end: candidate.end });
    }
  }
  return groups.map((group) => ({
    axis: group.members.reduce((sum, entry) => sum + entry.axis, 0) / group.members.length,
    start: group.start,
    end: group.end
  }));
}

function detectTableLinesFromRaw(options) {
  const data = options && options.data;
  const width = Number(options && options.width);
  const height = Number(options && options.height);
  const channels = Math.max(1, Number(options && options.channels) || 1);
  if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return [];
  if (data.length < width * height * channels) throw new Error("Raw image buffer is smaller than its dimensions");
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 160;
  const ratio = clamp(Number(options.minLengthRatio) || 0.35, 0.05, 1);
  const darkAt = (x, y) => pixelIntensity(data, (y * width + x) * channels, channels) <= threshold;
  const horizontal = [];
  const vertical = [];
  for (let y = 0; y < height; y += 1) {
    for (const run of findRuns(width, (x) => darkAt(x, y), Math.ceil(width * ratio))) {
      horizontal.push({ axis: y, start: run.start, end: run.end });
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (const run of findRuns(height, (y) => darkAt(x, y), Math.ceil(height * ratio))) {
      vertical.push({ axis: x, start: run.start, end: run.end });
    }
  }
  return [
    ...mergeParallelRuns(horizontal).map((line) => ({ x1: line.start, y1: cleanNumber(line.axis), x2: line.end, y2: cleanNumber(line.axis) })),
    ...mergeParallelRuns(vertical).map((line) => ({ x1: cleanNumber(line.axis), y1: line.start, x2: cleanNumber(line.axis), y2: line.end }))
  ];
}

async function buildPdfTableWorkbook(pages, dependencies) {
  const injected = dependencies || {};
  const extractor = (!injected.detectTablesOnPage || !injected.buildWorkbookModel)
    ? require("./pdf-table-extractor")
    : {};
  const detectTablesOnPage = injected.detectTablesOnPage || extractor.detectTablesOnPage;
  const buildWorkbookModel = injected.buildWorkbookModel || extractor.buildWorkbookModel;
  const detectLines = injected.detectLines || detectTableLinesFromRaw;
  const renderPage = injected.renderPage;
  const ocrPage = injected.ocrPage;
  if (!Array.isArray(pages)) throw new TypeError("pages must be an array");

  const detectedPages = [];
  for (const page of pages) {
    let words = pdfTextContentToWords({ textContent: page.textContent, viewport: page.viewport });
    let source = "pdf-text";
    if (!words.length && ocrPage) {
      words = normalizeOcrResult(await ocrPage(page));
      source = "ocr";
    }
    const raw = page.raw || (renderPage ? await renderPage(page) : null);
    const lines = raw ? await detectLines(raw) : [];
    detectedPages.push(await detectTablesOnPage({
      pageNumber: page.pageNumber,
      width: page.width || (page.viewport && page.viewport.width),
      height: page.height || (page.viewport && page.viewport.height),
      source,
      words,
      lines
    }));
  }
  return buildWorkbookModel(detectedPages);
}

module.exports = {
  pdfTextContentToWords,
  normalizeOcrResult,
  detectTableLinesFromRaw,
  buildPdfTableWorkbook
};
