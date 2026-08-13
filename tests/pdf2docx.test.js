const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PDF2DOCX_PATH } = require("../config");
const { convertPdfToDocx } = require("../pdf");

const fixture = path.join(__dirname, "fixtures", "sample-pdf2docx.pdf");
const fixtureExists = fs.existsSync(fixture);

test("PDF→docx 优先走 pdf2docx 引擎做版式还原（fixture + 引擎保护）", { skip: !(fixtureExists && PDF2DOCX_PATH) }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fm-pdf2docx-test-"));
  const output = path.join(tmp, "out.docx");
  try {
    await convertPdfToDocx(fixture, output, null);
    assert.ok(fs.existsSync(output), "输出 docx 未生成");
    const buf = fs.readFileSync(output);
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "输出不是 zip/docx");
    // pdf2docx 版式还原特征：docx 内含 word/media 图片；文字提取的极简 docx 无图片。
    assert.match(buf.toString("latin1"), /word\/media\//, "pdf2docx 版式还原应包含图片");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pdf.js 的 PDF→docx 在引擎缺失/失败时回退到文字提取", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "pdf.js"), "utf8");
  assert.match(source, /PDF2DOCX_PATH/, "应接入 pdf2docx 引擎路径");
  assert.match(source, /extractPdfRowsByPage/, "应保留 PDF.js 文字提取回退");
  assert.match(source, /catch\s*\(error\)/, "引擎转换失败应回退");
});
