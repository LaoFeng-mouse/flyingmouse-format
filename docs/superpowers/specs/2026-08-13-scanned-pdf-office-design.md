# Mahiro Format Scanned PDF to DOCX/XLSX Repair Design

## Objective

Repair PDF to DOCX and PDF to XLSX for image-only or poorly extractable scanned documents. A successful conversion must produce usable Office content, not merely a file with the requested extension:

- DOCX contains editable text and editable tables where structure can be recovered, preserves seals/signatures as images, and appends a page-by-page original facsimile for visual verification.
- XLSX contains editable structured cells, a recognition summary, confidence and warnings, and an original-reference worksheet.
- Missing tables, missing required content, low confidence, or an unavailable parsing engine causes an explicit conversion failure instead of a nominally successful garbage or raw-text-only workbook.

The supplied tax declaration PDF is local acceptance evidence only. It must never be committed, copied into fixtures, logged by filename, or included in release artifacts.

## Confirmed failure

The supplied one-page PDF is an image-only CamScanner document. PDF.js returns no extractable rows. The current top-level DOCX route checks those rows before invoking the bundled `pdf2docx` engine, so it immediately selects the Tesseract plain-text fallback. That fallback creates a tiny DOCX with OCR garbage and no table or image. Direct `pdf2docx` conversion preserves appearance only by embedding the whole page as one image, leaving no editable document structure.

The XLSX route first tries Camelot, which cannot read tables from image-only PDFs. Its OpenCV fallback renders the page at 200 DPI but rejects vertical table lines shorter than 35 percent of the full page height. The supplied table occupies about 32 percent, so all vertical lines are removed. With fewer than three x-coordinates, no grid is emitted. The current quality gate ignores OCR pages with zero detected tables, allowing a raw-text-only workbook with zero confidence to be returned as success.

## Chosen architecture

Use a hybrid pipeline rather than replacing the fast paths that already work:

1. Classify each PDF from PDF.js text coverage, text quality, and page image coverage.
2. Route native/digital PDFs to the existing `pdf2docx` and Camelot paths.
3. Route scanned or unreliable PDFs to a pinned PaddleOCR PP-StructureV3 document-structure engine.
4. Use `img2table` as a table-specific second opinion when PP-StructureV3 reports no usable table on a page that has table-like line or alignment evidence.
5. Build DOCX and XLSX from one normalized intermediate manifest, then validate the generated Office artifact before returning success.

The current Tesseract and line detector remain lightweight fallbacks for TXT/HTML and diagnostics. They are not authoritative DOCX/XLSX success paths for scanned PDFs.

## PDF classification and routing

Classification is deterministic and page-aware. For each page it records:

- non-whitespace text item count and character count;
- text bounding-box coverage and printable-character ratio;
- rendered image coverage;
- whether the page is native, scanned, or mixed.

A PDF is routed to structured scanning when every page lacks reliable text, or when any page requiring Office structure is scanned/mixed and the native result would omit material content. Classification results are included in bounded diagnostics without source paths or recognized document text.

DOCX routing:

- native PDF: run `pdf2docx`, validate the result, and fall back to PP-StructureV3 if validation shows no meaningful editable content;
- scanned/mixed PDF: run PP-StructureV3 directly;
- plain OCR DOCX is no longer treated as a successful scanned-document conversion.

XLSX routing:

- native PDF: run Camelot and score its table model;
- scanned/mixed PDF: run PP-StructureV3;
- if PP-StructureV3 finds no usable table but table-like evidence exists, run `img2table` with PaddleOCR output;
- if both engines return candidates, choose only through deterministic quality scoring; do not concatenate conflicting cells;
- if no candidate passes, fail with `PDF_TABLE_NOT_DETECTED`.

## Structured engine contract

The packaged document engine exposes a versioned command that accepts an input PDF and a private temporary output directory. It emits `manifest.json` plus cropped images. The application never parses human-readable engine stdout as document data.

The manifest contains:

- schema and engine versions;
- page dimensions and rotation;
- ordered layout blocks with type, bounding box, text, and confidence;
- tables with row/column counts, cell spans, cell bounding boxes, text, and confidence;
- non-text elements such as seals, signatures, and figures with local relative asset names;
- page-level warnings and timing;
- no absolute source paths.

The Node process validates the schema, bounds, counts, relative asset paths, and resource limits before using it. Unknown schema versions, path traversal, malformed coordinates, excessive cells, and missing assets fail closed.

## DOCX construction

The scanned-document writer reconstructs content in reading order:

- headings and paragraphs become editable Word paragraphs;
- recognized tables become Word tables with row/column spans;
- seals, signatures, and figures are inserted as images near their source block and are never converted into guessed text;
- page breaks preserve source-page boundaries;
- an `原件对照 / Original reference` section appends one rendered image per source page.

The facsimile section is mandatory for scanned PDFs because OCR and layout reconstruction are probabilistic. It does not replace editable content. If no meaningful editable text or table can be produced, the conversion fails even if facsimile images exist.

DOCX validation opens the ZIP package and requires valid relationships, at least one meaningful editable paragraph or table, expected table dimensions when tables were detected, all referenced media, and the original-reference pages. A full-page-image-only DOCX cannot pass as an editable conversion.

## XLSX construction

The workbook contains:

- `识别说明`: engine version, page classification, per-page table count, confidence, and bounded warnings;
- one worksheet per accepted table, preserving merged cells where available;
- `原件对照`: source page thumbnails with page numbers and a reminder to verify low-confidence cells;
- optional `待核对`: cell address, recognized value, confidence, and source page for cells below the review threshold but above the hard-failure threshold.

Raw OCR text is diagnostic evidence only and cannot be the sole content of a successful XLSX. Workbook validation requires at least one accepted table, non-empty structured cells, sane dimensions, and consistent merges. A table-level confidence below the hard threshold or missing critical cells causes `PDF_TABLE_OCR_LOW_QUALITY`; reviewable cells above that threshold are highlighted and listed in `待核对`.

## Quality scoring and failure behavior

Candidate tables are scored from OCR confidence, populated-cell ratio, grid consistency, span validity, repeated row/column alignment, and disagreement between engines. Thresholds are constants covered by fixtures, not hidden magic values tied to full-page dimensions.

Stable failures include:

- `PDF_STRUCTURE_ENGINE_MISSING`
- `PDF_STRUCTURE_MODEL_MISSING`
- `PDF_STRUCTURE_PARSE_FAILED`
- `PDF_STRUCTURE_SCHEMA_INVALID`
- `PDF_TABLE_NOT_DETECTED`
- `PDF_TABLE_OCR_LOW_QUALITY`
- `PDF_DOCX_NO_EDITABLE_CONTENT`
- `PDF_OFFICE_OUTPUT_INVALID`

Errors retain bilingual user messages and bounded internal reasons. Engine name, version, exit code, elapsed time, classification, table count, and confidence may be logged. Source text, full source paths, source filenames, seals, signatures, and page images may not be logged.

## Engine packaging and lifecycle

PP-StructureV3, PaddleOCR models, and `img2table` are pinned by exact version and SHA-256 in the engine manifest. Required models are bundled with the installer; production conversion never downloads models at runtime. The minimal model set covers document preprocessing, Chinese/English OCR, layout, table structure, and seal recognition. Temporary images and manifests live under the existing controlled runtime directory and are removed in `finally`.

The first release target is the standard Windows 10/11 x64 package where the reported failure occurs. The separate Windows 7 and macOS packages keep their existing behavior until the exact pinned engine is staged and passes native runtime acceptance on those platforms. They must not advertise scanned structured Office conversion merely because unit tests pass elsewhere.

Model size, cold-start time, peak memory, and per-page conversion time are measured during packaging acceptance. The UI continues to report progress and cancellation; engine termination must remove the temporary workspace and cannot leave a nominal output file.

## Tests

Implementation follows RED/GREEN tests. Required coverage includes:

1. top-level `convertPdf`, not only low-level helpers, routes an image-only PDF to the structured engine;
2. a native text PDF stays on the existing fast path;
3. a mixed PDF does not silently omit scanned pages;
4. an anonymous generated A4 scan with a bordered table occupying about 32 percent of page height is detected, proving the reported geometry regression;
5. merged cells, multiline Chinese text, numbers, dates, blank cells, seals, and page rotation survive normalization;
6. zero tables, low confidence, malformed manifests, missing assets, traversal paths, timeouts, and nonzero engine exits fail with stable codes;
7. DOCX inspection proves editable paragraphs/tables plus facsimile media, and rejects a full-page-image-only file;
8. XLSX inspection proves accepted table sheets, merges, confidence notes, review highlights, and original-reference images;
9. packaged-resource tests prove all executables and model files exist and match the lock manifest;
10. logs and diagnostics contain no source content or sensitive paths.

Synthetic fixtures are generated from anonymous content and rasterized before testing. The supplied user PDF is used only for local end-to-end acceptance after automated tests pass.

## Acceptance gates

The repair is complete only when all of the following pass:

1. focused unit and integration tests;
2. the complete existing test suite;
3. packaged standard Windows engine/resource inspection;
4. real packaged-app conversion of the supplied PDF to DOCX and XLSX;
5. visual inspection of every DOCX page and workbook sheet;
6. structural inspection confirming editable Word tables/text, structured Excel cells, images, merges, and original-reference pages;
7. failure-path acceptance with a deliberately unreadable scan;
8. installer size, cold-start, memory, and conversion-time measurements recorded in the handoff;
9. `git diff --check` and an independent targeted code review.

Passing source tests alone is not runtime acceptance. A generated file, a zero exit code, or a visually faithful page image alone is not a successful editable Office conversion.

## Delivery boundary

This change repairs and validates the local application and package. GitHub push, release upload, Microsoft Store submission, certification, and public availability are separate actions and are not implied by implementation completion.
