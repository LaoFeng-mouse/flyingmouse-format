const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  LIMITS,
  ResourceLimitError,
  imageDecodedPixels,
  assertImageMetadata,
  assertImagePdfBudget,
  assertBatchBytes,
  assertPdfPages
} = require("../resource-policy");

test("resource limits expose the agreed cross-platform budgets", () => {
  assert.deepEqual(LIMITS, {
    maxImagePixels: 50_000_000,
    maxImageDimension: 16_384,
    maxImagePdfPixels: 100_000_000,
    maxBatchBytes: 2 * 1024 * 1024 * 1024
  });
});

test("decoded image pixels include every animation frame", () => {
  assert.equal(imageDecodedPixels({ width: 4000, height: 3000 }), 12_000_000);
  assert.equal(imageDecodedPixels({ width: 1000, height: 6000, pageHeight: 1000, pages: 6 }), 6_000_000);
});

test("image metadata accepts the boundary and rejects excessive pixels or dimensions", () => {
  assert.equal(assertImageMetadata({ width: 10_000, height: 5000 }), 50_000_000);

  assert.throws(
    () => assertImageMetadata({ width: 10_001, height: 5000 }),
    (error) => error instanceof ResourceLimitError
      && error.errorCode === "IMAGE_PIXELS_EXCEEDED"
      && Boolean(error.messages?.zhCN)
      && Boolean(error.messages?.enUS)
  );
  assert.throws(
    () => assertImageMetadata({ width: 16_385, height: 10 }),
    (error) => error instanceof ResourceLimitError && error.errorCode === "IMAGE_DIMENSION_EXCEEDED"
  );
});

test("image-to-PDF decoded budget is enforced before raw conversion", () => {
  assert.equal(assertImagePdfBudget([
    { width: 10_000, height: 5000 },
    { width: 10_000, height: 5000 }
  ]), 100_000_000);
  assert.throws(
    () => assertImagePdfBudget([
      { width: 8000, height: 5000 },
      { width: 8000, height: 5000 },
      { width: 8000, height: 5000 }
    ]),
    (error) => error instanceof ResourceLimitError && error.errorCode === "IMAGE_PDF_BUDGET_EXCEEDED"
  );
});

test("batch byte budget is enforced; PDF pages are not limited (1:1 conversion)", () => {
  assert.equal(assertBatchBytes([{ size: 1024 }, { size: LIMITS.maxBatchBytes - 1024 }]), LIMITS.maxBatchBytes);
  assert.throws(
    () => assertBatchBytes([{ size: LIMITS.maxBatchBytes }, { size: 1 }]),
    (error) => error instanceof ResourceLimitError && error.errorCode === "BATCH_BYTES_EXCEEDED"
  );
  // PDF 页数不做上限：任意正整数页数（含超长文档）都应通过
  assert.equal(assertPdfPages(1500), 1500);
  assert.equal(assertPdfPages(10000), 10000);
  assert.equal(assertPdfPages(100, { ocr: true }), 100);
  assert.equal(assertPdfPages(5000, { ocr: true }), 5000);
});

test("malformed image, batch and page metadata fail closed", () => {
  assert.throws(
    () => assertImageMetadata({ width: "100", height: 100 }),
    (error) => error instanceof ResourceLimitError && error.errorCode === "IMAGE_METADATA_INVALID"
  );
  assert.throws(
    () => assertImageMetadata({ width: 10_000, height: 50_000, pageHeight: 1000, pages: 6 }),
    (error) => error instanceof ResourceLimitError && error.errorCode === "IMAGE_METADATA_INVALID"
  );
  assert.throws(
    () => assertBatchBytes([{ size: "2048" }]),
    (error) => error instanceof ResourceLimitError && error.errorCode === "BATCH_FILE_SIZE_INVALID"
  );
  assert.throws(
    () => assertBatchBytes([{ size: -1 }]),
    (error) => error instanceof ResourceLimitError && error.errorCode === "BATCH_FILE_SIZE_INVALID"
  );
  assert.throws(
    () => assertPdfPages(0),
    (error) => error instanceof ResourceLimitError && error.errorCode === "PDF_PAGE_COUNT_INVALID"
  );
});
