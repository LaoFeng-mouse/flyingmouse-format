// CAJ -> PDF conversion for the classic CAJ container.
// Some .caj downloads are already PDFs; classic CAJ stores disordered PDF objects.

const fsp = require("fs/promises");
const { PDFDocument } = require("pdf-lib");

const MAX_CAJ_BYTES = 1024 * 1024 * 1024;

class CajConversionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CajConversionError";
    this.code = code;
    this.details = details;
  }
}

function detectCajVariant(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "unknown";
  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (buffer[0] === 0xc8) return "c8";
  const signature = buffer.subarray(0, 4).toString("latin1").replace(/\0/g, "").trim().toUpperCase();
  if (signature === "CAJ") return "caj";
  if (signature.startsWith("HN")) return "hn";
  if (signature === "KDH") return "kdh";
  if (signature === "TEB") return "teb";
  return "unknown";
}

function invalidCaj(reason) {
  return new CajConversionError("CAJ_INVALID", "CAJ 文件结构损坏或无法识别。", { reason });
}

function extractClassicCajPdfObjects(buffer) {
  if (buffer.length < 0x1c) throw invalidCaj("header-too-short");
  const pageCount = buffer.readInt32LE(0x10);
  const pointerOffset = buffer.readInt32LE(0x14);
  if (pageCount < 1 || pageCount > 100000) throw invalidCaj("invalid-page-count");
  if (pointerOffset < 0 || pointerOffset + 4 > buffer.length) throw invalidCaj("invalid-pdf-pointer-offset");
  const pdfStart = buffer.readInt32LE(pointerOffset);
  if (pdfStart < 0 || pdfStart >= buffer.length) throw invalidCaj("invalid-pdf-start");
  const source = buffer.subarray(pdfStart).toString("latin1");
  const starts = [...source.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g)];
  const objects = new Map();
  for (const match of starts) {
    const start = match.index + (match[0].startsWith("\r") || match[0].startsWith("\n") ? 1 : 0);
    const endMarker = source.indexOf("endobj", start);
    if (endMarker < 0) continue;
    const number = Number(match[1]);
    const generation = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || generation < 0 || objects.has(number)) continue;
    objects.set(number, { number, generation, data: source.slice(start, endMarker + 6).trim() });
  }
  if (!objects.size) throw invalidCaj("no-pdf-objects");
  return { pageCount, objects };
}

function objectBody(object) {
  return object.data.slice(object.data.indexOf("obj") + 3, object.data.lastIndexOf("endobj"));
}

function referenceAfter(body, key) {
  const match = body.match(new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`));
  return match ? Number(match[1]) : null;
}

function countPages(rootNumber, objects, seen = new Set()) {
  if (seen.has(rootNumber)) return 0;
  seen.add(rootNumber);
  const object = objects.get(rootNumber);
  if (!object) return 0;
  const body = objectBody(object);
  if (/\/Type\s*\/Page\b/.test(body)) return 1;
  const declared = body.match(/\/Count\s+(\d+)/);
  if (declared) return Number(declared[1]);
  const kids = body.match(/\/Kids\s*\[([^\]]*)\]/s)?.[1] || "";
  return [...kids.matchAll(/(\d+)\s+\d+\s+R/g)].reduce((sum, match) => sum + countPages(Number(match[1]), objects, seen), 0);
}

function addMissingPageTree(objects, expectedPageCount) {
  let maxNumber = Math.max(...objects.keys());
  const pageLike = [...objects.values()].filter((object) => /\/Type\s*\/Pages?\b/.test(objectBody(object)));
  if (!pageLike.length) throw invalidCaj("no-page-objects");

  const missingParents = new Set();
  for (const object of pageLike) {
    const parent = referenceAfter(objectBody(object), "\\/Parent");
    if (parent && !objects.has(parent)) missingParents.add(parent);
  }
  for (const parent of missingParents) {
    const children = pageLike.filter((object) => referenceAfter(objectBody(object), "\\/Parent") === parent);
    const count = children.reduce((sum, child) => sum + countPages(child.number, objects), 0) || expectedPageCount;
    objects.set(parent, { number: parent, generation: 0, data: `${parent} 0 obj\n<< /Type /Pages /Kids [${children.map((item) => `${item.number} 0 R`).join(" ")}] /Count ${count} >>\nendobj` });
    maxNumber = Math.max(maxNumber, parent);
  }

  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog\b/.test(objectBody(object)));
  if (catalog) return catalog.number;
  const roots = [...objects.values()].filter((object) => {
    const body = objectBody(object);
    return /\/Type\s*\/Pages\b/.test(body) && !referenceAfter(body, "\\/Parent");
  });
  if (!roots.length) throw invalidCaj("no-page-tree-root");
  let pagesRoot = roots[0].number;
  if (roots.length > 1) {
    pagesRoot = ++maxNumber;
    const count = roots.reduce((sum, root) => sum + countPages(root.number, objects), 0) || expectedPageCount;
    objects.set(pagesRoot, { number: pagesRoot, generation: 0, data: `${pagesRoot} 0 obj\n<< /Type /Pages /Kids [${roots.map((item) => `${item.number} 0 R`).join(" ")}] /Count ${count} >>\nendobj` });
  }
  const catalogNumber = ++maxNumber;
  objects.set(catalogNumber, { number: catalogNumber, generation: 0, data: `${catalogNumber} 0 obj\n<< /Type /Catalog /Pages ${pagesRoot} 0 R >>\nendobj` });
  return catalogNumber;
}

function rebuildPdf(objects, rootNumber) {
  const sorted = [...objects.values()].sort((a, b) => a.number - b.number);
  const maxNumber = sorted.at(-1).number;
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = new Map();
  let length = chunks[0].length;
  for (const object of sorted) {
    offsets.set(object.number, length);
    const chunk = Buffer.from(`${object.data}\n`, "latin1");
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const xref = ["xref", `0 ${maxNumber + 1}`, "0000000000 65535 f "];
  for (let number = 1; number <= maxNumber; number += 1) {
    const object = objects.get(number);
    xref.push(object ? `${String(offsets.get(number)).padStart(10, "0")} ${String(object.generation).padStart(5, "0")} n ` : "0000000000 65535 f ");
  }
  xref.push("trailer", `<< /Size ${maxNumber + 1} /Root ${rootNumber} 0 R >>`, "startxref", String(xrefOffset), "%%EOF", "");
  chunks.push(Buffer.from(xref.join("\n"), "latin1"));
  return Buffer.concat(chunks);
}

async function validatePdf(buffer) {
  try {
    const document = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    if (document.getPageCount() < 1) throw new Error("empty PDF");
  } catch (error) {
    throw new CajConversionError("CAJ_PDF_REBUILD_FAILED", "已提取 CAJ 内容，但无法重建为有效 PDF。", { reason: error.message });
  }
}

async function convertCajToPdf(inputPath, outputPath) {
  const stat = await fsp.stat(inputPath);
  if (stat.size > MAX_CAJ_BYTES) throw new CajConversionError("CAJ_TOO_LARGE", "CAJ 文件超过 1 GB，无法安全转换。");
  const input = await fsp.readFile(inputPath);
  const variant = detectCajVariant(input);
  let output;
  if (variant === "pdf") {
    output = input;
  } else if (variant === "caj") {
    const extracted = extractClassicCajPdfObjects(input);
    const rootNumber = addMissingPageTree(extracted.objects, extracted.pageCount);
    output = rebuildPdf(extracted.objects, rootNumber);
  } else if (["hn", "c8", "kdh", "teb"].includes(variant)) {
    throw new CajConversionError("CAJ_VARIANT_UNSUPPORTED", `该文件实际为 ${variant.toUpperCase()} 变体，当前版本暂不支持转换。`, { variant });
  } else {
    throw new CajConversionError("CAJ_UNKNOWN_FORMAT", "文件扩展名是 CAJ，但内容不是可识别的知网 CAJ 文件。");
  }
  await validatePdf(output);
  await fsp.writeFile(outputPath, output);
  return { warnings: variant === "pdf" ? [{ code: "CAJ_ALREADY_PDF" }] : [], variant };
}

module.exports = { CajConversionError, detectCajVariant, extractClassicCajPdfObjects, addMissingPageTree, rebuildPdf, convertCajToPdf };
