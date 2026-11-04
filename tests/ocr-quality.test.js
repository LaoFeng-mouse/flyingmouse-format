const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const sharp = require("sharp");
const { recognizeImageResultWithWorker, recognizeImageTextWithWorker } = require("../ocr");

// Explicit opt-in keeps CI independent of locally staged Tesseract assets.
// The directory contains the original clean/5-degree/90-degree audit scan.
const samples = process.env.FLYINGMOUSE_OCR_AUDIT_SAMPLES;

async function inputFixture(t, blank = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fm-ocr-quality-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "input.png");
  // Actual image preprocessing still runs. A replay worker isolates recognition
  // decisions from model differences without bypassing the public OCR seam.
  const svg = `<svg width="2480" height="350" xmlns="http://www.w3.org/2000/svg"><rect width="2480" height="350" fill="white"/>${blank ? "" : '<text x="30" y="150" font-size="80">Invoice 474.00</text>'}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(input);
  return input;
}

function recognition(text, confidence, words = []) {
  return { data: { text, confidence, blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } };
}

test("reliable page uses one OCR pass and preserves punctuation and legacy string output", async (t) => {
  const input = await inputFixture(t);
  let calls = 0;
  const worker = { recognize: async (_path, options, output) => {
    calls++;
    assert.equal(options.rotateAuto, true);
    assert.equal(output.blocks, true);
    return recognition("  Invoice: 1,186.00\r\nRef: FM-2026-0912  ", 95);
  } };
  assert.equal(await recognizeImageTextWithWorker(worker, input), "Invoice: 1,186.00\nRef: FM-2026-0912");
  assert.equal(calls, 1);
});

test("low-confidence numeric fields are exposed even when the page average is high", async (t) => {
  const input = await inputFixture(t);
  const result = await recognizeImageResultWithWorker({ recognize: async () => recognition("Amount 474.00", 91, [
    { text: "Amount", confidence: 96 }, { text: "474.00", confidence: 66 }
  ]) }, input);
  assert.equal(result.text, "Amount 474.00");
  assert.ok(result.warnings.some(warning => warning.code === "OCR_REVIEW_RECOMMENDED"));
  assert.ok(result.warnings.every(warning => warning.messages.zhCN && warning.messages.enUS));
});

test("a small garbled heading is warned even when the remaining page has high confidence", async (t) => {
  const input = await inputFixture(t);
  const result = await recognizeImageResultWithWorker({ recognize: async () => recognition(`KIB ${"readable ".repeat(20)}`, 91, [
    { text: "KIB", confidence: 47 }, { text: "readable".repeat(20), confidence: 96 }
  ]) }, input);
  assert.ok(result.warnings.some(warning => warning.code === "OCR_REVIEW_RECOMMENDED"));
});

test("readable digital text cannot mask a severely garbled separate scan line", async t => {
  const input = await inputFixture(t);
  let calls = 0;
  await assert.rejects(recognizeImageResultWithWorker({ recognize: async () => {
    calls++;
    return { data: { text: `${'Account metadata is readable.\n'.repeat(12)}Si Dix) HH 21] Bf.`, confidence: 94,
      blocks: [{ paragraphs: [{ lines: [
        { words: [{ text: 'Account metadata is readable.'.repeat(12), confidence: 97 }] },
        { words: [{ text: 'Si', confidence: 0 }, { text: 'Dix)', confidence: 29 }, { text: 'HH', confidence: 45 }, { text: '21]', confidence: 36 }, { text: 'Bf.', confidence: 25 }] }
      ] }] }] } };
  } }, input), error => error.code === 'OCR_LOW_CONFIDENCE' && error.details.unreliableLines === 1);
  assert.equal(calls, 5);
});

test("quality refusal distinguishes an unreliable local line from whole-page confidence and retains the PDF page", async t => {
  const input = await inputFixture(t);
  for (const [data, reason, zhCN, enUS] of [
    [recognition("uncertain scan", 40), "PAGE_CONFIDENCE_LOW", /整体识别置信度不足/, /overall OCR confidence/],
    [{ data: { text: "Readable body text plus unreliable detail", confidence: 79,
      blocks: [{ paragraphs: [{ lines: [
        { words: [{ text: "Readable body text".repeat(12), confidence: 96 }] },
        { words: [{ text: "unreliable", confidence: 30 }] }
      ] }] }] } }, "UNRELIABLE_LINES", /部分文字行识别不可靠/, /Some text lines/]
  ]) {
    await assert.rejects(recognizeImageResultWithWorker({ recognize: async () => data }, input, { pageNumber: 7 }), error => {
      assert.equal(error.code, "OCR_LOW_CONFIDENCE");
      assert.equal(error.errorCode, "OCR_LOW_CONFIDENCE");
      assert.equal(error.details.reason, reason);
      assert.equal(error.details.pageNumber, 7);
      assert.match(error.messages.zhCN, /第 7 页/);
      assert.match(error.messages.enUS, /page 7/);
      assert.match(error.messages.zhCN, zhCN);
      assert.match(error.messages.enUS, enUS);
      assert.ok(!JSON.stringify(error).includes("Readable body text"));
      return true;
    });
  }
});

test("a successful layout retry ends orientation search and reports recovery", async (t) => {
  const input = await inputFixture(t);
  const modes = [];
  const result = await recognizeImageResultWithWorker({ recognize: async (_path, options) => {
    modes.push(options.tessedit_pageseg_mode);
    return modes.length === 1 ? recognition("EEE EEE I ss =", 51) : recognition("采购明细单 474.00", 90);
  } }, input);
  assert.deepEqual(modes, ["6", "3"]);
  assert.equal(result.text, "采购明细单 474.00");
  assert.ok(result.warnings.some(warning => warning.code === "OCR_LAYOUT_RECOVERED"));
});

test("garbage remains a stable error after bounded orientation retries and removes scratch files", async (t) => {
  const input = await inputFixture(t);
  let preparedDirectory;
  let calls = 0;
  const worker = { recognize: async (imagePath) => {
    calls++;
    preparedDirectory = path.dirname(imagePath);
    // Captured 90-degree audit failure: previously exported successfully at 51%.
    return recognition("EEE EEE I 可 ss = Co VNS to pics > ©", 51);
  } };
  await assert.rejects(recognizeImageResultWithWorker(worker, input), error => {
    assert.equal(error.code, "OCR_LOW_CONFIDENCE");
    assert.equal(error.errorCode, "OCR_LOW_CONFIDENCE");
    assert.equal(error.details.confidence, 51);
    return Boolean(error.messages.zhCN && error.messages.enUS);
  });
  assert.equal(calls, 5);
  await assert.rejects(fs.stat(preparedDirectory), { code: "ENOENT" });
});

test("blank PDF page image returns an empty result without rotation or false quality failure", async (t) => {
  const input = await inputFixture(t, true);
  let calls = 0;
  const result = await recognizeImageResultWithWorker({ recognize: async () => {
    calls++;
    return recognition("", 0);
  } }, input);
  assert.equal(result.text, "");
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls, 2);
});

test("worker recognition failure preserves the cause and cleans its image scratch directory", async (t) => {
  const input = await inputFixture(t);
  let preparedDirectory;
  const failure = new Error("recognizer failed");
  await assert.rejects(recognizeImageResultWithWorker({ recognize: async (imagePath) => {
    preparedDirectory = path.dirname(imagePath);
    throw failure;
  } }, input), error => error === failure);
  await assert.rejects(fs.stat(preparedDirectory), { code: "ENOENT" });
});

test("actual OCR preserves purchase title and monetary decimals after skew/rotation", {
  skip: !samples,
  timeout: 120000
}, async (t) => {
  const { createOcrWorker, recognizeImageTextWithWorker } = require("../ocr");
  const worker = await createOcrWorker();
  try {
    for (const name of ["chinese-clean.png", "chinese-skew.png", "chinese-rotated.png"]) {
      await t.test(name, async () => {
        const text = await recognizeImageTextWithWorker(worker, path.join(samples, name));
        const compact = text.replace(/\s/g, "");
        assert.match(compact, /采购明细单/, text);
        assert.match(compact, /474\.00/, text);
        assert.match(compact, /712\.00/, text);
        assert.match(compact, /1186\.00/, text);
        assert.match(compact, /13800138000/, text);
      });
    }
    for (const angle of [180, 270]) {
      await t.test(`original scan additionally rotated ${angle} degrees`, async (t) => {
        const input = await inputFixture(t);
        await sharp(path.join(samples, "chinese-clean.png")).rotate(angle).png().toFile(input);
        const result = await recognizeImageResultWithWorker(worker, input);
        assert.match(result.text.replace(/\s/g, ""), /采购明细单/);
        assert.match(result.text.replace(/\s/g, ""), /474\.00/);
        assert.match(result.text.replace(/\s/g, ""), /1186\.00/);
      });
    }
  } finally {
    await worker.terminate();
  }
});

async function twoPageImageFixture(t, format) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fm-multipage-ocr-"));
  t.after(async () => {
    // libvips caches GIF loader operations; release their Windows file handles
    // before removing this test's own generated fixture (same as image tests).
    sharp.cache(false);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const frames = [];
  for (const text of ["FIRST PAGE INVOICE 100.00", "SECOND PAGE TOTAL 200.00"]) {
    const svg = `<svg width="2480" height="350" xmlns="http://www.w3.org/2000/svg"><rect width="2480" height="350" fill="white"/><text x="80" y="180" font-family="Arial" font-size="110">${text}</text></svg>`;
    frames.push(await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer());
  }
  const input = path.join(directory, `input.${format}`);
  await sharp(Buffer.concat(frames), { raw: { width: 2480, height: 700, pageHeight: 350, channels: 3 } })
    .toFormat(format).toFile(input);
  assert.equal((await sharp(input, { animated: true }).metadata()).pages, 2);
  return { directory, input };
}

test("actual multipage TIFF OCR retains both pages in TXT, DOCX and Markdown", { skip: !samples, timeout: 60000 }, async t => {
  const { directory, input } = await twoPageImageFixture(t, "tiff");
  const { convertImage } = require("../image");
  const mammoth = require("mammoth");
  for (const target of ["txt", "docx", "md"]) {
    const output = path.join(directory, `result.${target}`);
    const result = await convertImage(input, output, target);
    const text = target === "docx" ? (await mammoth.extractRawText({ path: output })).value : await fs.readFile(output, "utf8");
    assert.match(text, /FIRST PAGE INVOICE 100\.00/);
    assert.match(text, /SECOND PAGE TOTAL 200\.00/);
    assert.ok(text.indexOf("100.00") < text.indexOf("200.00"));
    assert.match(text, /Page 1/);
    assert.match(text, /Page 2/);
    assert.ok(result.warnings.some(warning => warning.code === "OCR_MULTIPAGE_DOCUMENT"));
  }
});

test("actual animated GIF OCR reports first-frame extraction instead of treating frames as document pages", { skip: !samples, timeout: 30000 }, async t => {
  const { input } = await twoPageImageFixture(t, "gif");
  const { recognizeImageResult } = require("../ocr");
  const result = await recognizeImageResult(input);
  assert.match(result.text, /FIRST PAGE INVOICE 100\.00/);
  assert.doesNotMatch(result.text, /SECOND PAGE/);
  assert.ok(result.warnings.some(warning => warning.code === "ANIMATION_FLATTENED"));
  assert.ok(!result.warnings.some(warning => warning.code === "OCR_MULTIPAGE_DOCUMENT"));
});
