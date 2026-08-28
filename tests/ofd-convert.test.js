"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
let sessionToken;

function apiFetch(apiPath, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Mahiro-Session-Token", sessionToken);
  return fetch(`${baseUrl}${apiPath}`, { ...options, headers });
}

before(async () => {
  await fsp.mkdir(scratchRoot, { recursive: true });
  if (serverModule) {
    const started = await serverModule.startServer(0);
    server = started.server;
    baseUrl = started.url;
    sessionToken = started.sessionToken;
  }
  if (!sessionToken && baseUrl) {
    const response = await fetch(`${baseUrl}/api/session`, { cache: "no-store" });
    assert.equal(response.status, 200);
    sessionToken = (await response.json()).token;
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

test("ofd 目标格式仅限 pdf（+通用 zip）", () => {
  const targets = targetsForExt("ofd", {});
  assert.ok(targets.includes("pdf"));
  assert.ok(targets.includes("zip"));
  // 不依赖 LibreOffice，也不会暴露 LO 的 docx/odt/rtf/txt/html/md 等无效目标
  for (const forbidden of ["docx", "odt", "rtf", "txt", "html", "md", "png", "jpg"]) {
    assert.ok(!targets.includes(forbidden), `ofd 不应支持目标 ${forbidden}`);
  }
  // 即使 LO 可用也不多给目标
  const withLo = targetsForExt("ofd", { libreoffice: true });
  assert.deepEqual([...withLo].sort(), ["pdf", "zip"]);
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

test("同一 fixture 转换可复现（确定性）", { skip: hasFixture ? false : "缺少 tests/fixtures/sample.ofd" }, async () => {
  const out1 = path.join(scratchRoot, "rep1.pdf");
  const out2 = path.join(scratchRoot, "rep2.pdf");
  await convertOfdToPdf(FIXTURE, out1);
  await convertOfdToPdf(FIXTURE, out2);
  const h1 = crypto.createHash("sha256").update(await fsp.readFile(out1)).digest("hex");
  const h2 = crypto.createHash("sha256").update(await fsp.readFile(out2)).digest("hex");
  assert.equal(h1, h2, "相同输入两次转换结果应一致");
});

// ---------- HTTP 全链路（真实 server） ----------

async function uploadConvert(filePath, fileName, targetFormat) {
  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(filePath)], { type: "application/octet-stream" }), fileName);
  form.append("targetFormat", targetFormat);
  const response = await apiFetch("/api/convert", { method: "POST", body: form });
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
