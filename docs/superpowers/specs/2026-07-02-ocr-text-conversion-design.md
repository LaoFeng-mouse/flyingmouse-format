# OCR Text Conversion Design

## Scope

Add offline OCR for image files and scanned/image-only PDFs. This phase supports OCR to `txt`; it does not claim reliable scanned table reconstruction to Excel.

## User-Facing Behavior

- Image inputs can convert to `txt` through OCR.
- PDF inputs can convert to `txt` even when the PDF has no embedded text layer; text-layer PDFs keep the existing fast text extraction path.
- Scanned/image-only PDF to `xlsx` remains blocked with a clear message that OCR-to-table reconstruction is not yet supported.
- OCR output is plain UTF-8 text with page separators for multi-page PDFs.
- Source files are read-only and must pass hash checks in tests.

## Architecture

The app uses `tesseract.js` and local language data for `eng+chi_sim`. PDF pages are rendered to PNG using the bundled Poppler runtime already added in the previous phase, then each page image is passed to OCR. OCR paths are server-side only; Electron renderer continues to use target discovery plus the existing `/api/convert` endpoint.

## Error Handling

- If OCR dependencies are missing, the target is not exposed and conversion returns a clear engine-missing error.
- If an image/PDF produces no recognized text, return a readable message instead of an empty file.
- XLSX table extraction still uses the existing text-layer parser and does not silently OCR into arbitrary table cells.

## Testing

Automated tests generate image fixtures containing high-contrast English text, image-only PDFs, and text-layer PDFs. Tests verify:

- image OCR to TXT returns expected words;
- image-only PDF OCR to TXT returns expected words;
- source file hashes do not change;
- existing PNG/PDF/TXT conversions still pass;
- packaged app runs the same test suite.
