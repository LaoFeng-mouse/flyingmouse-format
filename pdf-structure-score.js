const { STRUCTURE_LIMITS } = require("./resource-policy");

const TABLE_SCORE_THRESHOLD = 0.65;
const POPULATED_RATIO_THRESHOLD = 0.2;
const CONFLICT_OVERRIDE_SCORE = 0.8;
const DISAGREEMENT_THRESHOLD = 0.25;
const MAX_CANDIDATES = 2;
const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 63;
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

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeObject(value) {
  if (!isPlainObject(value)) return false;
  return !Reflect.ownKeys(value).some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key));
}

function positiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
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
  if (!positiveInteger(value.rowSpan, MAX_TABLE_ROWS)) failLowQuality();
  if (!positiveInteger(value.columnSpan, MAX_TABLE_COLUMNS)) failLowQuality();
  if (Object.hasOwn(value, "text") && typeof value.text !== "string") failLowQuality();
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
  if (!positiveInteger(value.rowCount, MAX_TABLE_ROWS)) failLowQuality();
  if (!positiveInteger(value.columnCount, MAX_TABLE_COLUMNS)) failLowQuality();
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

function inspectGeometry(table) {
  if (table.cells.length === 0) {
    return { valid: true, occupiedSlots: 0, populatedSlots: 0, occupied: new Set() };
  }
  const occupied = new Set();
  let populatedSlots = 0;

  for (const cell of table.cells) {
    if (cell.row >= table.rowCount || cell.column >= table.columnCount
      || cell.row + cell.rowSpan > table.rowCount
      || cell.column + cell.columnSpan > table.columnCount) {
      return { valid: false, occupiedSlots: 0, populatedSlots: 0, occupied: new Set() };
    }
    const populated = typeof cell.text === "string" && cell.text.trim().length > 0;
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
        const slot = row * table.columnCount + column;
        if (occupied.has(slot)) {
          return { valid: false, occupiedSlots: 0, populatedSlots: 0, occupied: new Set() };
        }
        occupied.add(slot);
        if (populated) populatedSlots += 1;
      }
    }
  }
  return { valid: true, occupiedSlots: occupied.size, populatedSlots, occupied };
}

function occupancyDistance(left, leftGeometry, right, rightGeometry) {
  if (left.rowCount === right.rowCount && left.columnCount === right.columnCount) {
    let intersection = 0;
    for (const slot of leftGeometry.occupied) {
      if (rightGeometry.occupied.has(slot)) intersection += 1;
    }
    const union = leftGeometry.occupied.size + rightGeometry.occupied.size - intersection;
    return union === 0 ? 0 : rounded(1 - intersection / union);
  }
  const samples = 32;
  let union = 0;
  let intersection = 0;
  for (let sampleRow = 0; sampleRow < samples; sampleRow += 1) {
    const leftRow = Math.floor(sampleRow * left.rowCount / samples);
    const rightRow = Math.floor(sampleRow * right.rowCount / samples);
    for (let sampleColumn = 0; sampleColumn < samples; sampleColumn += 1) {
      const leftColumn = Math.floor(sampleColumn * left.columnCount / samples);
      const rightColumn = Math.floor(sampleColumn * right.columnCount / samples);
      const occupiedLeft = leftGeometry.occupied.has(leftRow * left.columnCount + leftColumn);
      const occupiedRight = rightGeometry.occupied.has(rightRow * right.columnCount + rightColumn);
      if (occupiedLeft || occupiedRight) union += 1;
      if (occupiedLeft && occupiedRight) intersection += 1;
    }
  }
  return union === 0 ? 0 : rounded(1 - intersection / union);
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function scoreNormalized(normalized) {
  const { table } = normalized;
  if (table.cells.length === 0) {
    return Object.freeze({ source: normalized.source, table, meanCellConfidence: 0,
      populatedCellRatio: 0, gridConsistency: 0, spanValidity: 1, score: 0,
      accepted: false, reasons: Object.freeze(["TABLE_EMPTY"]) });
  }

  const geometry = inspectGeometry(table);
  if (!geometry.valid) {
    return Object.freeze({ source: normalized.source, table, meanCellConfidence: 0,
      populatedCellRatio: 0, gridConsistency: 0, spanValidity: 0, score: 0,
      accepted: false, reasons: Object.freeze(["TABLE_SPAN_INVALID"]) });
  }

  const gridSlots = table.rowCount * table.columnCount;
  const meanCellConfidence = rounded(table.cells.reduce((sum, cell) => sum + cell.confidence, 0) / table.cells.length);
  const populatedCellRatio = rounded(geometry.populatedSlots / gridSlots);
  const gridConsistency = rounded(geometry.occupiedSlots / gridSlots);
  const spanValidity = 1;
  const score = rounded(0.40 * meanCellConfidence + 0.25 * populatedCellRatio
    + 0.20 * gridConsistency + 0.15 * spanValidity);
  const reasons = [];
  if (geometry.populatedSlots === 0) reasons.push("TABLE_EMPTY");
  if (geometry.populatedSlots > 0 && populatedCellRatio < POPULATED_RATIO_THRESHOLD) {
    reasons.push("TABLE_POPULATED_RATIO_LOW");
  }
  if (geometry.populatedSlots > 0 && score < TABLE_SCORE_THRESHOLD) reasons.push("TABLE_SCORE_LOW");

  return Object.freeze({ source: normalized.source, table, meanCellConfidence,
    populatedCellRatio, gridConsistency, spanValidity, score,
    accepted: reasons.length === 0, reasons: Object.freeze(reasons) });
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
  return Object.freeze({ rowRatio, columnRatio, occupancyRatio,
    maximum: Math.max(rowRatio, columnRatio, occupancyRatio) });
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
  MAX_TABLE_ROWS,
  MAX_TABLE_COLUMNS,
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
