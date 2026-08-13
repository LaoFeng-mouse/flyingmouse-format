const fs = require("node:fs");
const path = require("node:path");

const { STRUCTURE_LIMITS } = require("./resource-policy");

const STRUCTURE_SCHEMA_VERSION = 1;
const MAX_BLOCKS_PER_PAGE = STRUCTURE_LIMITS.maxBlocksPerPage;
const MAX_TABLES_PER_PAGE = STRUCTURE_LIMITS.maxTablesPerPage;
const MAX_CELLS_PER_TABLE = STRUCTURE_LIMITS.maxCellsPerTable;

const INVALID_ZH_CN = "PDF 结构清单格式无效，无法安全处理。";
const INVALID_EN_US = "The PDF structure manifest is invalid and cannot be processed safely.";

function structureError(code, zhCN, enUS, cause) {
  const error = new Error(enUS, cause ? { cause } : undefined);
  error.code = code;
  error.messages = { zhCN, enUS };
  return error;
}

function invalid(cause) {
  return structureError("PDF_STRUCTURE_SCHEMA_INVALID", INVALID_ZH_CN, INVALID_EN_US, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isPlainObject(value)) throw invalid();

  const clone = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined || typeof nested === "function" || typeof nested === "symbol") throw invalid();
    clone[key] = cloneJsonValue(nested);
  }
  return clone;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isStrictlyContained(root, candidate) {
  const comparedRoot = comparablePath(root);
  const comparedCandidate = comparablePath(candidate);
  const relative = path.relative(comparedRoot, comparedCandidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveAssetRoot(assetRoot) {
  if (typeof assetRoot !== "string" || !path.isAbsolute(assetRoot)) throw invalid();
  try {
    const rootStats = fs.lstatSync(assetRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw invalid();
    return {
      lexicalRoot: path.resolve(assetRoot),
      realRoot: fs.realpathSync.native(assetRoot)
    };
  } catch (error) {
    if (error?.code === "PDF_STRUCTURE_SCHEMA_INVALID") throw error;
    throw invalid(error);
  }
}

function validateAssetName(asset) {
  if (typeof asset !== "string" || asset.length === 0 || asset.includes("\0") || asset.includes("\\")) {
    throw invalid();
  }
  if (path.posix.isAbsolute(asset) || path.win32.isAbsolute(asset)) throw invalid();
  const segments = asset.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw invalid();
  return segments;
}

function resolveStructureAssetFromRoot(root, asset) {
  const segments = validateAssetName(asset);
  const candidate = path.resolve(root.lexicalRoot, ...segments);
  if (!isStrictlyContained(root.lexicalRoot, candidate)) throw invalid();

  try {
    const candidateStats = fs.lstatSync(candidate);
    if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) throw invalid();
    const realCandidate = fs.realpathSync.native(candidate);
    if (!isStrictlyContained(root.realRoot, realCandidate)) throw invalid();
    return realCandidate;
  } catch (error) {
    if (error?.code === "PDF_STRUCTURE_SCHEMA_INVALID") throw error;
    throw invalid(error);
  }
}

function resolveStructureAsset(assetRoot, asset) {
  return resolveStructureAssetFromRoot(resolveAssetRoot(assetRoot), asset);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeConfidence(value) {
  const normalized = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw invalid();
  }
  return normalized;
}

function validateBbox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw invalid();
  const [x0, y0, x1, y1] = bbox;
  if (x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0 || x1 > width || y1 > height) throw invalid();
}

function assertOptionalText(item) {
  if (Object.hasOwn(item, "text") && typeof item.text !== "string") throw invalid();
}

function assertNoOverlappingCells(cells) {
  if (cells.length < 2) return;

  const coordinates = [...new Set(cells.flatMap((cell) => [cell.column, cell.column + cell.columnSpan]))]
    .sort((left, right) => left - right);
  const coordinateIndex = new Map(coordinates.map((coordinate, index) => [coordinate, index]));
  const segmentCount = coordinates.length - 1;
  const maximum = new Int32Array(Math.max(1, segmentCount * 4));
  const lazy = new Int32Array(Math.max(1, segmentCount * 4));

  function add(node, left, right, from, to, delta) {
    if (from <= left && right <= to) {
      maximum[node] += delta;
      lazy[node] += delta;
      return;
    }
    const middle = Math.floor((left + right) / 2);
    if (from <= middle) add(node * 2, left, middle, from, to, delta);
    if (to > middle) add(node * 2 + 1, middle + 1, right, from, to, delta);
    maximum[node] = lazy[node] + Math.max(maximum[node * 2], maximum[node * 2 + 1]);
  }

  function query(node, left, right, from, to, inherited = 0) {
    if (from <= left && right <= to) return inherited + maximum[node];
    const middle = Math.floor((left + right) / 2);
    const nextInherited = inherited + lazy[node];
    let result = 0;
    if (from <= middle) result = query(node * 2, left, middle, from, to, nextInherited);
    if (to > middle) result = Math.max(result, query(node * 2 + 1, middle + 1, right, from, to, nextInherited));
    return result;
  }

  const events = cells.flatMap((cell) => {
    const from = coordinateIndex.get(cell.column);
    const to = coordinateIndex.get(cell.column + cell.columnSpan) - 1;
    return [
      { row: cell.row, delta: 1, from, to },
      { row: cell.row + cell.rowSpan, delta: -1, from, to }
    ];
  }).sort((left, right) => left.row - right.row || left.delta - right.delta);

  for (const event of events) {
    if (event.delta < 0) {
      add(1, 0, segmentCount - 1, event.from, event.to, -1);
    } else {
      if (query(1, 0, segmentCount - 1, event.from, event.to) > 0) throw invalid();
      add(1, 0, segmentCount - 1, event.from, event.to, 1);
    }
  }
}

function validateCell(cell, table, page) {
  if (!isPlainObject(cell)) throw invalid();
  if (!Number.isSafeInteger(cell.row) || cell.row < 0 || cell.row >= table.rowCount) throw invalid();
  if (!Number.isSafeInteger(cell.column) || cell.column < 0 || cell.column >= table.columnCount) throw invalid();
  if (!positiveInteger(cell.rowSpan) || !positiveInteger(cell.columnSpan)) throw invalid();
  if (cell.row + cell.rowSpan > table.rowCount || cell.column + cell.columnSpan > table.columnCount) {
    throw invalid();
  }
  validateBbox(cell.bbox, page.width, page.height);
  cell.confidence = normalizeConfidence(cell.confidence);
  assertOptionalText(cell);
}

function validateTable(table, page) {
  if (!isPlainObject(table)) throw invalid();
  if (typeof table.id !== "string" || table.id.length === 0) throw invalid();
  if (!positiveInteger(table.rowCount) || !positiveInteger(table.columnCount)) throw invalid();
  validateBbox(table.bbox, page.width, page.height);
  table.confidence = normalizeConfidence(table.confidence);
  if (!Array.isArray(table.cells) || table.cells.length > MAX_CELLS_PER_TABLE) throw invalid();
  for (const cell of table.cells) validateCell(cell, table, page);
  assertNoOverlappingCells(table.cells);
}

function validateBlock(block, page, root) {
  if (!isPlainObject(block) || typeof block.type !== "string" || block.type.length === 0) throw invalid();
  validateBbox(block.bbox, page.width, page.height);
  block.confidence = normalizeConfidence(block.confidence);
  assertOptionalText(block);
  if (Object.hasOwn(block, "asset")) resolveStructureAssetFromRoot(root, block.asset);
}

function validatePage(page, root) {
  if (!isPlainObject(page) || !positiveInteger(page.pageNumber)) throw invalid();
  if (typeof page.width !== "number" || !Number.isFinite(page.width) || page.width <= 0) throw invalid();
  if (typeof page.height !== "number" || !Number.isFinite(page.height) || page.height <= 0) throw invalid();
  if (![0, 90, 180, 270].includes(page.rotation)) throw invalid();
  resolveStructureAssetFromRoot(root, page.referenceImage);

  if (!Array.isArray(page.blocks) || page.blocks.length > MAX_BLOCKS_PER_PAGE) throw invalid();
  if (!Array.isArray(page.tables) || page.tables.length > MAX_TABLES_PER_PAGE) throw invalid();
  for (const block of page.blocks) validateBlock(block, page, root);
  for (const table of page.tables) validateTable(table, page);

  if (Object.hasOwn(page, "warnings")) {
    if (!Array.isArray(page.warnings) || !page.warnings.every((warning) => typeof warning === "string")) throw invalid();
  }
  if (Object.hasOwn(page, "elapsedMs")) {
    if (typeof page.elapsedMs !== "number" || !Number.isFinite(page.elapsedMs) || page.elapsedMs < 0) throw invalid();
  }
}

function validateStructureManifest(manifest, assetRoot) {
  const root = resolveAssetRoot(assetRoot);
  const normalized = cloneJsonValue(manifest);
  if (!isPlainObject(normalized) || normalized.schemaVersion !== STRUCTURE_SCHEMA_VERSION) throw invalid();
  if (!isPlainObject(normalized.engine)
    || typeof normalized.engine.name !== "string"
    || normalized.engine.name.length === 0
    || typeof normalized.engine.version !== "string"
    || normalized.engine.version.length === 0) {
    throw invalid();
  }
  if (!Array.isArray(normalized.pages)) throw invalid();
  for (const page of normalized.pages) validatePage(page, root);
  return deepFreeze(normalized);
}

module.exports = {
  STRUCTURE_SCHEMA_VERSION,
  MAX_BLOCKS_PER_PAGE,
  MAX_TABLES_PER_PAGE,
  MAX_CELLS_PER_TABLE,
  structureError,
  resolveStructureAsset,
  validateStructureManifest
};
