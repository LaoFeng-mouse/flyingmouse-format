const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let scratch;

function cell(row, column, text = "x", confidence = 0.9, rowSpan = 1, columnSpan = 1) {
  return {
    row,
    column,
    rowSpan,
    columnSpan,
    bbox: [column * 10, row * 10, (column + columnSpan) * 10, (row + rowSpan) * 10],
    text,
    confidence
  };
}

function candidate({
  source = "pp-structure-v3",
  id = "table-1",
  rows = 2,
  columns = 2,
  confidence = 0.9,
  cells = [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)]
} = {}) {
  return {
    source,
    id,
    rowCount: rows,
    columnCount: columns,
    bbox: [0, 0, columns * 10, rows * 10],
    confidence,
    cells
  };
}

function lowQuality(action, forbidden = []) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "PDF_TABLE_OCR_LOW_QUALITY");
    assert.equal(typeof error.messages?.zhCN, "string");
    assert.equal(typeof error.messages?.enUS, "string");
    const serialized = JSON.stringify(error);
    for (const value of forbidden) assert.ok(!serialized.includes(value));
    return true;
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fm-structure-score-"));
  fs.writeFileSync(path.join(scratch, "page-001.png"), tinyPng);
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("computes the exact weighted score from confidence, populated anchors, grid coverage, and spans", () => {
  const { scoreTableCandidate } = require("../pdf-structure-score");
  const result = scoreTableCandidate(candidate({
    cells: [cell(0, 0, "A", 0.8), cell(0, 1, "", 1), cell(1, 0, "B", 0.9)]
  }));

  assert.equal(result.meanCellConfidence, 0.9);
  assert.equal(result.populatedCellRatio, 0.5);
  assert.equal(result.gridConsistency, 0.75);
  assert.equal(result.spanValidity, 1);
  assert.equal(result.score, 0.785);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
});

test("counts populated anchor cells rather than slots covered by a spanning cell", () => {
  const { scoreTableCandidate } = require("../pdf-structure-score");
  const result = scoreTableCandidate(candidate({
    rows: 4,
    columns: 4,
    cells: [cell(0, 0, "one anchor", 1, 4, 4)]
  }));
  assert.equal(result.populatedCellRatio, 1 / 16);
  assert.equal(result.gridConsistency, 1);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.reasons, ["TABLE_POPULATED_RATIO_LOW"]);
});

test("rejects empty tables, low populated ratio, and scores below the hard threshold with bounded codes", () => {
  const { scoreTableCandidate } = require("../pdf-structure-score");
  assert.deepEqual(scoreTableCandidate(candidate({ cells: [] })).reasons, ["TABLE_EMPTY"]);

  const sparse = scoreTableCandidate(candidate({ rows: 3, columns: 3, cells: [cell(0, 0, "A", 1)] }));
  assert.equal(sparse.accepted, false);
  assert.deepEqual(sparse.reasons, ["TABLE_POPULATED_RATIO_LOW", "TABLE_SCORE_LOW"]);

  const lowScore = scoreTableCandidate(candidate({
    cells: [cell(0, 0, "A", 0.1), cell(0, 1, "B", 0.1), cell(1, 0, "C", 0.1), cell(1, 1, "D", 0.1)]
  }));
  assert.equal(lowScore.score, 0.64);
  assert.deepEqual(lowScore.reasons, ["TABLE_SCORE_LOW"]);
});

test("rejects impossible and overlapping spans without allocating the declared grid", () => {
  const { scoreTableCandidate } = require("../pdf-structure-score");
  for (const cells of [
    [cell(0, 0, "A", 1, 3, 1)],
    [cell(0, 0, "A", 1, 2, 1), cell(1, 0, "B", 1)]
  ]) {
    const result = scoreTableCandidate(candidate({ cells }));
    assert.equal(result.accepted, false);
    assert.deepEqual(result.reasons, ["TABLE_SPAN_INVALID"]);
  }
});

test("accepts touching intervals and rejects partial overlap", () => {
  const { scoreTableCandidate } = require("../pdf-structure-score");
  const touching = candidate({ rows: 1, columns: 2,
    cells: [cell(0, 0, "A", 1), cell(0, 1, "B", 1)] });
  assert.equal(scoreTableCandidate(touching).spanValidity, 1);
  const overlap = candidate({ rows: 2, columns: 2, cells: [
    cell(0, 0, "A", 1, 2, 1),
    cell(1, 0, "B", 1, 1, 2)
  ] });
  assert.deepEqual(scoreTableCandidate(overlap).reasons, ["TABLE_SPAN_INVALID"]);
});

test("normalizes only approved sources and enforces product and cell budgets without extra dimension caps", () => {
  const { MAX_CANDIDATES, normalizeTableCandidate, scoreTableCandidate } = require("../pdf-structure-score");
  assert.equal(MAX_CANDIDATES, 2);
  assert.equal(normalizeTableCandidate(candidate({ source: "img2table" })).source, "img2table");
  lowQuality(() => normalizeTableCandidate(candidate({ source: "private-engine-secret" })), ["private-engine-secret"]);
  const wide = scoreTableCandidate(candidate({ rows: 1, columns: 64,
    cells: Array.from({ length: 16 }, (_, column) => cell(0, column, "x", 1)) }));
  const tall = scoreTableCandidate(candidate({ rows: 20000, columns: 1,
    cells: Array.from({ length: 5000 }, (_, row) => cell(row, 0, "x", 1)) }));
  assert.equal(wide.table.columnCount, 64);
  assert.equal(wide.accepted, true);
  assert.equal(tall.table.rowCount, 20000);
  assert.equal(tall.accepted, true);
  lowQuality(() => scoreTableCandidate(candidate({ rows: Number.MAX_SAFE_INTEGER, columns: 1, cells: [] })));
  lowQuality(() => scoreTableCandidate(candidate({ rows: 200, columns: 200, cells: [] })));
});

test("chooses the accepted higher score when candidates structurally agree", () => {
  const { chooseTableCandidate } = require("../pdf-structure-score");
  const lower = candidate({ source: "pp-structure-v3", confidence: 0.8,
    cells: [cell(0, 0, "A", 0.75), cell(0, 1, "B", 0.75), cell(1, 0, "C", 0.75), cell(1, 1, "D", 0.75)] });
  const higher = candidate({ source: "img2table", confidence: 0.99 });
  const selected = chooseTableCandidate([lower, higher]);
  assert.equal(selected.source, "img2table");
  assert.equal(selected.score, 0.96);
});

test("fails closed for row, column, or occupancy disagreement over 25 percent when both scores are below 0.8", () => {
  const { chooseTableCandidate, structuralDisagreement } = require("../pdf-structure-score");
  const baseCells = [cell(0, 0, "A", 0.7), cell(0, 1, "B", 0.7), cell(1, 0, "C", 0.7)];
  const base = candidate({ cells: baseCells });
  const rowConflict = candidate({ source: "img2table", rows: 3, columns: 2,
    cells: [cell(0, 0, "A", 0.7), cell(1, 0, "B", 0.7), cell(2, 0, "C", 0.7), cell(2, 1, "D", 0.7)] });
  const columnConflict = candidate({ source: "img2table", rows: 2, columns: 3,
    cells: [cell(0, 0, "A", 0.7), cell(0, 1, "B", 0.7), cell(0, 2, "C", 0.7), cell(1, 0, "D", 0.7)] });
  const occupancyConflict = candidate({ source: "img2table", cells: [cell(0, 0, "secret", 0.7)] });

  assert.equal(structuralDisagreement(base, rowConflict).rowRatio, 0.333333333333);
  assert.equal(structuralDisagreement(base, columnConflict).columnRatio, 0.333333333333);
  assert.equal(structuralDisagreement(base, occupancyConflict).occupancyRatio, 0.666666666667);
  for (const other of [rowConflict, columnConflict, occupancyConflict]) {
    lowQuality(() => chooseTableCandidate([base, other]), ["secret"]);
  }
});

test("compares cell occupancy positions without inspecting OCR text", () => {
  const { structuralDisagreement } = require("../pdf-structure-score");
  const left = candidate({ cells: [cell(0, 0, "LEFT_PRIVATE", 0.8), cell(1, 1, "", 0.8)] });
  const right = candidate({ source: "img2table",
    cells: [cell(0, 1, "RIGHT_PRIVATE", 0.8), cell(1, 0, "", 0.8)] });
  const disagreement = structuralDisagreement(left, right);
  assert.equal(disagreement.rowRatio, 0);
  assert.equal(disagreement.columnRatio, 0);
  assert.equal(disagreement.occupancyRatio, 1);
});

test("preserves sparse cross-dimension occupancy and boundary cells at the last row and column", () => {
  const { chooseTableCandidate, structuralDisagreement } = require("../pdf-structure-score");
  const left = candidate({
    rows: 100,
    columns: 100,
    cells: [cell(1, 1, "same", 0.7), cell(99, 99, "boundary", 0.7)]
  });
  const right = candidate({
    source: "img2table",
    rows: 125,
    columns: 125,
    cells: [cell(5, 5, "same", 0.7), cell(124, 124, "boundary", 0.7)]
  });
  const disagreement = structuralDisagreement(left, right);
  assert.equal(disagreement.rowRatio, 0.2);
  assert.equal(disagreement.columnRatio, 0.2);
  assert.equal(disagreement.occupancyRatio, 0.666666666667);
  assert.ok(disagreement.occupancyRatio > 0.25);
  lowQuality(() => chooseTableCandidate([left, right]), ["same", "boundary"]);
});

test("compares aligned anchor values in memory using NFKC and collapsed whitespace", () => {
  const { structuralDisagreement } = require("../pdf-structure-score");
  const left = candidate({ cells: [
    cell(0, 0, "ＡＢＣ", 0.4), cell(0, 1, "one\n two", 0.4),
    cell(1, 0, "same", 0.4), cell(1, 1, "", 0.4)
  ] });
  const equivalent = candidate({ source: "img2table", cells: [
    cell(0, 0, " ABC ", 0.4), cell(0, 1, "one   two", 0.4),
    cell(1, 0, "same", 0.4), cell(1, 1, "", 0.4)
  ] });
  const result = structuralDisagreement(left, equivalent);
  assert.equal(result.valueRatio, 0);
  assert.deepEqual(Object.keys(result), ["rowRatio", "columnRatio", "occupancyRatio", "valueRatio", "maximum"]);
});

test("conflicts on over 25 percent differing or missing aligned values when neither score reaches 0.8", () => {
  const { chooseTableCandidate, structuralDisagreement } = require("../pdf-structure-score");
  const secretLeft = "PRIVATE_LEFT_VALUE";
  const secretRight = "PRIVATE_RIGHT_VALUE";
  const left = candidate({ cells: [
    cell(0, 0, secretLeft, 0.4), cell(0, 1, "same", 0.4),
    cell(1, 0, "left-only", 0.4), cell(1, 1, "stable", 0.4)
  ] });
  const right = candidate({ source: "img2table", cells: [
    cell(0, 0, secretRight, 0.4), cell(0, 1, "same", 0.4),
    cell(1, 1, "stable", 0.4)
  ] });
  const disagreement = structuralDisagreement(left, right);
  assert.equal(disagreement.valueRatio, 0.5);
  assert.equal(disagreement.maximum, 0.5);
  lowQuality(() => chooseTableCandidate([left, right]), [secretLeft, secretRight, "left-only"]);
});

test("does not let mutually empty aligned anchors dilute populated value disagreement", () => {
  const { chooseTableCandidate, structuralDisagreement } = require("../pdf-structure-score");
  const cellsFor = (changed) => Array.from({ length: 16 }, (_, index) => {
    const populated = index < 4;
    const text = populated ? (changed && index < 2 ? `changed-${index}` : `value-${index}`) : "";
    return cell(Math.floor(index / 4), index % 4, text, 0.8);
  });
  const left = candidate({ rows: 4, columns: 4, cells: cellsFor(false) });
  const right = candidate({ source: "img2table", rows: 4, columns: 4, cells: cellsFor(true) });
  assert.equal(structuralDisagreement(left, right).valueRatio, 0.5);
  lowQuality(() => chooseTableCandidate([left, right]), ["changed-0", "changed-1"]);
});

test("bounds normalized OCR values before comparison", () => {
  const { MAX_COMPARE_VALUE_LENGTH, structuralDisagreement } = require("../pdf-structure-score");
  assert.equal(MAX_COMPARE_VALUE_LENGTH, 4096);
  const oversized = "x".repeat(MAX_COMPARE_VALUE_LENGTH + 1);
  lowQuality(() => structuralDisagreement(
    candidate({ cells: [cell(0, 0, oversized)] }),
    candidate({ source: "img2table" })
  ), [oversized]);
});

test("allows a score of at least 0.8 to resolve structural disagreement", () => {
  const { chooseTableCandidate } = require("../pdf-structure-score");
  const trusted = candidate();
  const weakConflict = candidate({ source: "img2table", rows: 3, columns: 2,
    cells: [cell(0, 0, "private", 0.7), cell(1, 0, "x", 0.7), cell(2, 0, "y", 0.7), cell(2, 1, "z", 0.7)] });
  assert.equal(chooseTableCandidate([weakConflict, trusted]).source, "pp-structure-v3");
});

test("uses deterministic source then id tie-breaking independent of input order", () => {
  const { chooseTableCandidate } = require("../pdf-structure-score");
  const paddle = candidate({ source: "pp-structure-v3", id: "z" });
  const image = candidate({ source: "img2table", id: "a" });
  assert.equal(chooseTableCandidate([image, paddle]).source, "pp-structure-v3");
  assert.equal(chooseTableCandidate([paddle, image]).source, "pp-structure-v3");
});

test("keeps exact score, conflict override, and disagreement thresholds inclusive", () => {
  const { chooseTableCandidate, scoreTableCandidate, structuralDisagreement } = require("../pdf-structure-score");
  const atScore = candidate({ cells: [
    cell(0, 0, "A", 0.125), cell(0, 1, "B", 0.125),
    cell(1, 0, "C", 0.125), cell(1, 1, "D", 0.125)
  ] });
  assert.equal(scoreTableCandidate(atScore).score, 0.65);
  assert.equal(scoreTableCandidate(atScore).accepted, true);

  const atOverride = candidate({ cells: [
    cell(0, 0, "A", 0.5), cell(0, 1, "B", 0.5),
    cell(1, 0, "C", 0.5), cell(1, 1, "D", 0.5)
  ] });
  const conflicting = candidate({ source: "img2table", rows: 3, columns: 2, cells: [
    cell(0, 0, "A", 0.5), cell(0, 1, "B", 0.5),
    cell(1, 0, "C", 0.5), cell(1, 1, "D", 0.5),
    cell(2, 0, "E", 0.5), cell(2, 1, "F", 0.5)
  ] });
  assert.equal(scoreTableCandidate(atOverride).score, 0.8);
  assert.equal(chooseTableCandidate([atOverride, conflicting]).score, 0.8);

  const threeRows = candidate({ rows: 3, columns: 1, cells: [
    cell(0, 0, "A", 0.125), cell(1, 0, "B", 0.125), cell(2, 0, "C", 0.125)
  ] });
  const fourRows = candidate({ source: "img2table", rows: 4, columns: 1, cells: [
    cell(0, 0, "A", 0.125), cell(1, 0, "B", 0.125),
    cell(2, 0, "C", 0.125), cell(3, 0, "D", 0.125)
  ] });
  assert.equal(structuralDisagreement(threeRows, fourRows).maximum, 0.25);
  assert.equal(chooseTableCandidate([threeRows, fourRows]).score, 0.65);
});

test("rejects malformed candidate fields and candidate collection limits as low quality", () => {
  const { chooseTableCandidate, scoreTableCandidate } = require("../pdf-structure-score");
  for (const mutate of [
    (value) => { value.id = ""; },
    (value) => { value.confidence = 2; },
    (value) => { value.cells[0].confidence = -1; },
    (value) => { value.cells[0].rowSpan = 0; },
    (value) => { value.cells[0].text = {}; },
    (value) => { value.cells[0].bbox = [0, 0, 1]; }
  ]) {
    const value = candidate();
    mutate(value);
    lowQuality(() => scoreTableCandidate(value));
  }
  lowQuality(() => chooseTableCandidate([candidate(), candidate({ source: "img2table" }), candidate()]));
  lowQuality(() => chooseTableCandidate([candidate(), candidate()]));
});

test("returns detached deeply immutable scored and selected candidates", () => {
  const { chooseTableCandidate, scoreTableCandidate } = require("../pdf-structure-score");
  const input = candidate();
  const scored = scoreTableCandidate(input);
  const selected = chooseTableCandidate([input]);
  assertDeepFrozen(scored);
  assertDeepFrozen(selected);

  const snapshot = JSON.stringify(scored);
  input.id = "changed";
  input.cells[0].text = "changed";
  input.cells[0].bbox[0] = 999;
  scored.table.id = "attempt";
  scored.table.cells[0].text = "attempt";
  scored.table.cells[0].bbox[0] = 888;
  assert.equal(JSON.stringify(scored), snapshot);
  assert.equal(JSON.stringify(selected), snapshot);
});

test("returns one stable bilingual low-quality error without OCR text or private paths", () => {
  const { chooseTableCandidate } = require("../pdf-structure-score");
  const secret = "PRIVATE_CELL_TEXT_CANNOT_LEAK";
  const privatePath = "C:\\private\\document.pdf";
  lowQuality(() => chooseTableCandidate([
    candidate({ cells: [cell(0, 0, `${secret} ${privatePath}`, 0.1)] })
  ]), [secret, privatePath]);
});

test("collapses hostile property access without retaining its private failure", () => {
  const { normalizeTableCandidate } = require("../pdf-structure-score");
  const secret = "PRIVATE_GETTER_FAILURE_6F21";
  const hostile = candidate();
  Object.defineProperty(hostile, "cells", {
    enumerable: true,
    get() { throw new Error(secret); }
  });
  lowQuality(() => normalizeTableCandidate(hostile), [secret]);
});

test("validates page tableLike and integrates the selected candidate without mutating input", () => {
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const manifest = {
    schemaVersion: 1,
    engine: { name: "fixture", version: "1" },
    pages: [{
      pageNumber: 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", blocks: [], tables: [], tableLike: true,
      tableCandidates: [candidate(), candidate({ source: "img2table", confidence: 0.8 })],
      warnings: [], elapsedMs: 1
    }]
  };
  const snapshot = JSON.stringify(manifest);
  const normalized = validateStructureManifest(manifest, scratch);
  assert.equal(JSON.stringify(manifest), snapshot);
  assert.equal(normalized.pages[0].tableLike, true);
  assert.equal(normalized.pages[0].tables.length, 1);
  assert.equal(normalized.pages[0].tables[0].id, "table-1");
  assert.equal(Object.hasOwn(normalized.pages[0], "tableCandidates"), false);
  assert.ok(Object.isFrozen(normalized.pages[0].tables[0]));
});

test("requires tableLike pages to resolve a table and preserves non-table pages", () => {
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const make = (tableLike, extra = {}) => ({
    schemaVersion: 1, engine: { name: "fixture", version: "1" }, pages: [{
      pageNumber: 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", blocks: [], tables: [], tableLike,
      warnings: [], ...extra
    }]
  });
  assert.equal(validateStructureManifest(make(false), scratch).pages[0].tables.length, 0);
  lowQuality(() => validateStructureManifest(make(true), scratch));
  lowQuality(() => validateStructureManifest(make(true, { tableCandidates: [] }), scratch));
});

test("uses low-quality errors for malformed candidates but schema errors for resolved tables", () => {
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const make = () => ({
    schemaVersion: 1, engine: { name: "fixture", version: "1" }, pages: [{
      pageNumber: 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", blocks: [], tables: [], tableLike: true,
      tableCandidates: [candidate()], warnings: []
    }]
  });
  const malformedCandidate = make();
  malformedCandidate.pages[0].tableCandidates[0].bbox = [0, 0, 101, 10];
  lowQuality(() => validateStructureManifest(malformedCandidate, scratch));

  const malformedResolved = make();
  const resolved = malformedResolved.pages[0].tableCandidates[0];
  delete resolved.source;
  resolved.bbox = [0, 0, 101, 10];
  malformedResolved.pages[0].tables = [resolved];
  delete malformedResolved.pages[0].tableCandidates;
  assert.throws(() => validateStructureManifest(malformedResolved, scratch), (error) => {
    assert.equal(error.code, "PDF_STRUCTURE_SCHEMA_INVALID");
    return true;
  });
});

test("rechecks aggregate totals on the bounded clone when accessors change values", () => {
  const { STRUCTURE_LIMITS } = require("../resource-policy");
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const perPage = STRUCTURE_LIMITS.maxBlocksPerPage;
  const pageCount = Math.floor(STRUCTURE_LIMITS.maxTotalBlocks / perPage) + 1;
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = {
      pageNumber: index + 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", tables: [], tableLike: false, warnings: []
    };
    let reads = 0;
    Object.defineProperty(page, "blocks", {
      enumerable: true,
      get() {
        reads += 1;
        return reads <= 3 ? [] : new Array(perPage).fill({
          type: "paragraph", bbox: [0, 0, 1, 1], confidence: 1
        });
      }
    });
    return page;
  });
  assert.throws(() => validateStructureManifest({
    schemaVersion: 1, engine: { name: "fixture", version: "1" }, pages
  }, scratch), (error) => {
    assert.equal(error.code, "PDF_STRUCTURE_SCHEMA_INVALID");
    return true;
  });
});

test("normalizes missing tableLike while rejecting invalid candidate containers and duplicate sources", () => {
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const base = {
    schemaVersion: 1,
    engine: { name: "fixture", version: "1" },
    pages: [{ pageNumber: 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", blocks: [], tables: [], warnings: [] }]
  };
  assert.equal(validateStructureManifest(base, scratch).pages[0].tableLike, false);

  for (const mutate of [
    (page) => { page.tableLike = "yes"; },
    (page) => { page.tableLike = false; page.tables = [candidate()]; delete page.tables[0].source; },
    (page) => { page.tableLike = false; page.tableCandidates = [candidate()]; },
    (page) => { page.tableLike = true; page.tableCandidates = {}; },
    (page) => { page.tableLike = true; page.tableCandidates = [candidate(), candidate()]; },
    (page) => { page.tableLike = true; page.tableCandidates = [candidate(), candidate({ source: "img2table" }), candidate()]; }
  ]) {
    const manifest = JSON.parse(JSON.stringify(base));
    mutate(manifest.pages[0]);
    assert.throws(() => validateStructureManifest(manifest, scratch));
  }
});

test("counts unresolved candidates against the manifest-wide table budget before scoring", () => {
  const { STRUCTURE_LIMITS } = require("../resource-policy");
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const pageCount = Math.floor(STRUCTURE_LIMITS.maxTotalTables / 2) + 1;
  const manifest = {
    schemaVersion: 1,
    engine: { name: "fixture", version: "1" },
    pages: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1, width: 100, height: 100, rotation: 0,
      referenceImage: "page-001.png", blocks: [], tables: [], tableLike: true,
      tableCandidates: [candidate(), candidate({ source: "img2table" })], warnings: []
    }))
  };
  lowQuality(() => validateStructureManifest(manifest, scratch));
});

test("package and Win7 registrations include the score module and test exactly once", () => {
  const packageJson = require("../package.json");
  const profileSource = fs.readFileSync(path.join(__dirname, "..", "win7-build-profile.js"), "utf8");
  for (const script of ["pretest", "pretest:ci"]) {
    assert.equal(packageJson.scripts[script].split(/\s+/).filter((entry) => entry === "tests/pdf-structure-score.test.js").length, 1);
  }
  assert.equal(packageJson.build.files.filter((entry) => entry === "pdf-structure-score.js").length, 1);
  assert.match(profileSource, /"pdf-structure-score\.js"/);
});
