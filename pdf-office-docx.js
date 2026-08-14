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
const { STRUCTURE_LIMITS } = require("./resource-policy");

const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = A4_WIDTH_DXA - (2 * MARGIN_DXA);
const TABLE_INDENT_DXA = 120;
const TABLE_WIDTH_DXA = CONTENT_WIDTH_DXA - TABLE_INDENT_DXA;
const REVIEW_CONFIDENCE = 0.85;
const REVIEW_FILL = "FFF2CC";
const REFERENCE_HEADING = "原件对照 / Original reference";
const RECONSTRUCTED_IMAGE_TYPES = new Set(["seal", "signature", "figure"]);
// 物理天花板（Node Buffer 上限约 2GB），不是业务限制：正常 DOCX 的 XML part 与包远小于此，
// 仅用于拦截声明超大量的恶意 ZIP 条目，避免解压 OOM。
const MAX_XML_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WORD_COLUMNS = 63;
const MAX_WORD_ROWS = 10_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;

const ERROR_MESSAGES = Object.freeze({
  PDF_DOCX_NO_EDITABLE_CONTENT: Object.freeze({
    zhCN: "未检测到可编辑的文字或表格，无法生成有效的 Word 文档。",
    enUS: "No editable text or table was detected, so a valid Word document cannot be created."
  }),
  PDF_OFFICE_OUTPUT_INVALID: Object.freeze({
    zhCN: "生成的 Office 文件无效或不完整，请重试。",
    enUS: "The generated Office file is invalid or incomplete. Please try again."
  })
});

function stableError(code) {
  const messages = ERROR_MESSAGES[code] || ERROR_MESSAGES.PDF_OFFICE_OUTPUT_INVALID;
  const error = new Error(`${messages.zhCN} ${messages.enUS}`);
  error.code = code;
  error.messages = { ...messages };
  return error;
}

function isStable(error) {
  return Boolean(error && (error.code === "PDF_DOCX_NO_EDITABLE_CONTENT" || error.code === "PDF_OFFICE_OUTPUT_INVALID"));
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
  throw stableError("PDF_OFFICE_OUTPUT_INVALID");
}

function assetPathParts(relativePath) {
  if (typeof relativePath !== "string" || !relativePath ||
      relativePath.includes("\\") || path.isAbsolute(relativePath)) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  const pieces = relativePath.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  return pieces;
}

async function preflightAssets(manifest, assetRoot, fileSystem) {
  try {
    if (typeof assetRoot !== "string") throw new Error("invalid root");
    const root = await fileSystem.realpath(assetRoot);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    const relativePaths = [];
    for (const page of Array.isArray(manifest.pages) ? manifest.pages : []) {
      relativePaths.push(page.referenceImage);
      for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
        if (RECONSTRUCTED_IMAGE_TYPES.has(block.type)) relativePaths.push(block.asset);
      }
    }
    const catalog = new Map();
    let totalBytes = 0;
    for (const relativePath of new Set(relativePaths)) {
      const pieces = assetPathParts(relativePath);
      const candidate = path.resolve(root, ...pieces);
      const info = await fileSystem.lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 0 ||
          info.size > MAX_ASSET_BYTES) throw new Error("untrusted asset");
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error("asset budget");
      const real = await fileSystem.realpath(candidate);
      if (!real.startsWith(prefix)) throw new Error("asset escaped root");
      catalog.set(relativePath, { real, type: imageType(relativePath) });
    }
    return catalog;
  } catch {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

async function readAsset(catalog, relativePath, fileSystem) {
  const asset = catalog.get(relativePath);
  if (!asset) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  try {
    return { data: await fileSystem.readFile(asset.real), type: asset.type };
  } catch {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
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

function validateWriterBounds(manifest) {
  let totalGridCells = 0;
  for (const page of Array.isArray(manifest.pages) ? manifest.pages : []) {
    for (const table of Array.isArray(page.tables) ? page.tables : []) {
      const rows = Number(table.rowCount);
      const columns = Number(table.columnCount);
      if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_WORD_ROWS ||
          !Number.isSafeInteger(columns) || columns < 1 || columns > MAX_WORD_COLUMNS) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      const gridCells = rows * columns;
      if (!Number.isSafeInteger(gridCells) || gridCells > STRUCTURE_LIMITS.maxCellsPerTable) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      totalGridCells += gridCells;
      if (!Number.isSafeInteger(totalGridCells) || totalGridCells > STRUCTURE_LIMITS.maxTotalCells) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
    }
  }
}

function tableRows(table) {
  const columns = Math.max(1, Number(table.columnCount) || 1);
  const rows = Math.max(1, Number(table.rowCount) || 1);
  const base = Math.floor(TABLE_WIDTH_DXA / columns);
  const widths = Array.from({ length: columns }, (_, index) =>
    index === columns - 1 ? TABLE_WIDTH_DXA - (base * (columns - 1)) : base
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
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: built.widths,
    indent: { size: TABLE_INDENT_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }
  });
}

async function reconstructedChildren(manifest, assetCatalog, fileSystem) {
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
      if (RECONSTRUCTED_IMAGE_TYPES.has(block.type)) {
        const asset = await readAsset(assetCatalog, block.asset, fileSystem);
        const bbox = Array.isArray(block.bbox) ? block.bbox : [0, 0, 1, 1];
        const imageLimits = block.type === "figure" ? [560, 500]
          : block.type === "signature" ? [280, 120]
            : [150, 150];
        const size = imageSize(bbox[2] - bbox[0], bbox[3] - bbox[1], ...imageLimits);
        const label = block.type[0].toUpperCase() + block.type.slice(1);
        children.push(new Paragraph({
          alignment: block.type === "figure" ? AlignmentType.CENTER : AlignmentType.RIGHT,
          children: [new ImageRun({
            ...asset,
            transformation: size,
            altText: {
              name: `Recognized ${block.type}`,
              description: `${label} from source page`,
              title: `Recognized ${block.type}`
            }
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
    throw stableError("PDF_DOCX_NO_EDITABLE_CONTENT");
  }
  return children;
}

async function referenceChildren(manifest, assetCatalog, fileSystem) {
  const children = [
    new Paragraph({ text: REFERENCE_HEADING, heading: HeadingLevel.HEADING_1 })
  ];
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    const page = pages[index];
    const asset = await readAsset(assetCatalog, page.referenceImage, fileSystem);
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
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  return new Promise((resolve, reject) => {
    const names = new Set();
    const buffers = new Map();
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(stableError("PDF_OFFICE_OUTPUT_INVALID"));
    };
    zipfile.on("entry", (entry) => {
      if (!safeEntryName(entry.fileName) || names.has(entry.fileName)) return fail();
      names.add(entry.fileName);
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

function xmlTexts(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function tableDimensions(tableXml) {
  const rows = [...tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/gi)];
  const grid = tableXml.match(/<w:tblGrid\b[^>]*>([\s\S]*?)<\/w:tblGrid>/i);
  let columns = grid ? [...grid[1].matchAll(/<w:gridCol\b/gi)].length : 0;
  if (!columns) {
    for (const row of rows) {
      let rowColumns = 0;
      for (const cell of row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gi)) {
        const span = cell[0].match(/<w:gridSpan\b[^>]*\bw:val=["'](\d+)["']/i);
        rowColumns += span ? Number(span[1]) : 1;
      }
      columns = Math.max(columns, rowColumns);
    }
  }
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > MAX_WORD_COLUMNS ||
      rows.length < 1 || rows.length > MAX_WORD_ROWS) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  const activeVerticalMerges = Array(columns).fill(null);
  let mergeSequence = 0;
  let populatedCells = 0;
  for (const row of rows) {
    const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gi)].map((match) => match[0]);
    let column = 0;
    for (const cell of cells) {
      const spanMatch = cell.match(/<w:gridSpan\b[^>]*\bw:val=["'](\d+)["']/i);
      const span = spanMatch ? Number(spanMatch[1]) : 1;
      if (!Number.isSafeInteger(span) || span < 1 || column + span > columns) {
        throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      }
      const merge = cell.match(/<w:vMerge\b([^>]*)\/?\s*>/i);
      if (merge) {
        const value = attribute(merge[1], "w:val") || attribute(merge[1], "val") || "continue";
        if (value === "continue") {
          const mergeId = activeVerticalMerges[column];
          if (!mergeId) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
          for (let index = column; index < column + span; index += 1) {
            if (activeVerticalMerges[index] !== mergeId) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
          }
          if (activeVerticalMerges.filter((value) => value === mergeId).length !== span) {
            throw stableError("PDF_OFFICE_OUTPUT_INVALID");
          }
        } else if (value === "restart") {
          mergeSequence += 1;
          for (let index = column; index < column + span; index += 1) activeVerticalMerges[index] = mergeSequence;
        } else {
          throw stableError("PDF_OFFICE_OUTPUT_INVALID");
        }
      } else {
        for (let index = column; index < column + span; index += 1) activeVerticalMerges[index] = null;
      }
      if (xmlTexts(cell).some((text) => text.length >= 1)) populatedCells += 1;
      column += span;
    }
    if (column !== columns) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  return { rows: rows.length, columns, populated: populatedCells > 0, populatedCells };
}

function expectedTablesFromManifest(manifest) {
  const expected = [];
  for (const page of Array.isArray(manifest.pages) ? manifest.pages : []) {
    const tables = new Map((Array.isArray(page.tables) ? page.tables : []).map((table) => [table.id, table]));
    for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
      if (block.type !== "table") continue;
      const table = tables.get(block.tableId);
      if (!table) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
      expected.push({
        id: table.id,
        rows: Number(table.rowCount),
        columns: Number(table.columnCount),
        populatedCells: (Array.isArray(table.cells) ? table.cells : [])
          .filter((cell) => safeText(cell.text).trim().length >= 1).length
      });
    }
  }
  return expected;
}

function validateExpectedTables(actualTables, expectedTables) {
  if (expectedTables === undefined) return;
  if (!Array.isArray(expectedTables) || actualTables.length !== expectedTables.length) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  for (let index = 0; index < expectedTables.length; index += 1) {
    const expected = expectedTables[index];
    if (!expected || !Number.isSafeInteger(expected.rows) || !Number.isSafeInteger(expected.columns) ||
        actualTables[index].rows !== expected.rows || actualTables[index].columns !== expected.columns ||
        (Number.isSafeInteger(expected.populatedCells) && actualTables[index].populatedCells !== expected.populatedCells)) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
  }
}

function referenceDrawings(documentXml, relationships) {
  const markers = [];
  for (const match of documentXml.matchAll(/<wp:(?:inline|anchor)\b[^>]*>([\s\S]*?)<\/wp:(?:inline|anchor)>/gi)) {
    const drawing = match[1];
    const docProperties = drawing.match(/<wp:docPr\b([^>]*)\/?\s*>/i);
    if (!docProperties) continue;
    const description = attribute(docProperties[1], "descr");
    const marker = description.match(/^Original reference page ([1-9]\d*)$/);
    if (!marker) continue;
    const blip = drawing.match(/<a:blip\b[^>]*\br:embed=["']([^"']+)["'][^>]*>/i);
    if (!blip || !relationships.has(blip[1])) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    markers.push({ number: Number(marker[1]), relationshipId: blip[1] });
  }
  return markers;
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
    const allText = xmlTexts(documentXml);
    if (allText.filter((text) => text === REFERENCE_HEADING).length !== 1) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    const headingOffset = documentXml.indexOf(REFERENCE_HEADING);
    if (headingOffset < 0) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    const markers = referenceDrawings(documentXml.slice(headingOffset), relationships);
    const referenceImageCount = markers.length;
    const expected = Number(options.expectedReferenceImages);
    if (Number.isInteger(expected) && expected >= 0 && referenceImageCount !== expected) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
    const requiredMarkerCount = Number.isInteger(expected) && expected >= 0 ? expected : markers.length;
    if (requiredMarkerCount === 0 || markers.length !== requiredMarkerCount ||
        markers.some((marker, index) => marker.number !== index + 1) ||
        new Set(markers.map((marker) => marker.number)).size !== markers.length) {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }

    const reconstructedXml = documentXml.slice(0, headingOffset);
    const tableXml = [...reconstructedXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/gi)].map((match) => match[0]);
    const actualTables = tableXml.map(tableDimensions);
    validateExpectedTables(actualTables, options.expectedTables);
    const proseXml = reconstructedXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/gi, "");
    const meaningfulProse = xmlTexts(proseXml).some((text) => text.length >= 1);
    const meaningfulTable = actualTables.some((table) => table.populated);
    const hasEditableContent = meaningfulProse || meaningfulTable;
    if (!hasEditableContent) {
      throw stableError("PDF_DOCX_NO_EDITABLE_CONTENT");
    }
    return { hasEditableContent, referenceImageCount, tables: actualTables.map(({ rows, columns }) => ({ rows, columns })) };
  } catch (error) {
    if (isStable(error)) throw error;
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

async function existingOutputInfo(outputPath, fileSystem) {
  try {
    return await fileSystem.lstat(outputPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

async function publishAtomically(temporaryPath, outputPath, fileSystem) {
  const existing = await existingOutputInfo(outputPath, fileSystem);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  if (!existing) {
    try {
      await fileSystem.rename(temporaryPath, outputPath);
      return;
    } catch {
      throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    }
  }

  const backupPath = `${outputPath}.backup-${crypto.randomUUID()}`;
  try {
    await fileSystem.rename(outputPath, backupPath);
  } catch {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  try {
    await fileSystem.rename(temporaryPath, outputPath);
  } catch {
    try {
      await fileSystem.rename(backupPath, outputPath);
    } catch {
      try {
        await fileSystem.copyFile(backupPath, outputPath);
        await fileSystem.rm(backupPath, { force: true });
      } catch {
        // Preserve the recoverable sibling backup when rollback cannot be completed.
      }
    }
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  try {
    await fileSystem.rm(backupPath, { force: true });
  } catch {
    // Publishing has completed; a bounded best-effort backup cleanup must not invalidate it.
  }
}

async function writePdfOfficeDocx({
  manifest,
  assetRoot,
  outputPath,
  fileSystem = fs,
  validateDocument = validatePdfOfficeDocx
}) {
  if (!manifest || typeof outputPath !== "string" || !outputPath) {
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
  const temporaryPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
  try {
    validateWriterBounds(manifest);
    const assetCatalog = await preflightAssets(manifest, assetRoot, fileSystem);
    const content = await reconstructedChildren(manifest, assetCatalog, fileSystem);
    const references = await referenceChildren(manifest, assetCatalog, fileSystem);
    const buffer = await Packer.toBuffer(createDocument(content, references));
    if (buffer.length > MAX_PACKAGE_BYTES) throw stableError("PDF_OFFICE_OUTPUT_INVALID");
    await fileSystem.writeFile(temporaryPath, buffer, { flag: "wx" });
    const validation = await validateDocument(temporaryPath, {
      expectedReferenceImages: Array.isArray(manifest.pages) ? manifest.pages.length : 0,
      expectedTables: expectedTablesFromManifest(manifest)
    });
    await publishAtomically(temporaryPath, outputPath, fileSystem);
    return validation;
  } catch (error) {
    try {
      const temporaryInfo = await fileSystem.lstat(temporaryPath);
      if (temporaryInfo.isFile() && !temporaryInfo.isSymbolicLink()) {
        await fileSystem.rm(temporaryPath, { force: true });
      }
    } catch {}
    if (isStable(error)) throw error;
    throw stableError("PDF_OFFICE_OUTPUT_INVALID");
  }
}

module.exports = {
  REFERENCE_HEADING,
  validatePdfOfficeDocx,
  writePdfOfficeDocx
};
