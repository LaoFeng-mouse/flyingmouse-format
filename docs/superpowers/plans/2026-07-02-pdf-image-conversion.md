# PDF Image Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable offline image-to-PDF, multi-image-to-PDF, and PDF-to-image conversion without changing source files.

**Architecture:** Keep the existing Express conversion service and add focused helpers in `server.js`. Image-to-PDF uses Sharp plus a small PDF writer; PDF-to-image uses bundled Poppler `pdftoppm` and returns page images in a zip. The renderer uses a new batch endpoint only when several images are merged into one PDF.

**Tech Stack:** Electron, Express, Multer, Sharp, pdfjs-dist, yazl, Poppler `pdftoppm`, Node built-in test runner.

---

### Task 1: Tests and Baseline

**Files:**
- Create: `D:\34615\飞鼠格式\tests\conversion.test.js`
- Modify: `D:\34615\飞鼠格式\package.json`

- [ ] **Step 1: Add API tests**

Create Node tests that start `server.js`, upload generated fixture files, download results, assert formats, and compare source file hashes before and after conversion.

- [ ] **Step 2: Run tests before implementation**

Run: `npm test`

Expected: image-to-PDF, multi-image-to-PDF, and PDF-to-image tests fail because the targets and endpoint do not exist yet. Existing text and image conversion checks should still pass.

### Task 2: Server Conversion Helpers

**Files:**
- Modify: `D:\34615\飞鼠格式\server.js`

- [ ] **Step 1: Add Poppler path detection**

Add `bundledPdftoppmPath()` and include Poppler in `getTools()`.

- [ ] **Step 2: Add image PDF writer**

Add `convertImagesToPdf(imageFiles, outputPath)` that reads images through Sharp, applies rotation, flattens alpha to white, and embeds each raster image as one full-page PDF page.

- [ ] **Step 3: Add PDF page renderer**

Add `convertPdfPagesToImagesZip(inputPath, outputPath, target)` using `pdftoppm -png` or `pdftoppm -jpeg`, then zip each rendered page.

- [ ] **Step 4: Wire target output extension**

Make PDF-to-PNG/JPG output a `.zip` download named like `source.png.zip` or `source.jpg.zip`.

### Task 3: API and Frontend Wiring

**Files:**
- Modify: `D:\34615\飞鼠格式\server.js`
- Modify: `D:\34615\飞鼠格式\public\app.js`
- Modify: `D:\34615\飞鼠格式\public\index.html`

- [ ] **Step 1: Extend target matrices**

Add `pdf` to image targets and `png/jpg` to PDF targets. Only expose PDF page image targets when Poppler is available.

- [ ] **Step 2: Add batch image PDF endpoint**

Add `POST /api/convert-images-to-pdf` with `files[]`, validate all inputs are images, produce one PDF, and delete uploaded temp files.

- [ ] **Step 3: Add frontend merge path**

When several selected files are all images and the target is `pdf`, call `/api/convert-images-to-pdf` once and expose a single save button for the combined PDF.

- [ ] **Step 4: Update user-facing PDF note**

State that scan/OCR is still separate, while PDF page image export is supported.

### Task 4: Package Poppler and Verify

**Files:**
- Modify: `D:\34615\飞鼠格式\package.json`
- Create or update: `D:\34615\飞鼠格式\bin\poppler`

- [ ] **Step 1: Copy Poppler runtime**

Copy the local Poppler runtime into `bin\poppler` so the packaged app does not depend on Codex PATH.

- [ ] **Step 2: Include Poppler in electron-builder**

Add `bin/poppler` to `extraResources`.

- [ ] **Step 3: Run syntax and functional tests**

Run:
`node --check server.js`
`node --check public\app.js`
`node --check electron-main.js`
`node --check preload.js`
`npm test`

- [ ] **Step 4: Build package and test packaged runtime**

Run `npm run dist`, then run the packaged app server path or app runtime and repeat the conversion smoke tests against bundled resources.

### Task 5: Cleanup and Closeout

**Files:**
- Runtime temp folders only

- [ ] **Step 1: Delete generated test inputs and outputs**

Remove test scratch directories under system temp and project test temp.

- [ ] **Step 2: Confirm source files were not modified by conversions**

Report source hash checks from the tests.

- [ ] **Step 3: Final status**

Report changed files, verification commands, packaged app path, remaining OCR limitation, and backup path.
