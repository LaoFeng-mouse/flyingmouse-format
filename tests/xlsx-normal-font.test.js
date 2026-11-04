"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const ExcelJS = require("exceljs");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { rewriteXlsxNormalFont } = require("../xlsx-normal-font");

function readEntries(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, archive) => {
    if (error) return reject(error);
    const entries = [];
    archive.on("error", reject);
    archive.on("end", () => resolve(entries));
    archive.on("entry", entry => archive.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("error", reject);
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { entries.push({ name: entry.fileName, data: Buffer.concat(chunks) }); archive.readEntry(); });
    }));
    archive.readEntry();
  }));
}
function zipEntries(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      if (entry.name.endsWith("/")) zip.addEmptyDirectory(entry.name);
      else zip.addBuffer(entry.data, entry.name);
    }
    zip.end();
  });
}
async function generated() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Source");
  sheet.getCell("A1").value = "中文正文";
  sheet.getCell("A1").font = { name: "仿宋", size: 12, bold: false };
  sheet.getCell("B1").value = 123.5;
  sheet.getCell("B1").font = { name: "Arial", size: 9, italic: true, scheme: "major" };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function fontTable(xml) { return xml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)[1].match(/<font>[\s\S]*?<\/font>/g); }
async function mutateStyles(buffer, edit) {
  const entries = await readEntries(buffer);
  const styles = entries.find(entry => entry.name === "xl/styles.xml");
  styles.data = Buffer.from(edit(styles.data.toString("utf8")));
  return zipEntries(entries);
}

// Native A4 printing selected 仿宋12: six-point digit width without the
// vertical compression observed with Courier New10. Cell source fonts stay intact.
test("pins only ExcelJS font0 to explicit FangSong12 and preserves every other member byte-for-byte", async () => {
  const original = await generated();
  const originalCopy = Buffer.from(original);
  const before = await readEntries(original);
  const stylesBefore = before.find(entry => entry.name === "xl/styles.xml").data.toString("utf8");
  assert.match(fontTable(stylesBefore)[0], /<scheme val="minor"\/>/);
  const result = await rewriteXlsxNormalFont(original);
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(original, originalCopy);
  const after = await readEntries(result);
  assert.deepEqual(after.map(entry => entry.name), before.map(entry => entry.name));
  for (const entry of before) {
    if (entry.name !== "xl/styles.xml") assert.deepEqual(after.find(other => other.name === entry.name).data, entry.data, entry.name);
  }
  const stylesAfter = after.find(entry => entry.name === "xl/styles.xml").data.toString("utf8");
  const [normal, ...otherFonts] = fontTable(stylesAfter);
  assert.match(normal, /<name val="仿宋"\/>/);
  assert.match(normal, /<sz val="12"\/>/);
  assert.doesNotMatch(normal, /<scheme\b/);
  assert.deepEqual(otherFonts, fontTable(stylesBefore).slice(1));
  assert.equal(stylesAfter, stylesBefore.replace(fontTable(stylesBefore)[0], normal));
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(result);
  assert.equal(reloaded.worksheets[0].getCell("A1").value, "中文正文");
  assert.equal(reloaded.worksheets[0].getCell("A1").font.name, "仿宋");
  assert.equal(reloaded.worksheets[0].getCell("B1").font.scheme, "major");
});

test("normalizes a replaced font0 name and size without replacing its color or family", async () => {
  const original = await mutateStyles(await generated(), xml => {
    const first = fontTable(xml)[0];
    return xml.replace(first, first.replace('name val="Calibri"', 'name val="宋体"').replace('sz val="11"', 'sz val="13"'));
  });
  const result = await readEntries(await rewriteXlsxNormalFont(original));
  const normal = fontTable(result.find(entry => entry.name === "xl/styles.xml").data.toString())[0];
  assert.match(normal, /<name val="仿宋"\/>/);
  assert.match(normal, /<sz val="12"\/>/);
  assert.match(normal, /<family val="2"\/>/);
  assert.match(normal, /<color theme="1"\/>/);
  assert.doesNotMatch(normal, /<scheme\b/);
});

test("preserves arbitrary binary members and is byte-idempotent once font0 is normalized", async () => {
  const entries = await readEntries(await generated());
  entries.push({ name: "xl/media/probe.bin", data: Buffer.from([0, 255, 1, 128, 4, 0, 12]) });
  const once = await rewriteXlsxNormalFont(await zipEntries(entries));
  const twice = await rewriteXlsxNormalFont(once);
  assert.deepEqual(twice, once);
  assert.deepEqual((await readEntries(once)).find(entry => entry.name === "xl/media/probe.bin").data, entries.at(-1).data);
});

test("rejects non-buffers, malformed archives and a non-XLSX ZIP", async () => {
  for (const value of [undefined, null, "xlsx", new Uint8Array([1]), Buffer.from("broken zip"), Buffer.alloc(0)]) {
    await assert.rejects(rewriteXlsxNormalFont(value));
  }
  await assert.rejects(rewriteXlsxNormalFont(await zipEntries([{ name: "readme.txt", data: Buffer.from("not a workbook") }])));
});

test("rejects missing or duplicate styles parts and ambiguous or malformed font0 XML", async () => {
  const original = await generated();
  const entries = await readEntries(original);
  const styles = entries.find(entry => entry.name === "xl/styles.xml");
  await assert.rejects(rewriteXlsxNormalFont(await zipEntries(entries.filter(entry => entry !== styles))));
  await assert.rejects(rewriteXlsxNormalFont(await zipEntries([...entries, styles])));
  for (const edit of [
    xml => xml.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/, '<fonts count="0"/>'),
    xml => xml.replace(/<font>/, '<font><name val="duplicate"/>'),
    xml => xml.replace(/<\/font>/, ""),
    xml => '<!DOCTYPE styleSheet [<!ENTITY x "bad">]>' + xml,
    xml => xml.replace(/<fonts count="\d+"/, '<fonts count="999"')
  ]) await assert.rejects(rewriteXlsxNormalFont(await mutateStyles(original, edit)));
});

test("rejects an archive whose central CRC disagrees with an otherwise readable member", async () => {
  const corrupted = Buffer.from(await generated());
  let changed = false;
  for (let offset = 0; offset < corrupted.length - 46; offset += 1) {
    if (corrupted.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = corrupted.readUInt16LE(offset + 28);
    if (corrupted.subarray(offset + 46, offset + 46 + length).toString() !== "xl/workbook.xml") continue;
    corrupted[offset + 16] ^= 1;
    changed = true;
    break;
  }
  assert.equal(changed, true);
  await assert.rejects(rewriteXlsxNormalFont(corrupted), /checksum/);
});
