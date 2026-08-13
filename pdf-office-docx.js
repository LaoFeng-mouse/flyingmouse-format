const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalMergeType,
  WidthType
} = require("docx");
const { openZipEntries } = require("./zip-util");

const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = A4_WIDTH_DXA - (2 * MARGIN_DXA);
const TABLE_INDENT_DXA = 120;
const REVIEW_CONFIDENCE = 0.85;
const REVIEW_FILL = "FFF2CC";
const REFERENCE_HEADING = "原件对照 / Original reference";
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

function stableError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isStable(error) {
  return Boolean(error && typeof error.code === "string" && error.code.startsWith("PDF_DOCX_"));
}

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function confidenceShading(confidence) {
  return Number.isFinite(confidence) && confidence < REVIEW_CONFIDENCE
    ? { type: ShadingType.CLEAR, color: "auto", fill: REVIEW_FILL }
    : undefined;
}

function imageType(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpg";
  if (extension === ".gif") return "gif";
  if (extension === ".bmp") return "bmp";
  throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
}

async function readAsset(assetRoot, relativePath) {
  if (typeof assetRoot !== "string" || typeof relativePath !== "string" ||
      !relativePath || relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
  }
  const pieces = relativePath.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
  }
  try {
    const root = await fs.realpath(assetRoot);
    const candidate = path.resolve(root, ...pieces);
    const info = await fs.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("untrusted asset");
    const real = await fs.realpath(candidate);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!real.startsWith(prefix)) throw new Error("asset escaped root");
    return { data: await fs.readFile(real), type: imageType(relativePath) };
  } catch {
    throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
  }
}

function imageSize(width, height, maxWidth, maxHeight) {
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function tableRows(table) {
  const columns = Math.max(1, Number(table.columnCount) || 1);
  const rows = Math.max(1, Number(table.rowCount) || 1);
  const base = Math.floor(CONTENT_WIDTH_DXA / columns);
  const widths = Array.from({ length: columns }, (_, index) =>
    index === columns - 1 ? CONTENT_WIDTH_DXA - (base * (columns - 1)) : base
  );
  const anchors = new Map();
  const covering = new Map();
  for (const cell of Array.isArray(table.cells) ? table.cells : []) {
    const row = Number(cell.row);
    const column = Number(cell.column);
    const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
    const columnSpan = Math.max(1, Number(cell.columnSpan) || 1);
    anchors.set(`${row}:${column}`, { ...cell, rowSpan, columnSpan });
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) {
        covering.set(`${r}:${c}`, { row, column, rowSpan, columnSpan, confidence: cell.confidence });
      }
    }
  }

  const result = [];
  for (let row = 0; row < rows; row += 1) {
    const cells = [];
    for (let column = 0; column < columns;) {
      const anchor = anchors.get(`${row}:${column}`);
      if (anchor) {
        const spanWidth = widths.slice(column, column + anchor.columnSpan).reduce((sum, value) => sum + value, 0);
        cells.push(new TableCell({
          children: [new Paragraph({ text: safeText(anchor.text) })],
          width: { size: spanWidth, type: WidthType.DXA },
          columnSpan: anchor.columnSpan > 1 ? anchor.columnSpan : undefined,
          verticalMerge: anchor.rowSpan > 1 ? VerticalMergeType.RESTART : undefined,
          shading: confidenceShading(anchor.confidence)
        }));
        column += anchor.columnSpan;
        continue;
      }
      const covered = covering.get(`${row}:${column}`);
      if (covered && covered.row < row && covered.column === column) {
        const spanWidth = widths.slice(column, column + covered.columnSpan).reduce((sum, value) => sum + value, 0);
        cells.push(new TableCell({
          children: [new Paragraph("")],
          width: { size: spanWidth, type: WidthType.DXA },
          columnSpan: covered.columnSpan > 1 ? covered.columnSpan : undefined,
          verticalMerge: VerticalMergeType.CONTINUE,
          shading: confidenceShading(covered.confidence)
        }));
        column += covered.columnSpan;
        continue;
      }
      if (covered) {
        column += 1;
        continue;
      }
      cells.push(new TableCell({
        children: [new Paragraph("")],
        width: { size: widths[column], type: WidthType.DXA }
      }));
      column += 1;
    }
    result.push(new TableRow({ children: cells }));
  }
  return { rows: result, widths };
}

function makeTable(table) {
  const built = tableRows(table);
  const border = { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" };
  return new Table({
    rows: built.rows,
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: built.widths,
    indent: { size: TABLE_INDENT_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }
  });
}

async function reconstructedChildren(manifest, assetRoot) {
  const children = [];
  let editableText = false;
  let editableTable = false;
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (pageIndex > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    const tableMap = new Map((page.tables || []).map((table) => [table.id, table]));
    for (const block of page.blocks || []) {
      if (block.type === "table") {
        const table = tableMap.get(block.tableId);
        if (table) {
          children.push(makeTable(table));
          editableTable = true;
        }
        continue;
      }
      if (block.type === "seal") {
        const asset = await readAsset(assetRoot, block.asset);
        const bbox = Array.isArray(block.bbox) ? block.bbox : [0, 0, 1, 1];
        const size = imageSize(bbox[2] - bbox[0], bbox[3] - bbox[1], 150, 150);
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new ImageRun({
            ...asset,
            transformation: size,
            altText: { name: "Recognized seal", description: "Seal from source page", title: "Recognized seal" }
          })]
        }));
        continue;
      }
      const text = safeText(block.text);
      if (!text.trim()) continue;
      editableText = true;
      children.push(new Paragraph({
        text,
        heading: block.type === "heading" ? HeadingLevel.HEADING_1 : undefined,
        shading: confidenceShading(block.confidence)
      }));
    }
  }
  if (!editableText && !editableTable) {
    throw stableError("PDF_DOCX_NO_EDITABLE_CONTENT", "No editable content was detected in this PDF.");
  }
  return children;
}

async function referenceChildren(manifest, assetRoot) {
  const children = [
    new Paragraph({ text: REFERENCE_HEADING, heading: HeadingLevel.HEADING_1 })
  ];
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    const page = pages[index];
    const asset = await readAsset(assetRoot, page.referenceImage);
    const size = imageSize(page.width, page.height, 560, 800);
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 0 },
      children: [new ImageRun({
        ...asset,
        transformation: size,
        altText: {
          name: `Original reference page ${index + 1}`,
          description: `Original reference page ${index + 1}`,
          title: `Original reference page ${index + 1}`
        }
      })]
    }));
  }
  return children;
}

function sectionProperties(type) {
  return {
    type,
    page: {
      size: { width: A4_WIDTH_DXA, height: A4_HEIGHT_DXA, orientation: PageOrientation.PORTRAIT },
      margin: { top: MARGIN_DXA, right: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA, header: 708, footer: 708, gutter: 0 }
    }
  };
}

function createDocument(content, references) {
  return new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { after: 120, line: 264, lineRule: LineRuleType.AUTO } }
        },
        heading1: {
          run: { font: "Calibri", size: 32, bold: true, color: "2E74B5" },
          paragraph: { spacing: { before: 320, after: 160, line: 264, lineRule: LineRuleType.AUTO } }
        }
      }
    },
    sections: [
      { properties: sectionProperties(), children: content },
      { properties: sectionProperties(SectionType.NEXT_PAGE), children: references }
    ]
  });
}

function safeEntryName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/")) return false;
  const candidate = name.endsWith("/") ? name.slice(0, -1) : name;
  return Boolean(candidate) && candidate.split("/").every((piece) => piece && piece !== "." && piece !== "..");
}

async function inspectPackage(docxPath) {
  let zipfile;
  try {
    zipfile = await openZipEntries(docxPath);
  } catch {
    throw stableError("PDF_DOCX_INVALID_PACKAGE", "Generated DOCX package is invalid.");
  }
  return new Promise((resolve, reject) => {
    const names = new Set();
    const buffers = new Map();
    let total = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(stableError("PDF_DOCX_INVALID_PACKAGE", "Generated DOCX package is invalid."));
    };
    zipfile.on("entry", (entry) => {
      if (!safeEntryName(entry.fileName) || names.has(entry.fileName)) return fail();
      names.add(entry.fileName);
      total += Number(entry.uncompressedSize) || 0;
      if (total > MAX_PACKAGE_BYTES) return fail();
      const wanted = entry.fileName === "word/document.xml" || entry.fileName === "word/_rels/document.xml.rels";
      if (!wanted) {
        zipfile.readEntry();
        return;
      }
      if ((Number(entry.uncompressedSize) || 0) > MAX_XML_BYTES) return fail();
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return fail();
        const chunks = [];
        let length = 0;
        stream.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_XML_BYTES) {
            stream.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          if (settled) return;
          buffers.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      resolve({ names, buffers });
    });
    zipfile.readEntry();
  });
}

function attribute(fragment, name) {
  const match = fragment.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function decodeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function validatePdfOfficeDocx(docxPath, options = {}) {
  let inspected;
  try {
    inspected = await inspectPackage(docxPath);
    const documentBuffer = inspected.buffers.get("word/document.xml");
    const relsBuffer = inspected.buffers.get("word/_rels/document.xml.rels");
    if (!documentBuffer || !relsBuffer) throw new Error("missing package parts");
    const documentXml = documentBuffer.toString("utf8");
    const relsXml = relsBuffer.toString("utf8");
    const relationships = new Map();
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const id = attribute(match[1], "Id");
      const type = attribute(match[1], "Type");
      const target = attribute(match[1], "Target");
      const mode = attribute(match[1], "TargetMode");
      if (!id || relationships.has(id)) throw new Error("invalid relationship");
      if (type.endsWith("/image")) {
        if (mode || !target.startsWith("media/") || !safeEntryName(target)) throw new Error("unsafe image relationship");
        const entryName = `word/${target}`;
        if (!inspected.names.has(entryName)) throw new Error("missing image media");
        relationships.set(id, entryName);
      }
    }
    for (const match of documentXml.matchAll(/<a:blip\b[^>]*\br:embed=["']([^"']+)["'][^>]*>/gi)) {
      if (!relationships.has(match[1])) throw new Error("broken image relationship");
    }
    const referenceImageCount = [...documentXml.matchAll(/\bdescr=["']Original reference page \d+["']/g)].length;
    const expected = Number(options.expectedReferenceImages);
    if (Number.isInteger(expected) && expected >= 0 && referenceImageCount !== expected) {
      throw new Error("unexpected reference image count");
    }
    const text = [...documentXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .map((match) => decodeXml(match[1]).trim())
      .filter((value) => value && value !== REFERENCE_HEADING);
    const hasEditableContent = text.some((value) => value.length >= 2) || /<w:tbl\b/.test(documentXml);
    if (!hasEditableContent) {
      throw stableError("PDF_DOCX_NO_EDITABLE_CONTENT", "No editable content was detected in this PDF.");
    }
    return { hasEditableContent, referenceImageCount };
  } catch (error) {
    if (isStable(error)) throw error;
    throw stableError("PDF_DOCX_INVALID_PACKAGE", "Generated DOCX package is invalid.");
  }
}

async function writePdfOfficeDocx({ manifest, assetRoot, outputPath }) {
  if (!manifest || typeof outputPath !== "string" || !outputPath) {
    throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
  }
  const temporaryPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.rm(outputPath, { force: true });
    const content = await reconstructedChildren(manifest, assetRoot);
    const references = await referenceChildren(manifest, assetRoot);
    const buffer = await Packer.toBuffer(createDocument(content, references));
    await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
    const validation = await validatePdfOfficeDocx(temporaryPath, {
      expectedReferenceImages: Array.isArray(manifest.pages) ? manifest.pages.length : 0
    });
    await fs.rename(temporaryPath, outputPath);
    return validation;
  } catch (error) {
    await Promise.allSettled([
      fs.rm(temporaryPath, { force: true }),
      fs.rm(outputPath, { force: true })
    ]);
    if (isStable(error)) throw error;
    throw stableError("PDF_DOCX_BUILD_FAILED", "Unable to build editable DOCX.");
  }
}

module.exports = {
  REFERENCE_HEADING,
  validatePdfOfficeDocx,
  writePdfOfficeDocx
};
