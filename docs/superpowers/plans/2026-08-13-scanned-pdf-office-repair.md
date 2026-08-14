# Scanned PDF Office Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Convert scanned and mixed PDFs into validated editable DOCX and structured XLSX files while preserving an original-reference section and failing explicitly on unusable recognition.

**Architecture:** Keep pdf2docx and Camelot as native-PDF fast paths. Add a page classifier and a versioned structure-manifest boundary around a bundled PP-StructureV3/img2table engine; normalized results feed dedicated DOCX and XLSX writers and validators before output publication.

**Tech Stack:** Electron/Node.js 22, PDF.js, Poppler, docx 9.5.1, ExcelJS, PaddleOCR 3.7.0, PaddlePaddle 3.2.2 CPU, img2table 2.0.0, Python 3.11, PyInstaller, Node test runner, Python unittest.

---

## File structure

New modules have one responsibility each:

- pdf-classifier.js: native/scanned/mixed page metrics and routing.
- pdf-structure-contract.js: schema-v1 validation and safe asset resolution.
- pdf-structure-engine.js: process timeout, private workspace, manifest loading, cleanup.
- pdf-structure-score.js: table scoring and primary/fallback selection.
- pdf-office-docx.js: Word reconstruction and structural validation.
- pdf-office-xlsx.js: workbook construction and structural validation.
- tools/docstructure-engine/flyingmouse_docstructure/: maintainable Python engine.
- scripts/build-docstructure-engine.ps1: reproducible Windows engine/model build.
- docstructure-engine-lock.json: exact runtime/model file hashes.

Existing orchestration remains in pdf.js; existing native table extraction remains in pdf-table.js.

### Task 1: Anonymous scanned-PDF regression fixture

**Files:**
- Create: tests/helpers/scanned-pdf-fixture.js
- Create: tests/fixtures/structure-manifest-v1.json
- Create: tests/pdf-scanned-routing.test.js
- Modify: package.json

- [ ] **Step 1: Create a generated image-only A4 fixture**

Implement createScannedTablePdf(outputPath) with sharp and pdf-lib. Render an anonymous 1653x2339 white page, a 4-column bordered table whose vertical rules are round(2339 * 0.32) pixels high, and harmless values ANONYMOUS CONFIRMATION, A-001, 2026-08, 0.00, Confirmed. Embed the PNG as the only PDF page content.

- [ ] **Step 2: Create the normalized manifest fixture**

Use schemaVersion 1 with one page, editable text 示例确认表, a 4x4 table, one horizontal merge, per-cell confidence, seal.png, and page-001.png. Use no real company, tax, person, or source-file data.

- [ ] **Step 3: Write the top-level failing route test**

~~~js
test("routes scanned DOCX through the structure converter", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-route-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = await createScannedTablePdf(path.join(scratch, "scan.pdf"));
  const outputPath = path.join(scratch, "scan.docx");
  const calls = [];
  await convertPdf(inputPath, outputPath, "docx", {
    classifyPdf: async () => ({ kind: "scanned", pages: [{ pageNumber: 1, kind: "scanned" }] }),
    convertStructuredPdf: async ({ target }) => {
      calls.push(target);
      await fsp.writeFile(outputPath, "fake");
    }
  });
  assert.deepEqual(calls, ["docx"]);
});
~~~

- [ ] **Step 4: Register and run the RED test**

Add tests/pdf-scanned-routing.test.js to both package scripts.

Run: node --test tests/pdf-scanned-routing.test.js

Expected: FAIL because convertPdf still selects plain Tesseract OCR.

- [ ] **Step 5: Commit**

~~~powershell
git add package.json tests/helpers/scanned-pdf-fixture.js tests/fixtures/structure-manifest-v1.json tests/pdf-scanned-routing.test.js
git commit -m "test: reproduce scanned PDF Office routing failure"
~~~

### Task 2: PDF classifier and routing seam

**Files:**
- Create: pdf-classifier.js
- Create: tests/pdf-classifier.test.js
- Modify: pdf.js
- Modify: package.json
- Modify: tests/text-conversion-integration.test.js

- [ ] **Step 1: Write classification tests**

Cover native pages, empty scans, one-character noise over a full-page image, and mixed documents.

~~~js
assert.equal(classifyDocument([{ characterCount: 120, printableRatio: 1, imageCoverage: 0 }]).kind, "native");
assert.equal(classifyDocument([{ characterCount: 0, printableRatio: 0, imageCoverage: 1 }]).kind, "scanned");
assert.equal(classifyDocument([
  { characterCount: 120, printableRatio: 1, imageCoverage: 0 },
  { characterCount: 0, printableRatio: 0, imageCoverage: 1 }
]).kind, "mixed");
~~~

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-classifier.test.js

Expected: FAIL with module not found.

- [ ] **Step 3: Implement deterministic classification**

~~~js
const MIN_NATIVE_CHARACTERS = 24;
const MIN_PRINTABLE_RATIO = 0.8;
const FULL_PAGE_IMAGE_COVERAGE = 0.7;

function classifyPageMetrics(metrics) {
  const reliableText = metrics.characterCount >= MIN_NATIVE_CHARACTERS
    && metrics.printableRatio >= MIN_PRINTABLE_RATIO;
  if (reliableText && metrics.imageCoverage < FULL_PAGE_IMAGE_COVERAGE) return "native";
  return "scanned";
}

function classifyDocument(pages) {
  const normalized = pages.map((page, index) => ({
    ...page,
    pageNumber: page.pageNumber || index + 1,
    kind: classifyPageMetrics(page)
  }));
  const kinds = new Set(normalized.map((page) => page.kind));
  return { kind: kinds.size > 1 ? "mixed" : normalized[0]?.kind || "scanned", pages: normalized };
}
~~~

classifyPdf uses the local PDF.js loader with isEvalSupported false, printable getTextContent items, and image paint operators. Negligible text plus page-image paint is imageCoverage 1. Destroy the loading task in finally.

- [ ] **Step 4: Add the injectable route**

~~~js
const classification = await (options.classifyPdf || classifyPdf)(inputPath);
if (classification.kind !== "native" && new Set(["docx", "xlsx"]).has(target)) {
  await (options.convertStructuredPdf || convertStructuredPdf)({
    inputPath, outputPath, target, classification, options
  });
  return;
}
~~~

TXT/HTML behavior remains unchanged. Export convertPdf for full-route tests.

- [ ] **Step 5: Run GREEN**

Run: node --test tests/pdf-classifier.test.js tests/pdf-scanned-routing.test.js tests/pdf2docx.test.js

Expected: all pass; native PDF stays on the old path.

- [ ] **Step 6: Commit**

~~~powershell
git add pdf-classifier.js pdf.js package.json tests/pdf-classifier.test.js tests/pdf-scanned-routing.test.js tests/text-conversion-integration.test.js
git commit -m "feat: classify scanned and mixed PDFs"
~~~

### Task 3: Structure-manifest contract

**Files:**
- Create: pdf-structure-contract.js
- Create: tests/pdf-structure-contract.test.js
- Modify: resource-policy.js
- Modify: package.json

- [ ] **Step 1: Write failing schema/security tests**

Accept the anonymous fixture. Reject schema 2, ../seal.png, absolute assets, negative/out-of-page boxes, duplicate cell origins, invalid spans, confidence outside 0..1, missing reference images, more than 100 tables/page, or more than 20,000 cells/table.

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-structure-contract.test.js

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement errors and limits**

~~~js
const STRUCTURE_SCHEMA_VERSION = 1;
const MAX_BLOCKS_PER_PAGE = 5000;
const MAX_TABLES_PER_PAGE = 100;
const MAX_CELLS_PER_TABLE = 20000;

function structureError(code, zhCN, enUS, cause) {
  const error = new Error(enUS, cause ? { cause } : undefined);
  error.code = code;
  error.messages = { zhCN, enUS };
  return error;
}
~~~

Resolve every asset against the private root and require it to remain below resolvedRoot + path.sep. Validate finite boxes, dimensions, unique cells, spans and regular files. Return a deeply frozen normalized manifest.

- [ ] **Step 4: Run GREEN**

Run: node --test tests/pdf-structure-contract.test.js

Expected: all contract and traversal tests pass.

- [ ] **Step 5: Commit**

~~~powershell
git add pdf-structure-contract.js resource-policy.js package.json tests/pdf-structure-contract.test.js
git commit -m "feat: validate PDF structure manifests"
~~~

### Task 4: Structured-engine process boundary

**Files:**
- Create: pdf-structure-engine.js
- Create: tests/pdf-structure-engine.test.js
- Modify: config.js
- Modify: runtime-paths.js
- Modify: electron-main.js
- Modify: tests/runtime-paths.test.js
- Modify: package.json

- [ ] **Step 1: Write failing path and runner tests**

Cover environment overrides, packaged paths, missing executable/models, nonzero exit, timeout, malformed JSON, missing manifest, and cleanup. Assert exact parse arguments: parse --input INPUT --output TEMP --models MODELS --language ch.

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-structure-engine.test.js tests/runtime-paths.test.js

Expected: FAIL because the paths and runner are absent.

- [ ] **Step 3: Add Windows runtime paths**

~~~js
docstructureEngine: override(env, "FLYINGMOUSE_DOCSTRUCTURE_ENGINE_PATH",
  path.join(resourcesPath, "docstructure", "docstructure-engine.exe")),
docstructureModels: override(env, "FLYINGMOUSE_DOCSTRUCTURE_MODEL_DIR",
  path.join(resourcesPath, "docstructure", "models"))
~~~

Set both variables in electron-main.js. Add development candidates under bin/docstructure in config.js.

- [ ] **Step 4: Implement private-workspace execution**

~~~js
async function withStructuredPdf(inputPath, options, consume) {
  const scratch = await fsp.mkdtemp(path.join(RUNTIME_DIR, "fm-pdf-structure-"));
  try {
    const manifest = await runAndLoadManifest(inputPath, scratch, options);
    return await consume(manifest, scratch);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
~~~

Use execFile/no shell, ten-minute timeout, schema validation, and stable errors PDF_STRUCTURE_ENGINE_MISSING, PDF_STRUCTURE_MODEL_MISSING, PDF_STRUCTURE_PARSE_FAILED, PDF_STRUCTURE_SCHEMA_INVALID. Log no recognized content or source path.

- [ ] **Step 5: Run GREEN and commit**

Run: node --test tests/pdf-structure-engine.test.js tests/runtime-paths.test.js

Expected: all pass and no temporary directory remains.

~~~powershell
git add pdf-structure-engine.js config.js runtime-paths.js electron-main.js package.json tests/pdf-structure-engine.test.js tests/runtime-paths.test.js
git commit -m "feat: add structured PDF engine boundary"
~~~

### Task 5: Editable DOCX writer and validator

**Files:**
- Create: pdf-office-docx.js
- Create: tests/pdf-office-docx.test.js
- Modify: package.json
- Modify: package-lock.json

- [ ] **Step 1: Install exact dependency**

Run: npm install --save-exact docx@9.5.1

Expected: package.json and lockfile change only for docx.

- [ ] **Step 2: Write RED tests**

From the anonymous manifest require editable w:t text, w:tbl, merge markup, seal media, Original reference heading, and one page-reference image. A full-page-image-only package must fail PDF_DOCX_NO_EDITABLE_CONTENT.

- [ ] **Step 3: Run RED**

Run: node --test tests/pdf-office-docx.test.js

Expected: FAIL because writer/validator are absent.

- [ ] **Step 4: Implement reconstruction**

Use Document, Paragraph, Table, TableRow, TableCell, ImageRun, PageBreak and Packer. Preserve reading order and spans; shade reviewable text; constrain media to A4 content width. Append:

~~~js
new Paragraph({
  text: "原件对照 / Original reference",
  heading: HeadingLevel.HEADING_1,
  pageBreakBefore: true
})
~~~

Write to a sibling temporary file, validate, then rename atomically. Delete nominal output on failure.

- [ ] **Step 5: Implement package validation**

Open ZIP entries with zip-util.js. Require word/document.xml, valid relationships/media, meaningful editable non-reference text or a table, and the expected reference image count. Images alone cannot pass.

- [ ] **Step 6: Run GREEN and commit**

Run: node --test tests/pdf-office-docx.test.js

Expected: all positive and negative checks pass.

~~~powershell
git add package.json package-lock.json pdf-office-docx.js tests/pdf-office-docx.test.js
git commit -m "feat: build validated editable DOCX from scans"
~~~

### Task 6: Structured XLSX writer and validator

**Files:**
- Create: pdf-office-xlsx.js
- Create: tests/pdf-office-xlsx.test.js
- Modify: package.json

- [ ] **Step 1: Write RED tests**

Require sheets 识别说明, P001-T01, 待核对 and 原件对照; editable string values, merges, highlighted low-confidence cells, engine metadata and reference image. Zero tables must throw PDF_TABLE_NOT_DETECTED; low table confidence must throw PDF_TABLE_OCR_LOW_QUALITY.

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-office-xlsx.test.js

Expected: FAIL because writer/validator are absent.

- [ ] **Step 3: Implement workbook creation**

~~~js
const HARD_TABLE_CONFIDENCE = 0.65;
const REVIEW_CELL_CONFIDENCE = 0.85;
~~~

Create one sheet per accepted table. Merge before assigning non-origin cells. Store identifiers/dates/amounts as strings. Add comments and amber fill below review threshold, list those addresses in 待核对, and place source thumbnails in 原件对照.

- [ ] **Step 4: Implement validation**

Reopen the saved workbook. Require at least one non-empty P###-T## sheet, sane merges, 识别说明, and 原件对照 with images. Raw OCR alone cannot pass. Delete invalid output.

- [ ] **Step 5: Run GREEN and commit**

Run: node --test tests/pdf-office-xlsx.test.js

Expected: all structure, confidence and reference-image checks pass.

~~~powershell
git add pdf-office-xlsx.js package.json tests/pdf-office-xlsx.test.js
git commit -m "feat: build validated XLSX tables from scans"
~~~

### Task 7: Deterministic table scoring and second opinion

**Files:**
- Create: pdf-structure-score.js
- Create: tests/pdf-structure-score.test.js
- Modify: pdf-structure-contract.js

- [ ] **Step 1: Write RED scoring tests**

Cover empty/populated ratio, confidence, grid consistency, invalid spans, agreement and conflicts. chooseTableCandidate selects the accepted higher score; candidates that disagree over 25 percent while neither reaches 0.8 fail low quality.

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-structure-score.test.js

Expected: FAIL because scoring is absent.

- [ ] **Step 3: Implement scoring**

~~~js
const score = 0.40 * meanCellConfidence
  + 0.25 * populatedCellRatio
  + 0.20 * gridConsistency
  + 0.15 * spanValidity;
~~~

Reject empty tables, impossible spans, score below 0.65, or populated ratio below 0.2. Reasons are bounded codes without cell text.

- [ ] **Step 4: Add fallback candidates**

Allow normalized tableCandidates from pp-structure-v3 and img2table. Define the page-level tableLike boolean and require both sources to use one normalized cell schema. The engine-side fallback that emits these candidates is implemented and tested in Task 8.

- [ ] **Step 5: Run GREEN and commit**

Run: node --test tests/pdf-structure-score.test.js tests/pdf-structure-contract.test.js

Expected: all deterministic selection tests pass.

~~~powershell
git add pdf-structure-score.js pdf-structure-contract.js tests/pdf-structure-score.test.js
git commit -m "feat: score scanned PDF table candidates"
~~~

### Task 8: Maintainable PP-StructureV3 engine

**Files:**
- Create: tools/docstructure-engine/requirements-win-x64.in
- Create: tools/docstructure-engine/requirements-build.in
- Create: tools/docstructure-engine/flyingmouse_docstructure/__init__.py
- Create: tools/docstructure-engine/flyingmouse_docstructure/__main__.py
- Create: tools/docstructure-engine/flyingmouse_docstructure/pipeline.py
- Create: tools/docstructure-engine/flyingmouse_docstructure/normalize.py
- Create: tools/docstructure-engine/flyingmouse_docstructure/img2table_adapter.py
- Create: tools/docstructure-engine/tests/test_normalize.py
- Create: tools/docstructure-engine/tests/test_cli.py
- Create: tools/docstructure-engine/docstructure-engine.spec

- [ ] **Step 1: Pin dependencies**

requirements-win-x64.in:

~~~text
paddlepaddle==3.2.2
paddleocr[doc-parser]==3.7.0
img2table[paddle]==2.0.0
Pillow==11.3.0
PyMuPDF==1.26.3
~~~

requirements-build.in contains:

~~~text
pip-tools==7.5.0
pyinstaller==6.15.0
~~~

The fully transitive, hash-locked requirement files are generated and committed in Task 10 after dependency acquisition.

- [ ] **Step 2: Write RED Python tests**

Feed anonymous Paddle-style dictionaries to normalize_page and require schema-v1 blocks/tables/cells/confidence and relative assets. Patch build_pipeline in CLI tests, run parse, require manifest.json, require --models, and assert no download function is called. Add an img2table adapter regression that consumes the generated A4 raster with 32-percent-height vertical rules and returns a 4-column candidate; this proves the original full-page-ratio defect is covered at the engine boundary.

- [ ] **Step 3: Run RED**

Run: python -m unittest discover -s tools/docstructure-engine/tests -v

Expected: FAIL because implementation is absent.

- [ ] **Step 4: Implement local-only PP-Structure**

Create PPStructureV3 with device cpu, use_formula_recognition false, use_seal_recognition true, and a generated local PaddleX configuration whose every model directory is below --models. Reject URLs. Verify all model directories before construction.

~~~python
pipeline = PPStructureV3(paddlex_config=str(local_config), device="cpu")
for page_index, result in enumerate(pipeline.predict(input=str(input_path))):
    pages.append(normalize_page(page_index + 1, result.json, output_dir))
~~~

Render page-###.png references, crop seals/figures through validated boxes, normalize tables, and atomically write UTF-8 manifest.json. img2table returns candidates only; it never writes the final workbook.

- [ ] **Step 5: Implement private failures**

Use exit 20 missing models, 21 parse failed, 22 invalid output, 23 resource limit. stderr contains only one JSON status with code, engine version, page count and elapsed milliseconds—never paths, filenames, OCR text or images.

- [ ] **Step 6: Run GREEN and commit**

Run: python -m unittest discover -s tools/docstructure-engine/tests -v

Expected: all tests pass without network/model downloads.

~~~powershell
git add tools/docstructure-engine
git commit -m "feat: add PP-StructureV3 engine source"
~~~

### Task 9: Integrate structured outputs and close false success

**Files:**
- Modify: pdf.js
- Modify: pdf-table.js
- Modify: pdf-structure-engine.js
- Modify: tests/pdf-scanned-routing.test.js
- Modify: tests/pdf2docx.test.js
- Modify: tests/conversion.test.js

- [ ] **Step 1: Expand RED route tests**

Cover scanned/mixed DOCX, scanned XLSX, zero-table XLSX, low-confidence XLSX, invalid output, and native pdf2docx returning a full-page-image-only file. Failed conversions leave no nominal output.

- [ ] **Step 2: Run RED**

Run: node --test tests/pdf-scanned-routing.test.js tests/pdf2docx.test.js tests/conversion.test.js

Expected: new cases fail because real structured conversion is not wired.

- [ ] **Step 3: Implement composition**

~~~js
async function convertStructuredPdf({ inputPath, outputPath, target, options = {} }) {
  return (options.withStructuredPdf || withStructuredPdf)(inputPath, options,
    async (manifest, assetRoot) => {
      const selected = selectAcceptedTables(manifest);
      if (target === "docx") return writeStructuredDocx({ manifest: selected, assetRoot, outputPath });
      if (target === "xlsx") return writeStructuredXlsx({ manifest: selected, assetRoot, outputPath });
      throw structureError("PDF_STRUCTURE_TARGET_UNSUPPORTED",
        "不支持该结构化输出格式。", "Unsupported structured PDF target.");
    });
}
~~~

Scanned/mixed XLSX uses structure parsing before the old OCR workbook. Scanned/mixed DOCX never treats plain OCR DOCX as success. Validate native pdf2docx and fall back to structured conversion when it is image-only.

- [ ] **Step 4: Close zero-table bypass**

For scanned/mixed XLSX, zero accepted tables throws PDF_TABLE_NOT_DETECTED before workbook creation. Raw sheets may exist only when another accepted table exists.

- [ ] **Step 5: Run GREEN and commit**

Run the Task 9 test command.

Expected: all route and false-success tests pass.

~~~powershell
git add pdf.js pdf-table.js pdf-structure-engine.js tests/pdf-scanned-routing.test.js tests/pdf2docx.test.js tests/conversion.test.js
git commit -m "fix: produce usable Office files from scanned PDFs"
~~~

### Task 10: Diagnostics, packaging and immutable locks

**Files:**
- Create: scripts/build-docstructure-engine.ps1
- Create: scripts/lock-docstructure-engine.js
- Create: docstructure-engine-lock.json
- Create: tools/docstructure-engine/requirements-win-x64.lock
- Create: tools/docstructure-engine/requirements-build.lock
- Create: tests/docstructure-packaging.test.js
- Modify: diagnostics.js
- Modify: tests/diagnostics.test.js
- Modify: package.json
- Modify: ci-engines-v1.json
- Modify: scripts/restore-ci-engines.ps1
- Modify: .github/workflows/release.yml
- Modify: tests/ci-engine-release.test.js
- Modify: tests/electron-hardening-static.test.js

- [ ] **Step 1: Write RED package/privacy tests**

Require Windows resources docstructure/docstructure-engine.exe and docstructure/models; exact size/SHA-256 lock entries; restore verification before use; probe before conversion tests; diagnostics with versions/status but no paths/text; and no structured engine claim in Win7/macOS manifests.

- [ ] **Step 2: Run RED**

Run: node --test tests/docstructure-packaging.test.js tests/diagnostics.test.js tests/ci-engine-release.test.js tests/electron-hardening-static.test.js

Expected: FAIL because resource and lock support are absent.

- [ ] **Step 3: Resolve and lock Python dependencies and models once**

In a network-enabled implementation environment, create an isolated resolver under output/docstructure-build, install pip-tools 7.5.0, and run pip-compile --generate-hashes for both checked-in .in files. Download the selected PP-StructureV3 models into staging, then run scripts/lock-docstructure-engine.js to record every model file's relative path, size, and SHA-256. Review and commit the generated .lock files and docstructure-engine-lock.json; no dependency or model may remain unpinned.

- [ ] **Step 4: Build the reproducible one-folder engine**

Run:

~~~powershell
powershell -ExecutionPolicy Bypass -File scripts/build-docstructure-engine.ps1 -PrepareModels -WriteLock
~~~

Expected: local probe succeeds and docstructure-engine-lock.json has real sizes and 64-character SHA-256 values. Commit the lock, never ignored binaries/models.

The PowerShell script must install with --require-hashes from the committed lock files, run Python tests, invoke the checked-in PyInstaller spec, copy only locked models, probe the result, and publish only to ignored bin/docstructure. Validate canonical paths and clean staging in finally.

- [ ] **Step 5: Wire package and CI restore**

Add Windows extraResources:

~~~json
{ "from": "bin/docstructure", "to": "docstructure" }
~~~

Extend the immutable CI engine asset and restore script. Release order is restore → hash validation → probe → conversion tests → electron-builder. Win7/macOS remain unchanged.

- [ ] **Step 6: Add bounded diagnostics**

Probe output is only available, engineVersion, modelLockVersion and errorCode. Exclude arguments, paths, URLs and content.

- [ ] **Step 7: Run GREEN and commit**

Run the Task 10 test command.

Expected: package whitelist, privacy, platform boundary, lock and release-order tests pass.

~~~powershell
git add scripts/build-docstructure-engine.ps1 scripts/lock-docstructure-engine.js docstructure-engine-lock.json tools/docstructure-engine/requirements-win-x64.lock tools/docstructure-engine/requirements-build.lock tests/docstructure-packaging.test.js diagnostics.js tests/diagnostics.test.js package.json ci-engines-v1.json scripts/restore-ci-engines.ps1 .github/workflows/release.yml tests/ci-engine-release.test.js tests/electron-hardening-static.test.js
git commit -m "build: package locked PDF structure engine"
~~~

### Task 11: Full verification and real supplied-PDF acceptance

**Files:**
- Modify: docs/HANDOFF.md
- Modify: docs/ARCHITECTURE.md
- Modify: README.md

- [ ] **Step 1: Run focused gates**

~~~powershell
node --test tests/pdf-classifier.test.js tests/pdf-structure-contract.test.js tests/pdf-structure-engine.test.js tests/pdf-structure-score.test.js tests/pdf-office-docx.test.js tests/pdf-office-xlsx.test.js tests/pdf-scanned-routing.test.js tests/pdf2docx.test.js tests/docstructure-packaging.test.js
python -m unittest discover -s tools/docstructure-engine/tests -v
~~~

Expected: all pass.

- [ ] **Step 2: Run complete repository gates**

~~~powershell
npm test
npm run test:ci
npm audit --omit=dev
git diff --check
~~~

Expected: tests pass, zero production vulnerabilities, no diff-check output.

- [ ] **Step 3: Build standard Windows package**

Run: npm run dist

Expected: NSIS/unpacked artifacts contain exact locked engine/models and packaged probe succeeds.

- [ ] **Step 4: Convert the supplied PDF through the real application path**

Use the PDF only at its original WeChat temporary path. Save artifacts under ignored output/scanned-pdf-acceptance. Invoke the same HTTP/Electron route as the UI.

DOCX must open, contain editable Chinese text/table, preserve seal/signature images, include one original-reference page, and not be image-only.

XLSX must contain 识别说明, at least one structured table, 原件对照, separate editable identifiers/dates/zero amounts, merges and review cells; raw-text-only output fails.

- [ ] **Step 5: Render and inspect every output page/sheet**

Render DOCX through bundled LibreOffice and inspect each page. Inspect each XLSX worksheet structurally and visually. Any missing key field, table, seal or reference image is failed acceptance.

- [ ] **Step 6: Verify fail-closed behavior**

Use one blurred/blank generated scan. XLSX must fail PDF_TABLE_NOT_DETECTED or PDF_TABLE_OCR_LOW_QUALITY; DOCX must fail PDF_DOCX_NO_EDITABLE_CONTENT; no nominal output or sensitive diagnostic remains.

- [ ] **Step 7: Record measured evidence**

Update docs with exact commit, engine/model versions, size delta, cold-start time, peak working set, conversion duration, test counts and real artifact findings. Do not claim Win7/macOS, GitHub release, Store certification or public availability.

- [ ] **Step 8: Request independent targeted review**

Review routing, path validation, subprocess cleanup, thresholds, Office validators, privacy, resources and real evidence. Resolve findings and rerun affected gates.

- [ ] **Step 9: Commit docs and check branch**

~~~powershell
git add README.md docs/ARCHITECTURE.md docs/HANDOFF.md
git commit -m "docs: record scanned PDF Office acceptance"
git status --short --branch
git log --oneline --decorate -12
~~~

Expected: clean codex/fix-scanned-pdf-office worktree with focused commits. Push, PR, GitHub release and Store submission remain separate user-authorized actions.
