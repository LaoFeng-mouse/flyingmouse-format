# OCR Text Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline OCR-to-TXT for images and scanned/image-only PDFs without modifying source files.

**Architecture:** Use `tesseract.js` with bundled `eng` and `chi_sim` language data. Images are OCRed directly; PDFs are rendered page-by-page with bundled Poppler, OCRed per page, and joined with page separators.

**Tech Stack:** Electron, Express, Multer, Sharp, Poppler, Tesseract.js, Node test runner.

---

### Task 1: OCR Dependencies

**Files:**
- Modify: `D:\34615\飞鼠格式\package.json`
- Modify: `D:\34615\飞鼠格式\package-lock.json`

- [ ] **Step 1: Install OCR packages**

Run: `npm install tesseract.js @tesseract.js-data/eng @tesseract.js-data/chi_sim`

- [ ] **Step 2: Inspect installed file layout**

Run: `Get-ChildItem -Recurse node_modules\tesseract.js,node_modules\@tesseract.js-data -Filter *.traineddata*`

Expected: local language files exist for `eng` and `chi_sim`.

### Task 2: Failing Tests

**Files:**
- Modify: `D:\34615\飞鼠格式\tests\conversion.test.js`

- [ ] **Step 1: Add image OCR test**

Create a high-contrast generated image with text and assert converting it to `txt` returns the expected word.

- [ ] **Step 2: Add image-only PDF OCR test**

Generate an image-only PDF containing the OCR fixture image and assert converting it to `txt` returns expected text.

- [ ] **Step 3: Run tests before implementation**

Run: `npm test`

Expected: OCR tests fail because `txt` is not exposed for images or image-only PDF OCR is not implemented.

### Task 3: OCR Server Implementation

**Files:**
- Modify: `D:\34615\飞鼠格式\server.js`

- [ ] **Step 1: Add OCR path detection**

Add helpers to locate `tesseract.js-core` and local language data from `node_modules`, including packaged app paths.

- [ ] **Step 2: Add `recognizeImageText(inputPath)`**

Use `createWorker("eng+chi_sim", 1, { langPath, corePath, workerPath })`, OCR the image, trim text, and terminate the worker.

- [ ] **Step 3: Add scanned PDF OCR fallback for TXT**

If PDF text extraction returns no rows and target is `txt`, render pages to PNG and OCR them.

- [ ] **Step 4: Add image to TXT target**

Expose `txt` for images when OCR is available and route image `txt` conversion through OCR.

### Task 4: Frontend and Docs

**Files:**
- Modify: `D:\34615\飞鼠格式\public\index.html`
- Modify: `D:\34615\飞鼠格式\README.md`
- Modify: `D:\34615\飞鼠格式\AGENTS.md`

- [ ] **Step 1: Update ability copy**

Mention image/PDF OCR to TXT and keep scanned table-to-Excel limitation explicit.

- [ ] **Step 2: Update engine list**

Mention bundled Tesseract.js language data.

### Task 5: Verification and Packaging

**Files:**
- Generated outputs only

- [ ] **Step 1: Run source checks**

Run:
`node --check server.js`
`node --check public\app.js`
`node --check electron-main.js`
`node --check preload.js`
`npm test`

- [ ] **Step 2: Rebuild package**

Run `npm run dist` with mirror environment variables.

- [ ] **Step 3: Run packaged smoke tests**

Start `dist\win-unpacked\飞鼠格式.exe` and run `npm test` against `FEISHU_FORMAT_BASE_URL`.

- [ ] **Step 4: Cleanup**

Remove test scratch folders and logs. Confirm the app process is stopped.
