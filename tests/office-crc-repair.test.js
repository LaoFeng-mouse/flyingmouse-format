const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const yazl = require("yazl");

const {
  findCrcBrokenZipEntries,
  repairZipCrcIfNeeded
} = require("../office-convert");

function buildDocx(parts) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`), "[Content_Types].xml");
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), "_rels/.rels");
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>飞鼠</w:t></w:r></w:p></w:body></w:document>`), "word/document.xml");
    // media 用 store（不压缩）模拟微信/生成工具的行为
    const mediaBytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251));
    zip.addBuffer(mediaBytes, "word/media/image1.png", { compress: false });
    const output = fs.createWriteStream(parts.filePath);
    const stream = zip.outputStream.pipe(output);
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

// 把 central directory 里指定 entry 的 CRC 字段改写成 0，模拟损坏
function patchCrcToZero(filePath, targetName) {
  const buf = fs.readFileSync(filePath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "找不到 EOCD");
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (name === targetName) {
      buf.writeUInt32LE(0, off + 16); // CRC 字段写 0
      fs.writeFileSync(filePath, buf);
      return;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  assert.fail(`找不到 entry: ${targetName}`);
}

test("findCrcBrokenZipEntries detects zero-CRC media entries", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-crc-repair-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "broken.docx");
  await buildDocx({ filePath });
  patchCrcToZero(filePath, "word/media/image1.png");

  const buf = fs.readFileSync(filePath);
  const entries = findCrcBrokenZipEntries(buf);
  assert.ok(entries, "应能解析 central directory");
  const broken = entries.filter((e) => e.crc === 0 && e.compSize > 0);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].name, "word/media/image1.png");
});

test("repairZipCrcIfNeeded rewrites a zip with zero-CRC entries", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-crc-repair-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "broken.docx");
  await buildDocx({ filePath });
  patchCrcToZero(filePath, "word/media/image1.png");

  const repaired = await repairZipCrcIfNeeded(filePath, dir, "docx");
  assert.ok(repaired, "应返回修复文件路径");
  const fixedBuf = fs.readFileSync(repaired);
  const fixedEntries = findCrcBrokenZipEntries(fixedBuf);
  const stillBroken = fixedEntries.filter((e) => e.crc === 0 && e.compSize > 0);
  assert.equal(stillBroken.length, 0, "修复后不应再有 CRC=0 的 entry");

  // 修复后的 docx 仍应能被正常解析出 document.xml
  const { readDocxEntryString } = require("../office-convert");
  const xml = await readDocxEntryString(repaired, "word/document.xml");
  assert.ok(xml && xml.includes("飞鼠"));
});

test("repairZipCrcIfNeeded returns null for clean zip and non-zip input", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-crc-repair-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // 干净 zip（无 CRC 损坏）→ null
  const cleanPath = path.join(dir, "clean.docx");
  await buildDocx({ filePath: cleanPath });
  assert.equal(await repairZipCrcIfNeeded(cleanPath, dir, "docx"), null);

  // 非 zip → null
  const txtPath = path.join(dir, "plain.txt");
  await fsp.writeFile(txtPath, "not a zip at all");
  assert.equal(await repairZipCrcIfNeeded(txtPath, dir, "txt"), null);

  // 不存在 → null
  assert.equal(await repairZipCrcIfNeeded(path.join(dir, "missing.docx"), dir, "docx"), null);
});
