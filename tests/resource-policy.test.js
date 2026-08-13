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

test("resource limits are all disabled (no upper bound)", () => {
  assert.equal(LIMITS.maxImagePixels, Number.MAX_SAFE_INTEGER);
  assert.equal(LIMITS.maxImageDimension, Number.MAX_SAFE_INTEGER);
  assert.equal(LIMITS.maxImagePdfPixels, Number.MAX_SAFE_INTEGER);
  assert.equal(LIMITS.maxBatchBytes, Number.MAX_SAFE_INTEGER);
});

test("decoded image pixels include every animation frame", () => {
  assert.equal(imageDecodedPixels({ width: 4000, height: 3000 }), 12_000_000);
  assert.equal(imageDecodedPixels({ width: 1000, height: 6000, pageHeight: 1000, pages: 6 }), 6_000_000);
});

test("image metadata accepts any pixel count and dimension (no upper bound)", () => {
  assert.equal(assertImageMetadata({ width: 10_000, height: 5000 }), 50_000_000);
  // 大图 / 超大单边不再被拒绝（工程图纸等 1:1 还原）
  assert.equal(assertImageMetadata({ width: 100_000, height: 100_000 }), 10_000_000_000);
  assert.equal(assertImageMetadata({ width: 16_385, height: 10 }), 163_850);
});

test("image-to-PDF decoded budget is no longer capped", () => {
  const big = { width: 8000, height: 5000 };
  assert.equal(assertImagePdfBudget([big, big, big]), 120_000_000);
});

test("batch byte budget is no longer capped; PDF pages are not limited (1:1 conversion)", () => {
  // 大文件 / 大批量不再被拒绝
  assert.equal(assertBatchBytes([{ size: 3 * 1024 * 1024 * 1024 }]), 3 * 1024 * 1024 * 1024);
  assert.equal(assertBatchBytes([{ size: Number.MAX_SAFE_INTEGER }]), Number.MAX_SAFE_INTEGER);
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
