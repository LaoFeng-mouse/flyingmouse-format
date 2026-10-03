"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { test, before, after } = require("node:test");
const { PDFDocument, rgb } = require("pdf-lib");
const { convertOfdToPdf, verifyOfdPdf } = require("../ofd-convert");

let root;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-ofd-visible-")); });
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const fixture = name => path.join(__dirname, "fixtures", "ofd", name + ".ofd");

test("OFD output rejects a visually blank page even if extractable text exists", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawText("Text hidden behind a white background", { x: 10, y: 100, size: 10 });
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(1, 1, 1) });
  const output = path.join(root, "hidden.pdf");
  await fs.writeFile(output, await pdf.save());
  assert.equal(typeof verifyOfdPdf, "function");
  await assert.rejects(verifyOfdPdf(output, { pageCount: 1, pages: [{ hasContent: true, expectsVisibleContent: true }] }),
    { code: "OFD_OUTPUT_BLANK" });
});

test("OFD output preserves a declared original blank page and rejects lost pages", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const output = path.join(root, "original-blank.pdf"); await fs.writeFile(output, await pdf.save());
  const evidence = await verifyOfdPdf(output, { pageCount: 1, pages: [{ hasContent: false, expectsVisibleContent: false }] });
  assert.equal(evidence.pages[0].visible, false);
  await assert.rejects(verifyOfdPdf(output, { pageCount: 2, pages: [{}, {}] }), { code: "OFD_PAGE_COUNT_MISMATCH" });
});

test("a visible first page cannot hide a later blank page through raster file caching", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText("First page is visible", { x: 15, y: 150, size: 12 });
  pdf.addPage([300, 300]);
  const output = path.join(root, "visible-then-blank.pdf"); await fs.writeFile(output, await pdf.save());
  await assert.rejects(verifyOfdPdf(output, { pageCount: 2, pages: [
    { hasContent: true, expectsVisibleContent: true }, { hasContent: true, expectsVisibleContent: true }
  ] }), error => error.code === "OFD_OUTPUT_BLANK" && error.details.page === 2);
});

test("OFD missing resources and pages do not publish partial or blank PDFs", async () => {
  for (const [name, code] of [["blank-image-declared-but-missing", "OFD_MISSING_RESOURCE"], ["missing-only-page-xml", "OFD_MISSING_PAGE"]]) {
    const output = path.join(root, name + ".pdf");
    await assert.rejects(convertOfdToPdf(fixture(name), output), error => /^OFD_/.test(error.code), code);
    await assert.rejects(fs.stat(output), { code: "ENOENT" });
  }
});

test("OFD repaired image paths, namespace prefixes and object order pass real output validation", async () => {
  for (const name of ["control-image-flat-path", "control-text", "control-background-separate-layer", "blank-image-resource-baseloc", "blank-page-different-namespace-prefix", "blank-text-hidden-by-reordered-background"]) {
    const output = path.join(root, name + ".pdf");
    await convertOfdToPdf(fixture(name), output);
    const result = await verifyOfdPdf(output, { pageCount: 1, pages: [{ hasContent: true, expectsVisibleContent: true }] });
    assert.equal(result.pages[0].visible, true, name);
  }
});

test("OFD cancellation prevents output publication", async () => {
  const output = path.join(root, "canceled.pdf"), controller = new AbortController(); controller.abort();
  await assert.rejects(convertOfdToPdf(fixture("control-text"), output, undefined, { signal: controller.signal }),
    { code: "CONVERSION_CANCELED" });
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
});
