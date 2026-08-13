const { STRUCTURE_LIMITS } = require("./resource-policy");

const TABLE_SCORE_THRESHOLD = 0.65;
const POPULATED_RATIO_THRESHOLD = 0.2;
const CONFLICT_OVERRIDE_SCORE = 0.8;
const DISAGREEMENT_THRESHOLD = 0.25;
const MAX_CANDIDATES = 2;
const MAX_COMPARE_VALUE_LENGTH = 4096;
const APPROVED_SOURCES = Object.freeze(["pp-structure-v3", "img2table"]);
const SOURCE_PRIORITY = new Map(APPROVED_SOURCES.map((source, index) => [source, index]));
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const LOW_QUALITY_ZH_CN = "PDF 表格识别质量不足，无法安全生成可编辑表格。";
const LOW_QUALITY_EN_US = "The PDF table recognition quality is too low to create an editable table safely.";

function lowQualityError() {
  const error = new Error(LOW_QUALITY_EN_US);
  error.code = "PDF_TABLE_OCR_LOW_QUALITY";
  error.messages = { zhCN: LOW_QUALITY_ZH_CN, enUS: LOW_QUALITY_EN_US };
  return error;
}

function failLowQuality() {
  throw lowQualityError();
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  const seen = new WeakSet();
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const nested of Object.values(current)) stack.push(nested);
    Object.freeze(current);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeObject(value) {
  if (!isPlainObject(value)) return false;
  return !Reflect.ownKeys(value).some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function confidence(value) {
  const normalized = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) failLowQuality();
  return normalized;
}

function bbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) failLowQuality();
  const [x0, y0, x1, y1] = value;
  if (x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0) failLowQuality();
  return [x0, y0, x1, y1];
}

function normalizeCell(value) {
  if (!safeObject(value)) failLowQuality();
  if (!Number.isSafeInteger(value.row) || value.row < 0) failLowQuality();
  if (!Number.isSafeInteger(value.column) || value.column < 0) failLowQuality();
  if (!positiveInteger(value.rowSpan)) failLowQuality();
  if (!positiveInteger(value.columnSpan)) failLowQuality();
  if (Object.hasOwn(value, "text") && typeof value.text !== "string") failLowQuality();
  if (typeof value.text === "string" && value.text.length > MAX_COMPARE_VALUE_LENGTH) failLowQuality();
  return {
    row: value.row,
    column: value.column,
    rowSpan: value.rowSpan,
    columnSpan: value.columnSpan,
    bbox: bbox(value.bbox),
    ...(Object.hasOwn(value, "text") ? { text: value.text } : {}),
    confidence: confidence(value.confidence)
  };
}

function normalizeTableCandidateUnsafe(value) {
  if (!safeObject(value) || !APPROVED_SOURCES.includes(value.source)) failLowQuality();
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 256) failLowQuality();
  if (!positiveInteger(value.rowCount)) failLowQuality();
  if (!positiveInteger(value.columnCount)) failLowQuality();
  const gridSlots = value.rowCount * value.columnCount;
  if (!Number.isSafeInteger(gridSlots) || gridSlots > STRUCTURE_LIMITS.maxCellsPerTable) failLowQuality();
  if (!Array.isArray(value.cells) || value.cells.length > STRUCTURE_LIMITS.maxCellsPerTable) failLowQuality();

  return {
    source: value.source,
    table: {
      id: value.id,
      rowCount: value.rowCount,
      columnCount: value.columnCount,
      bbox: bbox(value.bbox),
      confidence: confidence(value.confidence),
      cells: value.cells.map(normalizeCell)
    }
  };
}

function normalizeTableCandidate(value) {
  try {
    return normalizeTableCandidateUnsafe(value);
  } catch {
    failLowQuality();
  }
}

function tableEvents(cells) {
  const events = new Map();
  cells.forEach((cell, index) => {
    for (const [row, add] of [[cell.row, true], [cell.row + cell.rowSpan, false]]) {
      if (!events.has(row)) events.set(row, []);
      events.get(row).push({ index, add });
    }
  });
  return events;
}

function sortedIntervals(active, cells) {
  return [...active].map((index) => {
    const cell = cells[index];
    return [cell.column, cell.column + cell.columnSpan];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function intervalsOverlap(intervals) {
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index][0] < intervals[index - 1][1]) return true;
  }
  return false;
}

function inspectGeometry(table) {
  if (table.cells.length === 0) {
    return { valid: true, occupiedSlots: 0, populatedAnchors: 0 };
  }
  let occupiedSlots = 0;
  let populatedAnchors = 0;

  for (const cell of table.cells) {
    if (cell.row >= table.rowCount || cell.column >= table.columnCount
      || cell.row + cell.rowSpan > table.rowCount
      || cell.column + cell.columnSpan > table.columnCount) {
      return { valid: false, occupiedSlots: 0, populatedAnchors: 0 };
    }
    const area = cell.rowSpan * cell.columnSpan;
    if (!Number.isSafeInteger(area) || !Number.isSafeInteger(occupiedSlots + area)) {
      return { valid: false, occupiedSlots: 0, populatedAnchors: 0 };
    }
    occupiedSlots += area;
    if (normalizeCompareValue(cell.text).length > 0) populatedAnchors += 1;
  }

  const events = tableEvents(table.cells);
  const active = new Set();
  const rows = [...events.keys()].sort((left, right) => left - right);
  let previousRow = rows[0];
  for (const row of rows) {
    if (row > previousRow && intervalsOverlap(sortedIntervals(active, table.cells))) {
      return { valid: false, occupiedSlots: 0, populatedAnchors: 0 };
    }
    for (const event of events.get(row)) {
      if (event.add) active.add(event.index);
      else active.delete(event.index);
    }
    previousRow = row;
  }
  return { valid: true, occupiedSlots, populatedAnchors };
}

function intervalIntersectionLength(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  let total = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const start = Math.max(left[leftIndex][0], right[rightIndex][0]);
    const end = Math.min(left[leftIndex][1], right[rightIndex][1]);
    if (end > start) total += end - start;
    if (left[leftIndex][1] <= right[rightIndex][1]) leftIndex += 1;
    else rightIndex += 1;
  }
  return total;
}

function exactIntersectionArea(left, right) {
  const leftEvents = tableEvents(left.cells);
  const rightEvents = tableEvents(right.cells);
  const rows = [...new Set([...leftEvents.keys(), ...rightEvents.keys()])].sort((a, b) => a - b);
  const activeLeft = new Set();
  const activeRight = new Set();
  let previousRow = rows[0];
  let area = 0;
  for (const row of rows) {
    if (row > previousRow) {
      const overlap = intervalIntersectionLength(
        sortedIntervals(activeLeft, left.cells),
        sortedIntervals(activeRight, right.cells)
      );
      area += overlap * (row - previousRow);
    }
    for (const event of leftEvents.get(row) || []) {
      if (event.add) activeLeft.add(event.index);
      else activeLeft.delete(event.index);
    }
    for (const event of rightEvents.get(row) || []) {
      if (event.add) activeRight.add(event.index);
      else activeRight.delete(event.index);
    }
    previousRow = row;
  }
  return area;
}

function sampledOccupancy(table) {
  const samples = 32;
  const occupied = new Set();
  for (const cell of table.cells) {
    const rowFrom = Math.max(0, Math.min(samples - 1,
      Math.floor(cell.row * samples / table.rowCount)));
    const rowTo = Math.max(rowFrom + 1, Math.min(samples,
      Math.ceil((cell.row + cell.rowSpan) * samples / table.rowCount)));
    const columnFrom = Math.max(0, Math.min(samples - 1,
      Math.floor(cell.column * samples / table.columnCount)));
    const columnTo = Math.max(columnFrom + 1, Math.min(samples,
      Math.ceil((cell.column + cell.columnSpan) * samples / table.columnCount)));
    for (let row = rowFrom; row < rowTo; row += 1) {
      for (let column = columnFrom; column < columnTo; column += 1) {
        occupied.add(row * samples + column);
      }
    }
  }
  return occupied;
}

function occupancyDistance(left, leftGeometry, right, rightGeometry) {
  if (left.rowCount === right.rowCount && left.columnCount === right.columnCount) {
    const intersection = exactIntersectionArea(left, right);
    const union = leftGeometry.occupiedSlots + rightGeometry.occupiedSlots - intersection;
    return union === 0 ? 0 : rounded(1 - intersection / union);
  }
  const occupiedLeft = sampledOccupancy(left);
  const occupiedRight = sampledOccupancy(right);
  let intersection = 0;
  for (const slot of occupiedLeft) if (occupiedRight.has(slot)) intersection += 1;
  const union = occupiedLeft.size + occupiedRight.size - intersection;
  return union === 0 ? 0 : rounded(1 - intersection / union);
}

function normalizeCompareValue(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > MAX_COMPARE_VALUE_LENGTH) failLowQuality();
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length > MAX_COMPARE_VALUE_LENGTH) failLowQuality();
  return normalized;
}

function anchorValueMap(table) {
  const values = new Map();
  for (const cell of table.cells) {
    const key = `${cell.row}:${cell.column}:${cell.rowSpan}:${cell.columnSpan}`;
    values.set(key, normalizeCompareValue(cell.text));
  }
  return values;
}

function valueDistance(left, right) {
  const leftValues = anchorValueMap(left);
  const rightValues = anchorValueMap(right);
  const keys = new Set([...leftValues.keys(), ...rightValues.keys()]);
  if (keys.size === 0) return 0;
  let differences = 0;
  let compared = 0;
  for (const key of keys) {
    const hasLeft = leftValues.has(key);
    const hasRight = rightValues.has(key);
    const leftValue = hasLeft ? leftValues.get(key) : "";
    const rightValue = hasRight ? rightValues.get(key) : "";
    if (hasLeft && hasRight && leftValue.length === 0 && rightValue.length === 0) continue;
    compared += 1;
    if (!hasLeft || !hasRight || leftValue !== rightValue) differences += 1;
  }
  return compared === 0 ? 0 : rounded(differences / compared);
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function scoreNormalized(normalized) {
  const { table } = normalized;
  if (table.cells.length === 0) {
    return deepFreeze({ source: normalized.source, table, meanCellConfidence: 0,
      populatedCellRatio: 0, gridConsistency: 0, spanValidity: 1, score: 0,
      accepted: false, reasons: ["TABLE_EMPTY"] });
  }

  const geometry = inspectGeometry(table);
  if (!geometry.valid) {
    return deepFreeze({ source: normalized.source, table, meanCellConfidence: 0,
      populatedCellRatio: 0, gridConsistency: 0, spanValidity: 0, score: 0,
      accepted: false, reasons: ["TABLE_SPAN_INVALID"] });
  }

  const gridSlots = table.rowCount * table.columnCount;
  const meanCellConfidence = rounded(table.cells.reduce((sum, cell) => sum + cell.confidence, 0) / table.cells.length);
  const populatedCellRatio = rounded(geometry.populatedAnchors / gridSlots);
  const gridConsistency = rounded(geometry.occupiedSlots / gridSlots);
  const spanValidity = 1;
  const score = rounded(0.40 * meanCellConfidence + 0.25 * populatedCellRatio
    + 0.20 * gridConsistency + 0.15 * spanValidity);
  const reasons = [];
  if (geometry.populatedAnchors === 0) reasons.push("TABLE_EMPTY");
  if (geometry.populatedAnchors > 0 && populatedCellRatio < POPULATED_RATIO_THRESHOLD) {
    reasons.push("TABLE_POPULATED_RATIO_LOW");
  }
  if (geometry.populatedAnchors > 0 && score < TABLE_SCORE_THRESHOLD) reasons.push("TABLE_SCORE_LOW");

  return deepFreeze({ source: normalized.source, table, meanCellConfidence,
    populatedCellRatio, gridConsistency, spanValidity, score,
    accepted: reasons.length === 0, reasons });
}

function scoreTableCandidate(value) {
  return scoreNormalized(normalizeTableCandidate(value));
}

function structuralDisagreement(leftValue, rightValue) {
  const left = normalizeTableCandidate(leftValue).table;
  const right = normalizeTableCandidate(rightValue).table;
  const leftGeometry = inspectGeometry(left);
  const rightGeometry = inspectGeometry(right);
  if (!leftGeometry.valid || !rightGeometry.valid) failLowQuality();

  const rowRatio = rounded(Math.abs(left.rowCount - right.rowCount) / Math.max(left.rowCount, right.rowCount));
  const columnRatio = rounded(Math.abs(left.columnCount - right.columnCount)
    / Math.max(left.columnCount, right.columnCount));
  const occupancyRatio = occupancyDistance(left, leftGeometry, right, rightGeometry);
  const valueRatio = valueDistance(left, right);
  return Object.freeze({ rowRatio, columnRatio, occupancyRatio, valueRatio,
    maximum: Math.max(rowRatio, columnRatio, occupancyRatio, valueRatio) });
}

function compareScored(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  const sourceOrder = SOURCE_PRIORITY.get(left.source) - SOURCE_PRIORITY.get(right.source);
  if (sourceOrder !== 0) return sourceOrder;
  return left.table.id < right.table.id ? -1 : left.table.id > right.table.id ? 1 : 0;
}

function chooseTableCandidate(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_CANDIDATES) failLowQuality();
  const normalized = values.map(normalizeTableCandidate);
  if (new Set(normalized.map((item) => item.source)).size !== normalized.length) failLowQuality();
  const scored = normalized.map(scoreNormalized);

  if (scored.length === 2) {
    const disagreement = structuralDisagreement(values[0], values[1]);
    if (disagreement.maximum > DISAGREEMENT_THRESHOLD
      && scored[0].score < CONFLICT_OVERRIDE_SCORE
      && scored[1].score < CONFLICT_OVERRIDE_SCORE) failLowQuality();
  }

  const accepted = scored.filter((item) => item.accepted).sort(compareScored);
  if (accepted.length === 0) failLowQuality();
  return accepted[0];
}

module.exports = {
  APPROVED_SOURCES,
  MAX_CANDIDATES,
  MAX_COMPARE_VALUE_LENGTH,
  TABLE_SCORE_THRESHOLD,
  POPULATED_RATIO_THRESHOLD,
  CONFLICT_OVERRIDE_SCORE,
  DISAGREEMENT_THRESHOLD,
  lowQualityError,
  normalizeTableCandidate,
  scoreTableCandidate,
  structuralDisagreement,
  chooseTableCandidate
};
