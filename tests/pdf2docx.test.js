const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DOCENGINE_PATH } = require("../config");
const { convertPdfToDocx } = require("../pdf");

const fixture = path.join(__dirname, "fixtures", "sample-pdf2docx.pdf");
const fixtureExists = fs.existsSync(fixture);

test("PDF→docx 优先走 pdf2docx 引擎做版式还原（fixture + 引擎保护）", { skip: !(fixtureExists && DOCENGINE_PATH) }, async () => {
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
  assert.match(source, /DOCENGINE_PATH/, "应接入 pdf2docx 引擎路径");
  assert.match(source, /extractPdfRowsByPage/, "应保留 PDF.js 文字提取回退");
  assert.match(source, /catch\s*\(error\)/, "引擎转换失败应回退");
});

test("docxHasRunTogetherText 识别单词粘连并区分正常文档", async () => {
  const { docxHasRunTogetherText } = require("../pdf");
  const { convertTextToDocx } = require("../text-docx");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fm-run-together-test-"));

  // 粘连文本：模拟 pdf2docx 丢空格后的英文（平均"单词"长度远超正常）
  const runTogether = [
    "SectorRotationbyFactorModelandFundamentalAnalysis",
    "Thisstudypresentsananalyticalapproachtosectorrotationleveragingbothfactormodelsandfundamental",
    "metricsthroughfactoranalysisthepaperunderscoresthesignificanceofmomentum"
  ].join("\n");
  const runTogetherPath = path.join(tmp, "run-together.docx");
  await convertTextToDocx(runTogether, "txt", runTogetherPath);
  assert.equal(await docxHasRunTogetherText(runTogetherPath), true, "粘连文本应被识别");

  // 正常文本：单词正常分隔
  const normal = [
    "This study presents an analytical approach to sector rotation.",
    "The paper underscores the significance of momentum and short-term reversion."
  ].join("\n");
  const normalPath = path.join(tmp, "normal.docx");
  await convertTextToDocx(normal, "txt", normalPath);
  assert.equal(await docxHasRunTogetherText(normalPath), false, "正常文本不应误判为粘连");

  fs.rmSync(tmp, { recursive: true, force: true });
});
