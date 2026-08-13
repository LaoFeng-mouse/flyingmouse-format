const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const fixturePath = path.join(__dirname, "fixtures", "structure-manifest-v1.json");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let scratch;
let assetRoot;

function fixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

function assertSchemaError(action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "PDF_STRUCTURE_SCHEMA_INVALID");
    assert.equal(typeof error.messages?.zhCN, "string");
    assert.equal(typeof error.messages?.enUS, "string");
    assert.ok(error.messages.zhCN.length > 0);
    assert.ok(error.messages.enUS.length > 0);
    assert.ok(!error.message.includes(assetRoot));
    assert.ok(!error.messages.zhCN.includes(assetRoot));
    assert.ok(!error.messages.enUS.includes(assetRoot));
    return true;
  });
}

function invalidWith(mutate, root = assetRoot) {
  const manifest = fixture();
  mutate(manifest);
  const { validateStructureManifest } = require("../pdf-structure-contract");
  assertSchemaError(() => validateStructureManifest(manifest, root));
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fm-structure-contract-"));
  assetRoot = path.join(scratch, "assets");
  fs.mkdirSync(assetRoot);
  fs.writeFileSync(path.join(assetRoot, "page-001.png"), tinyPng);
  fs.writeFileSync(path.join(assetRoot, "seal.png"), tinyPng);
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("exports the schema contract, bilingual error helper, and shared resource limits", () => {
  const contract = require("../pdf-structure-contract");
  const { STRUCTURE_LIMITS } = require("../resource-policy");

  assert.equal(contract.STRUCTURE_SCHEMA_VERSION, 1);
  assert.equal(contract.MAX_BLOCKS_PER_PAGE, 5000);
  assert.equal(contract.MAX_TABLES_PER_PAGE, 100);
  assert.equal(contract.MAX_CELLS_PER_TABLE, 20000);
  assert.equal(contract.MAX_BLOCKS_PER_PAGE, STRUCTURE_LIMITS.maxBlocksPerPage);
  assert.equal(contract.MAX_TABLES_PER_PAGE, STRUCTURE_LIMITS.maxTablesPerPage);
  assert.equal(contract.MAX_CELLS_PER_TABLE, STRUCTURE_LIMITS.maxCellsPerTable);

  const cause = new Error("private detail");
  const error = contract.structureError("EXAMPLE", "中文错误", "English error", cause);
  assert.equal(error.code, "EXAMPLE");
  assert.deepEqual(error.messages, { zhCN: "中文错误", enUS: "English error" });
  assert.equal(error.message, "English error");
  assert.equal(error.cause, cause);
});

test("accepts the anonymous fixture, normalizes confidence, deep-freezes output, and preserves input", () => {
  const { validateStructureManifest } = require("../pdf-structure-contract");
  const manifest = fixture();
  manifest.pages[0].blocks[0].confidence = "0.75";
  manifest.pages[0].tables[0].confidence = "0.8";
  manifest.pages[0].tables[0].cells[0].confidence = "0.6";
  const beforeJson = JSON.stringify(manifest);

  const normalized = validateStructureManifest(manifest, assetRoot);

  assert.notEqual(normalized, manifest);
  assert.equal(JSON.stringify(manifest), beforeJson);
  assert.equal(normalized.pages[0].blocks[0].confidence, 0.75);
  assert.equal(normalized.pages[0].tables[0].confidence, 0.8);
  assert.equal(normalized.pages[0].tables[0].cells[0].confidence, 0.6);
  assert.equal(Object.hasOwn(normalized.pages[0].blocks[2], "text"), false);
  assertDeepFrozen(normalized);
});

test("safe asset resolution accepts contained regular files without changing manifest paths", () => {
  const { resolveStructureAsset, validateStructureManifest } = require("../pdf-structure-contract");
  const resolved = resolveStructureAsset(assetRoot, "seal.png");
  assert.equal(resolved, fs.realpathSync(path.join(assetRoot, "seal.png")));
  assert.equal(validateStructureManifest(fixture(), assetRoot).pages[0].referenceImage, "page-001.png");
});

test("rejects unsupported schema versions and malformed manifest containers", () => {
  invalidWith((manifest) => { manifest.schemaVersion = 2; });
  invalidWith((manifest) => { manifest.pages = {}; });
  invalidWith((manifest) => { manifest.pages[0] = null; });
  invalidWith((manifest) => { manifest.pages[0].blocks = {}; });
  invalidWith((manifest) => { manifest.pages[0].blocks[0] = null; });
  invalidWith((manifest) => { manifest.pages[0].tables = {}; });
  invalidWith((manifest) => { manifest.pages[0].tables[0] = null; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells = {}; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0] = null; });

  const { validateStructureManifest } = require("../pdf-structure-contract");
  assertSchemaError(() => validateStructureManifest(null, assetRoot));
});

test("rejects traversal, absolute paths, UNC paths, alternate separators, and the root itself", () => {
  const unsafe = [
    "../seal.png",
    "nested/../../seal.png",
    "/tmp/seal.png",
    "C:\\temp\\seal.png",
    "C:/temp/seal.png",
    "\\\\server\\share\\seal.png",
    "nested\\seal.png",
    "."
  ];
  for (const asset of unsafe) {
    invalidWith((manifest) => { manifest.pages[0].blocks[2].asset = asset; });
  }
});

test("rejects missing assets, directories, unexpected asset types, and invalid roots", () => {
  fs.mkdirSync(path.join(assetRoot, "directory.png"));
  invalidWith((manifest) => { manifest.pages[0].blocks[2].asset = "missing.png"; });
  invalidWith((manifest) => { manifest.pages[0].blocks[2].asset = "directory.png"; });
  invalidWith((manifest) => { manifest.pages[0].blocks[2].asset = { file: "seal.png" }; });
  invalidWith((manifest) => { manifest.pages[0].referenceImage = ["page-001.png"]; });

  const missingRoot = path.join(scratch, "missing-root");
  const fileRoot = path.join(scratch, "file-root");
  fs.writeFileSync(fileRoot, "not a directory");
  invalidWith(() => {}, missingRoot);
  invalidWith(() => {}, fileRoot);
});

test("rejects a symlink or junction that resolves outside the asset root when supported", (t) => {
  const external = path.join(scratch, "external-assets");
  const link = path.join(assetRoot, "linked-assets");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "outside.png"), tinyPng);
  try {
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip(`symbolic links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  invalidWith((manifest) => { manifest.pages[0].blocks[2].asset = "linked-assets/outside.png"; });
});

test("rejects negative, non-finite, reversed, and out-of-page boxes", () => {
  const badBoxes = [
    [-1, 0, 10, 10],
    [0, Number.NaN, 10, 10],
    [0, 0, Number.POSITIVE_INFINITY, 10],
    [10, 0, 9, 10],
    [0, 10, 10, 9],
    [0, 0, 1654, 10],
    [0, 0, 10, 2340]
  ];
  for (const bbox of badBoxes) {
    invalidWith((manifest) => { manifest.pages[0].blocks[0].bbox = bbox; });
  }
  invalidWith((manifest) => { manifest.pages[0].tables[0].bbox = [0, 0, 2000, 10]; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].bbox = [0, 0, 10, 3000]; });
});

test("rejects invalid page numbers, dimensions, and rotations", () => {
  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1653"]) {
    invalidWith((manifest) => { manifest.pages[0].width = width; });
  }
  for (const height of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY, "2339"]) {
    invalidWith((manifest) => { manifest.pages[0].height = height; });
  }
  for (const rotation of [-90, 45, 360, Number.NaN, "0"]) {
    invalidWith((manifest) => { manifest.pages[0].rotation = rotation; });
  }
  invalidWith((manifest) => { manifest.pages[0].pageNumber = 0; });
});

test("rejects duplicate cell origins and row or column origins outside a table", () => {
  invalidWith((manifest) => {
    manifest.pages[0].tables[0].cells[1].row = manifest.pages[0].tables[0].cells[0].row;
    manifest.pages[0].tables[0].cells[1].column = manifest.pages[0].tables[0].cells[0].column;
  });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].row = 4; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].column = 4; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].row = -1; });
});

test("rejects non-positive or out-of-dimension spans", () => {
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].rowSpan = 0; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].columnSpan = -1; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].rowSpan = 5; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[1].columnSpan = 5; });
});

test("rejects overlapping spanned cells even when their origins differ", () => {
  invalidWith((manifest) => {
    const table = manifest.pages[0].tables[0];
    table.rowCount = 2;
    table.columnCount = 2;
    table.cells = [
      { row: 0, column: 0, rowSpan: 2, columnSpan: 1, bbox: [0, 0, 10, 20], confidence: 1 },
      { row: 1, column: 0, rowSpan: 1, columnSpan: 1, bbox: [0, 10, 10, 20], confidence: 1 }
    ];
  });
});

test("rejects confidence outside zero to one, non-finite values, and non-numeric strings", () => {
  for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "high", ""]) {
    invalidWith((manifest) => { manifest.pages[0].blocks[0].confidence = confidence; });
  }
  invalidWith((manifest) => { manifest.pages[0].tables[0].confidence = 2; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].confidence = -1; });
});

test("rejects malformed block, table, and cell fields", () => {
  invalidWith((manifest) => { manifest.pages[0].blocks[0].type = ""; });
  invalidWith((manifest) => { manifest.pages[0].blocks[0].bbox = [0, 1, 2]; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].id = 10; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].rowCount = 0; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].columnCount = 1.5; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].row = 0.5; });
  invalidWith((manifest) => { manifest.pages[0].tables[0].cells[0].text = { recognized: true }; });
});

test("enforces per-page and per-table structure budgets before item validation", () => {
  const { MAX_BLOCKS_PER_PAGE, MAX_TABLES_PER_PAGE, MAX_CELLS_PER_TABLE } = require("../pdf-structure-contract");
  invalidWith((manifest) => {
    manifest.pages[0].blocks = new Array(MAX_BLOCKS_PER_PAGE + 1).fill(null);
  });
  invalidWith((manifest) => {
    manifest.pages[0].tables = new Array(MAX_TABLES_PER_PAGE + 1).fill(null);
  });
  invalidWith((manifest) => {
    manifest.pages[0].tables[0].cells = new Array(MAX_CELLS_PER_TABLE + 1).fill(null);
  });
});

test("package scripts and build whitelist include the contract exactly once", () => {
  const packageJson = require("../package.json");
  for (const scriptName of ["test", "test:ci"]) {
    const entries = packageJson.scripts[scriptName].trim().split(/\s+/);
    assert.equal(entries.filter((entry) => entry === "tests/pdf-structure-contract.test.js").length, 1);
  }
  assert.equal(packageJson.build.files.filter((entry) => entry === "pdf-structure-contract.js").length, 1);
});
