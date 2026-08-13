const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const yazl = require("yazl");

const { DOCENGINE_PATH } = require("../config");
const { convertPdfToDocx, validateNativePdfDocx } = require("../pdf");

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

async function fixtureDocx(outputPath, text = "", {
  malformed = false, invalidXml = false, image = false, brokenImage = false
} = {}) {
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const drawing = image || brokenImage ? `<w:drawing><a:blip r:embed="rId2"/></w:drawing>` : "";
    zip.addBuffer(Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${text}</w:t>${drawing}</w:r></w:p></w:body></w:document>`), "word/document.xml");
    if (!malformed) {
      zip.addBuffer(Buffer.from(invalidXml ? "<Types><Override></Types>" : `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`), "[Content_Types].xml");
      zip.addBuffer(Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
      const imageRelationship = image || brokenImage ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${brokenImage ? "missing" : "page"}.png"/>` : "";
      zip.addBuffer(Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRelationship}</Relationships>`), "word/_rels/document.xml.rels");
      if (image) zip.addBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), "word/media/page.png");
    }
    const output = fs.createWriteStream(outputPath);
    zip.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
    zip.end();
  });
}

test("rejects a native full-page-image-only DOCX as not editable", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-image-only-docx-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "image-only.docx");
  await fixtureDocx(outputPath, "", { image: true });
  await assert.rejects(validateNativePdfDocx(outputPath), (error) => error.code === "PDF_DOCX_NO_EDITABLE_CONTENT");
});

test("rejects a malformed one-entry ZIP even when document.xml contains text", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-malformed-docx-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "malformed.docx");
  await fixtureDocx(outputPath, "Looks editable", { malformed: true });
  await assert.rejects(validateNativePdfDocx(outputPath));
});

test("rejects a DOCX with malformed essential OPC XML", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-malformed-opc-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "malformed-opc.docx");
  await fixtureDocx(outputPath, "Looks editable", { invalidXml: true });
  await assert.rejects(validateNativePdfDocx(outputPath), (error) => error.code === "PDF_OFFICE_OUTPUT_INVALID");
});

test("rejects a DOCX whose document image relationship has no media part", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-broken-media-docx-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "broken-media.docx");
  await fixtureDocx(outputPath, "Editable", { brokenImage: true });
  await assert.rejects(validateNativePdfDocx(outputPath), (error) => error.code === "PDF_OFFICE_OUTPUT_INVALID");
});

test("native image-only output is removed and falls back to structured DOCX", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-native-fallback-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.docx");
  let structured = 0;
  await convertPdfToDocx("input.pdf", outputPath, null, {
    docenginePath: "fixture-engine",
    run: async (_engine, args) => fixtureDocx(args[2]),
    convertStructuredPdf: async ({ outputPath: target }) => {
      structured += 1;
      assert.equal(fs.existsSync(target), false, "bad native output must be removed before fallback");
      await fsp.writeFile(target, "structured");
    }
  });
  assert.equal(structured, 1);
  assert.equal(await fsp.readFile(outputPath, "utf8"), "structured");
});

test("native DOCX with editable text keeps the fast path", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-native-fast-path-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.docx");
  let structured = 0;
  await convertPdfToDocx("input.pdf", outputPath, null, {
    docenginePath: "fixture-engine",
    run: async (_engine, args) => fixtureDocx(args[2], "Editable result"),
    convertStructuredPdf: async () => { structured += 1; }
  });
  assert.equal(structured, 0);
  assert.equal((await validateNativePdfDocx(outputPath)).hasEditableContent, true);
});

test("native validation and structured fallback failures preserve an existing destination", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-native-preserve-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.docx");
  await fsp.writeFile(outputPath, "KEEP");
  await assert.rejects(convertPdfToDocx("input.pdf", outputPath, null, {
    docenginePath: "fixture-engine",
    run: async (_engine, args) => fixtureDocx(args[2], "Looks editable"),
    validateNativeDocx: async () => { throw new Error("injected validation failure"); },
    convertStructuredPdf: async () => { throw new Error("structured failed"); }
  }));
  assert.equal(await fsp.readFile(outputPath, "utf8"), "KEEP");
});

test("native and structured failures leave no destination when none existed", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-native-no-output-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const outputPath = path.join(scratch, "out.docx");
  await assert.rejects(convertPdfToDocx("input.pdf", outputPath, null, {
    docenginePath: "fixture-engine",
    run: async (_engine, args) => fixtureDocx(args[2], "Looks editable", { malformed: true }),
    convertStructuredPdf: async () => { throw new Error("structured failed"); }
  }));
  assert.equal(fs.existsSync(outputPath), false);
});
