const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const yazl = require("yazl");

const {
  readDocxEntryString,
  docxNeedsPdfRepair
} = require("../office-convert");

function buildDocx(parts) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`), "[Content_Types].xml");
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
    zip.addBuffer(Buffer.from(parts.documentXml), "word/document.xml");
    const output = fs.createWriteStream(parts.filePath);
    const stream = zip.outputStream.pipe(output);
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

function normalDocumentXml(text) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
}

function wpsStyleDocumentXml() {
  const oMaths = Array.from({ length: 8 }, (_, i) =>
    `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x_${i}</m:t></m:r></m:oMath>`
  ).join("");
  const fields = Array.from({ length: 8 }, (_, i) =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF 表${i} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${i}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:wpsCustomData="http://www.wps.cn/officeDocument/2013/wpsCustomData"><w:body>${oMaths}${fields}</w:body></w:document>`;
}

test("readDocxEntryString reads word/document.xml from a docx package", async (t) => {
  const filePath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "fm-wps-repair-")), "sample.docx");
  t.after(() => fsp.rm(path.dirname(filePath), { recursive: true, force: true }));
  await buildDocx({ filePath, documentXml: normalDocumentXml("hello 飞鼠") });
  const xml = await readDocxEntryString(filePath, "word/document.xml");
  assert.ok(xml.includes("hello 飞鼠"));
});

test("readDocxEntryString resolves null for missing entry or non-zip input", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-wps-repair-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "sample.docx");
  await buildDocx({ filePath, documentXml: normalDocumentXml("x") });
  assert.equal(await readDocxEntryString(filePath, "word/missing.xml"), null);
  const notZip = path.join(dir, "plain.txt");
  await fsp.writeFile(notZip, "not a zip");
  assert.equal(await readDocxEntryString(notZip, "word/document.xml"), null);
});

test("docxNeedsPdfRepair flags WPS documents with formulas and cross-reference fields", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-wps-repair-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const wpsPath = path.join(dir, "wps.docx");
  await buildDocx({ filePath: wpsPath, documentXml: wpsStyleDocumentXml() });
  assert.equal(await docxNeedsPdfRepair(wpsPath), true);

  const normalPath = path.join(dir, "normal.docx");
  await buildDocx({ filePath: normalPath, documentXml: normalDocumentXml("普通文档") });
  assert.equal(await docxNeedsPdfRepair(normalPath), false);
});

test("docxNeedsPdfRepair is defensive on unreadable or missing files", async () => {
  assert.equal(await docxNeedsPdfRepair("C:/no/such/file.docx"), false);
});
