"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { PDFDocument } = require("pdf-lib");

const { convertOfdToPdf } = require("../ofd-convert");
const { categoryForExt, targetsForExt, extFromName } = require("../utils");
const { documentInput } = require("../config");

const scratchRoot = path.join(os.tmpdir(), `flyingmouse-ofd-tests-${process.pid}`);
const FIXTURE = path.join(__dirname, "fixtures", "sample.ofd");
const hasFixture = fs.existsSync(FIXTURE);

// E2E 需要启动真实 server；runtime 目录隔离到 scratchRoot 下
if (!process.env.FLYINGMOUSE_FORMAT_BASE_URL) {
  process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(scratchRoot, "runtime");
}
const serverModule = process.env.FLYINGMOUSE_FORMAT_BASE_URL ? null : require("../server");
let server;
let baseUrl;

before(async () => {
  await fsp.mkdir(scratchRoot, { recursive: true });
  if (serverModule) {
    const started = await serverModule.startServer(0);
    server = started.server;
    baseUrl = started.url;
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fsp.rm(scratchRoot, { recursive: true, force: true });
});

// ---------- 注册/能力 ----------

test("ofd 注册为 document 输入类别", () => {
  assert.ok(documentInput.has("ofd"));
  assert.equal(categoryForExt("ofd"), "document");
  assert.equal(extFromName("某电子发票.ofd"), "ofd");
});

test("ofd 目标格式仅限 pdf（zip 目标已于 2026-09-04 移除）", () => {
  const targets = targetsForExt("ofd", {});
  assert.ok(targets.includes("pdf"));
  assert.ok(!targets.includes("zip"), "zip 压缩目标已删除，不应再暴露");
  // 不依赖 LibreOffice，也不会暴露 LO 的 docx/odt/rtf/txt/html/md 等无效目标
  for (const forbidden of ["docx", "odt", "rtf", "txt", "html", "md", "png", "jpg"]) {
    assert.ok(!targets.includes(forbidden), `ofd 不应支持目标 ${forbidden}`);
  }
  // 即使 LO 可用也不多给目标
  const withLo = targetsForExt("ofd", { libreoffice: true });
  assert.deepEqual([...withLo].sort(), ["pdf"]);
});

// ---------- 转换模块 ----------

test("convertOfdToPdf 拒绝不存在的源文件", async () => {
  await assert.rejects(
    () => convertOfdToPdf(path.join(scratchRoot, "missing.ofd"), path.join(scratchRoot, "out.pdf")),
    /不存在/
  );
});

test("convertOfdToPdf 拒绝非 ofd 扩展名", async () => {
  const fake = path.join(scratchRoot, "fake.pdf");
  await fsp.writeFile(fake, "not an ofd at all");
  try {
    await assert.rejects(
      () => convertOfdToPdf(fake, path.join(scratchRoot, "out.pdf")),
      /\.ofd/
    );
  } finally {
    await fsp.rm(fake, { force: true });
  }
});

test("convertOfdToPdf 拒绝空文件", async () => {
  const empty = path.join(scratchRoot, "empty.ofd");
  await fsp.writeFile(empty, "");
  try {
    await assert.rejects(
      () => convertOfdToPdf(empty, path.join(scratchRoot, "out.pdf")),
      /为空/
    );
  } finally {
    await fsp.rm(empty, { force: true });
  }
});

test("损坏的 OFD（非 ZIP 容器）报友好错误", async () => {
  const bad = path.join(scratchRoot, "bad.ofd");
  await fsp.writeFile(bad, "this is definitely not a zip container");
  try {
    await assert.rejects(
      () => convertOfdToPdf(bad, path.join(scratchRoot, "out.pdf")),
      /OFD 转 PDF 失败/
    );
  } finally {
    await fsp.rm(bad, { force: true });
  }
});

// ---------- 真实转换（fixture 本地自备，不入库，缺失时跳过） ----------

test("标准 OFD fixture 转出合法 PDF", { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd（标准 OFD 测试文档，本地自备）" }, async (t) => {
  const outPath = path.join(scratchRoot, "sample.pdf");
  await convertOfdToPdf(FIXTURE, outPath);

  const buf = await fsp.readFile(outPath);
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-", "输出必须是合法 PDF");
  assert.ok(buf.length > 500, `PDF 不应为空壳，实际 ${buf.length} 字节`);

  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  assert.ok(doc.getPageCount() >= 1, "PDF 至少 1 页");
  t.diagnostic(`OFD → PDF 成功：${buf.length} 字节，${doc.getPageCount()} 页`);
});

// pdfjs 取出整份 PDF 的可提取文字（既用于内容复现比对，也用于文字层可用性校验）
async function extractPdfText(filePath) {
  const { loadPdfjs } = require("../pdfjs");
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(filePath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  let text = "";
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    text += content.items.map((item) => item.str).join("");
  }
  return text;
}

// 注意：这里不能断言两次输出「字节一致」。@miconvert/ofd-to-pdf 经 pdf-lib 写出的
// Info 字典带墙上时钟 CreationDate/ModDate（2026-08-31 实测 14:35:47 vs 14:35:49，
// 体积随日期位数差 1 字节），且被压进对象流。旧版 sha256 断言只在「两次转换恰好落在
// 同一秒」时通过，全量测试并发负载下会随机失败。改为断言内容可复现。
test("同一 fixture 转换内容可复现（时间戳除外）", { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd" }, async (t) => {
  const out1 = path.join(scratchRoot, "rep1.pdf");
  const out2 = path.join(scratchRoot, "rep2.pdf");
  await convertOfdToPdf(FIXTURE, out1);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // 故意跨秒，暴露时间戳依赖
  await convertOfdToPdf(FIXTURE, out2);

  const [buf1, buf2] = [await fsp.readFile(out1), await fsp.readFile(out2)];
  const [doc1, doc2] = [
    await PDFDocument.load(buf1, { ignoreEncryption: true, updateMetadata: false }),
    await PDFDocument.load(buf2, { ignoreEncryption: true, updateMetadata: false })
  ];
  assert.equal(doc1.getPageCount(), doc2.getPageCount(), "两次转换页数应一致");

  const [text1, text2] = [await extractPdfText(out1), await extractPdfText(out2)];
  assert.ok(text1.length > 0, "输出 PDF 应有可提取文字");
  assert.equal(text1, text2, "两次转换的可提取文字应完全一致");
  assert.ok(
    Math.abs(buf1.length - buf2.length) <= 64,
    `除时间戳外体积应基本一致，实际 ${buf1.length} vs ${buf2.length}`
  );
  t.diagnostic(`两次输出：${buf1.length} / ${buf2.length} 字节，文字 ${text1.length} 字符`);
  // 顺带留证：字节不同就是时间戳导致的，不是内容漂移
  const stamp1 = String(doc1.getCreationDate());
  const stamp2 = String(doc2.getCreationDate());
  t.diagnostic(`CreationDate：${stamp1} / ${stamp2}`);
});

// 回归：@miconvert/ofd-to-pdf 的模块级字体状态在首次 convert 后被消耗，导致同一进程
// 第 2 次起的 PDF 文字层失效（0 个汉字、约 45% 变 "?"），长驻 server / 批量转换场景下
// 除第一份外全部不可复制检索。ofd-convert.js 现在每次转换前清该包 require 缓存。
// 本用例必须连续转 3 次并逐份校验文字层，只测一次抓不到这个 bug。
test(
  "同一进程连续多次转换的文字层都可用（首转字体状态被消耗回归）",
  { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd" },
  async (t) => {
    const counts = [];
    for (let round = 1; round <= 3; round += 1) {
      const out = path.join(scratchRoot, `textlayer${round}.pdf`);
      await convertOfdToPdf(FIXTURE, out);
      const text = await extractPdfText(out);
      counts.push((text.match(/[\u4e00-\u9fff]/g) || []).length);
    }
    t.diagnostic(`三次转换的可提取汉字数：${counts.join(" / ")}`);
    for (const [index, count] of counts.entries()) {
      assert.ok(count > 100, `第 ${index + 1} 次转换文字层失效（仅提取到 ${count} 个汉字）`);
    }
    assert.equal(new Set(counts).size, 1, `每次转换的文字层应一致，实际 ${counts.join("/")}`);
  }
);

// ---------- HTTP 全链路（真实 server） ----------

async function uploadConvert(filePath, fileName, targetFormat) {
  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(filePath)], { type: "application/octet-stream" }), fileName);
  form.append("targetFormat", targetFormat);
  const response = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function downloadResult(body, fileName) {
  const res = await fetch(`${baseUrl}${body.downloadUrl}`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

test("capabilities 数据驱动带出 ofd 输入与 pdf 目标", async () => {
  const res = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(res.status, 200);
  const caps = await res.json();
  const documentGroup = caps.groups && (caps.groups.document || Object.values(caps.groups).find((g) => g.inputs && g.inputs.includes("ofd")));
  assert.ok(documentGroup, "capabilities 应包含 ofd 输入");
  assert.ok(documentGroup.inputs.includes("ofd"), "document 组应列出 ofd");
  assert.ok(documentGroup.targets.includes("pdf"), "ofd 应支持 pdf 目标");
});

test("HTTP 上传 OFD 转换 PDF 全链路", { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd" }, async () => {
  const { response, body } = await uploadConvert(FIXTURE, "sample.ofd", "pdf");
  assert.equal(response.status, 200, body.error);
  assert.equal(body.fileName, "sample.pdf");
  assert.ok(body.downloadUrl, "应返回下载地址");
  const buf = await downloadResult(body, "sample.pdf");
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-", "下载产物必须是合法 PDF");
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  assert.ok(doc.getPageCount() >= 1, "PDF 至少 1 页");
});

test("HTTP 请求 OFD→docx 被目标白名单拒绝", { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd" }, async () => {
  const { response, body } = await uploadConvert(FIXTURE, "sample.ofd", "docx");
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "TARGET_UNAVAILABLE_FOR_SOURCE");
});
