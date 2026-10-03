"use strict";

const yauzl = require("yauzl");
const yazl = require("yazl");

// This helper consumes our ExcelJS output, never an uploaded workbook. Match
// that serializer's small, unprefixed font vocabulary rather than rewriting
// arbitrary OOXML. FangSong 12 supplies a six-point character-width basis;
// actual PDF text keeps its separately assigned source fonts. The physical
// in-memory ceiling matches native DOCX checks.
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (!name || name.includes("\\") || name.startsWith("/") || name.includes(":")) return false;
  return name.replace(/\/$/, "").split("/").every(piece => piece && piece !== "." && piece !== "..");
}

function readEntries(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, archive) => {
    if (error) return reject(error);
    const entries = [], names = new Set();
    let settled = false, total = 0, activeStream;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) activeStream?.destroy();
      archive.close();
      if (error) reject(error); else resolve(entries);
    };
    archive.on("error", finish);
    archive.on("end", () => finish());
    archive.on("entry", entry => {
      const size = entry.uncompressedSize;
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (!safeName(entry.fileName) || names.has(entry.fileName) || !Number.isSafeInteger(size) || size < 0
        || entry.generalPurposeBitFlag & 1 || (fileType && fileType !== 0x8000 && fileType !== 0x4000)) {
        return finish(new Error("Invalid XLSX ZIP entry"));
      }
      names.add(entry.fileName);
      total += size;
      if (total > MAX_PACKAGE_BYTES) return finish(new Error("XLSX expanded package exceeds the in-memory limit"));
      archive.openReadStream(entry, (error, stream) => {
        if (error) return finish(error);
        activeStream = stream;
        const chunks = [];
        let length = 0;
        stream.on("error", finish);
        stream.on("data", chunk => {
          length += chunk.length;
          if (length > size) return finish(new Error("Invalid XLSX ZIP entry size"));
          chunks.push(chunk);
        });
        stream.on("end", () => {
          if (settled) return;
          const data = Buffer.concat(chunks);
          if (length !== size || crc32(data) !== (entry.crc32 >>> 0)) return finish(new Error("Invalid XLSX ZIP entry checksum"));
          entries.push({ name: entry.fileName, data, mtime: entry.getLastModDate(), mode: entry.externalFileAttributes >>> 16 });
          archive.readEntry();
        });
      });
    });
    archive.readEntry();
  }));
}

function explicitNormalFont(xml) {
  if (xml.includes("<!") || !/^\s*(?:<\?xml[^?]*\?>\s*)?<styleSheet\b[^>]*>[\s\S]*<\/styleSheet>\s*$/.test(xml)
    || !/<styleSheet\b[^>]*\bxmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/.test(xml)) {
    throw new Error("Invalid ExcelJS styles XML");
  }
  const tables = [...xml.matchAll(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/g)];
  if (tables.length !== 1) throw new Error("Expected one ExcelJS fonts table");
  const table = tables[0];
  const count = table[0].slice(0, table[0].indexOf(">") + 1).match(/\bcount="(\d+)"/g) || [];
  const fonts = table[1].match(/<font>[\s\S]*?<\/font>/g) || [];
  if (count.length !== 1 || !fonts.length || Number(count[0].match(/"(\d+)"/)[1]) !== fonts.length || table[1].replace(/<font>[\s\S]*?<\/font>/g, "").trim()) {
    throw new Error("Invalid ExcelJS fonts table");
  }
  const first = fonts[0];
  const inner = first.slice(6, -7);
  const element = /<(?:b|i|outline|shadow|condense|extend|color|sz|u|vertAlign|family|scheme|name|charset)\b(?:\s+[A-Za-z][\w:.-]*="[^"<>]*")*\s*\/>/g;
  if (inner.replace(element, "").trim()) throw new Error("Unsupported or malformed ExcelJS font0");
  for (const name of ["name", "sz", "scheme"]) {
    const matches = [...inner.matchAll(new RegExp(`<${name}\\b[^>]*\\/>`, "g"))];
    if ((name !== "scheme" && matches.length !== 1) || matches.length > 1) throw new Error("Ambiguous ExcelJS font0");
  }
  const fixed = first.replace(/<scheme\b[^>]*\/>/, "")
    .replace(/<name\b[^>]*\/>/, '<name val="仿宋"/>')
    .replace(/<sz\b[^>]*\/>/, '<sz val="12"/>');
  const fontOffset = table.index + table[0].indexOf(">") + 1 + table[1].indexOf(first);
  return xml.slice(0, fontOffset) + fixed + xml.slice(fontOffset + first.length);
}

function writeEntries(entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const chunks = [];
    archive.on("error", error => archive.outputStream.destroy(error));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("data", chunk => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    try {
      for (const entry of entries) {
        const options = { mtime: entry.mtime, ...(entry.mode ? { mode: entry.mode } : {}) };
        if (entry.name.endsWith("/")) archive.addEmptyDirectory(entry.name, options);
        else archive.addBuffer(entry.data, entry.name, options);
      }
      archive.end();
    } catch (error) { archive.outputStream.destroy(error); }
  });
}

async function rewriteXlsxNormalFont(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TypeError("An ExcelJS XLSX Buffer is required");
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error("XLSX package exceeds the in-memory limit");
  const entries = await readEntries(buffer);
  const names = new Set(entries.map(entry => entry.name));
  if (!["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml"].every(name => names.has(name))
    || !entries.some(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))) throw new Error("Expected an ExcelJS workbook package");
  const styles = entries.find(entry => entry.name === "xl/styles.xml");
  const xml = styles.data.toString("utf8");
  if (!Buffer.from(xml, "utf8").equals(styles.data)) throw new Error("Invalid styles XML encoding");
  const fixed = explicitNormalFont(xml);
  if (fixed === xml) return buffer;
  styles.data = Buffer.from(fixed, "utf8");
  return writeEntries(entries);
}

module.exports = { rewriteXlsxNormalFont };
