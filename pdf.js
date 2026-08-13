// pdf.js — 飞鼠格式 PDF 转换域：加密/拆分/合并/渲染图片/扫描 OCR/表格→Excel/DOCX/HTML。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。
// convertScannedPdfToOcrDocx 依赖 text-docx.js（第四批），convertPresentationTo* 依赖
// office-convert.js（第四批）——顶层不 require 以避免循环，函数内延迟 require。

const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("node:crypto");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const sanitize = require("sanitize-filename");
const { PDFDocument } = require("pdf-lib");
const { PDFTOPPM_PATH, DOCENGINE_PATH, pdfImageTargets } = require("./config");
const { run, commandExists, escapeHtml, safeBaseName } = require("./utils");
const { zipFiles, openZipEntries, readZipEntryToFile } = require("./zip-util");
const { convertImagesToPdf } = require("./image");
const { ocrAvailable, createOcrWorker, recognizeImageTextWithWorker } = require("./ocr");
const { loadPdfjs } = require("./pdfjs");
const { classifyPdf } = require("./pdf-classifier");
const {
  extractPdfRowsByPage,
  extractComplexPdfTableModel,
  writePdfTableWorkbook
} = require("./pdf-table");
const { assertPdfPages } = require("./resource-policy");
const { OfficeQualityError } = require("./office-quality");
const { withStructuredPdf } = require("./pdf-structure-engine");
const { chooseTableCandidate } = require("./pdf-structure-score");
const { structureError } = require("./pdf-structure-contract");
const { writePdfOfficeDocx } = require("./pdf-office-docx");
const { writePdfOfficeXlsx } = require("./pdf-office-xlsx");
const { parseXmlToJson } = require("./xml-json");

async function convertPdfDecrypt(inputPath, outputPath, password) {
  const data = await fsp.readFile(inputPath);
  const pdf = await PDFDocument.load(data, { password, ignoreEncryption: false });
  await fsp.writeFile(outputPath, await pdf.save());
}

const OCR_QUALITY_THRESHOLD = 0.65;

function selectedStructureManifest(manifest) {
  const copy = structuredClone(manifest);
  copy.pages = (copy.pages || []).map((page) => {
    if (!Array.isArray(page.tableCandidates)) return page;
    const selected = chooseTableCandidate(page.tableCandidates).table;
    const copyPage = { ...page, tables: [structuredClone(selected)] };
    delete copyPage.tableCandidates;
    return copyPage;
  });
  return copy;
}

function tableNotDetectedError() {
  return structureError(
    "PDF_TABLE_NOT_DETECTED",
    "未检测到可可靠编辑的表格，无法生成 Excel。",
    "No reliably editable table was detected, so an Excel workbook cannot be created."
  );
}

async function outputInfo(outputPath) {
  try {
    return await fsp.lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function publishAttempt(attemptPath, outputPath) {
  const existing = await outputInfo(outputPath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("unsafe output target");
  }
  if (!existing) {
    await fsp.rename(attemptPath, outputPath);
    return;
  }
  const backupPath = `${outputPath}.backup-${crypto.randomUUID()}`;
  await fsp.rename(outputPath, backupPath);
  try {
    await fsp.rename(attemptPath, outputPath);
  } catch (error) {
    try {
      await fsp.rename(backupPath, outputPath);
    } catch {
      await fsp.copyFile(backupPath, outputPath).catch(() => {});
    }
    throw error;
  }
  await fsp.rm(backupPath, { force: true }).catch(() => {});
}

async function withAttemptOutput(outputPath, produce) {
  const attemptPath = `${outputPath}.attempt-${crypto.randomUUID()}`;
  try {
    const result = await produce(attemptPath);
    const info = await fsp.lstat(attemptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error("invalid attempt output");
    await publishAttempt(attemptPath, outputPath);
    return result;
  } finally {
    await fsp.rm(attemptPath, { force: true }).catch(() => {});
  }
}

async function convertStructuredPdf({ inputPath, outputPath, target, options = {} }) {
  const boundary = options.withStructuredPdf || withStructuredPdf;
  return boundary(inputPath, options, async (manifest, assetRoot) => {
      const selected = selectedStructureManifest(manifest);
      if (target === "xlsx") {
        const tables = selected.pages.reduce((total, page) => total + (page.tables || []).length, 0);
        if (tables === 0) throw tableNotDetectedError();
        return withAttemptOutput(outputPath, (attemptPath) =>
          (options.writePdfOfficeXlsx || writePdfOfficeXlsx)({
            manifest: selected, assetRoot, outputPath: attemptPath
          }));
      }
      if (target === "docx") {
        return withAttemptOutput(outputPath, (attemptPath) =>
          (options.writePdfOfficeDocx || writePdfOfficeDocx)({
            manifest: selected, assetRoot, outputPath: attemptPath
          }));
      }
      throw structureError("PDF_STRUCTURE_TARGET_UNSUPPORTED",
        "不支持该结构化输出格式。", "Unsupported structured PDF target.");
  });
}

function assertPdfTableOcrQuality(model) {
  const ocrPages = (model?.summary || []).filter((page) => page.source === "ocr" && page.tableCount > 0);
  if (!ocrPages.length) return;
  const worst = Math.min(...ocrPages.map((page) => page.confidence));
  if (worst >= OCR_QUALITY_THRESHOLD) return;
  const percent = Math.round(worst * 100);
  const error = new Error(
    `扫描件 OCR 识别质量过低（最低置信度 ${percent}%），无法准确转换表格。可能原因是图片模糊、倾斜、阴影或分辨率不足；请提供更清晰的扫描件后重试。`
  );
  error.code = "PDF_TABLE_OCR_LOW_QUALITY";
  error.messages = {
    zhCN: `扫描件 OCR 识别质量过低（置信度 ${percent}%），可能因模糊、倾斜或阴影导致，无法准确转换表格。`,
    enUS: `Scanned PDF OCR quality is too low (confidence ${percent}%). The page may be blurry, skewed, or shadowed, so the table cannot be converted accurately.`
  };
  throw error;
}

async function convertPdf(inputPath, outputPath, target, options = {}) {
  if (target === "pdf") {
    if (options.pdfAction === "encrypt") {
      const error = new Error("PDF 加密功能暂不可用：当前版本缺少加密引擎，请使用系统自带或其他专业工具为 PDF 设置密码。");
      error.code = "PDF_ENCRYPT_UNAVAILABLE";
      error.messages = {
        zhCN: "PDF 加密功能暂不可用：当前版本缺少加密引擎，请使用系统自带或其他专业工具为 PDF 设置密码。",
        enUS: "PDF encryption is not available in this build. Use another tool to password-protect the PDF."
      };
      throw error;
    }
    if (options.pdfAction === "decrypt") {
      await convertPdfDecrypt(inputPath, outputPath, options.password || "");
    } else {
      await splitPdfToZip(inputPath, outputPath);
    }
    return;
  }

  if (pdfImageTargets.includes(target)) {
    await convertPdfPagesToImagesZip(inputPath, outputPath, target);
    return;
  }

  if (target === "docx" || target === "xlsx") {
    const classification = await (options.classifyPdf || classifyPdf)(inputPath);
    if (classification.kind !== "native") {
      await (options.convertStructuredPdf || convertStructuredPdf)({
        inputPath,
        outputPath,
        target,
        classification,
        options
      });
      return;
    }
  }

  if (target === "xlsx") {
    const model = await extractComplexPdfTableModel(inputPath);
    assertPdfTableOcrQuality(model);
    await writePdfTableWorkbook(model, outputPath);
    return;
  }

  const pages = await extractPdfRowsByPage(inputPath);
  const hasExtractableRows = pages.some((page) => page.rows.length);

  if (!hasExtractableRows) {
    if (target === "txt") {
      await convertScannedPdfToOcrText(inputPath, outputPath);
      return;
    }
    if (target === "docx") {
      await convertScannedPdfToOcrDocx(inputPath, outputPath);
      return;
    }
    if (target === "html") {
      await convertScannedPdfToOcrHtml(inputPath, outputPath);
      return;
    }
    throw new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF。");
  }

  if (target === "txt") {
    const text = pages
      .map((page) => [`## ${page.name}`, ...page.rows.map((row) => row.join("\t"))].join("\n"))
      .join("\n\n");
    await fsp.writeFile(outputPath, text, "utf8");
    return;
  }

  if (target === "html") {
    const body = pages.map((page) => {
      const rows = page.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("\n");
      return `<h2>${escapeHtml(page.name)}</h2><table>${rows}</table>`;
    }).join("\n");
    await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PDF table export</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px}
table{border-collapse:collapse;margin-bottom:24px}
td{border:1px solid #999;padding:4px 8px;vertical-align:top}
</style>
</head>
<body>${body}</body>
</html>`, "utf8");
    return;
  }

  if (target === "docx") {
    await convertPdfToDocx(inputPath, outputPath, pages, options);
    return;
  }

  throw new Error("PDF 暂时只支持转换为 XLSX、TXT、HTML、DOCX、PNG、JPG，或拆分为单页 PDF。");
}

function xmlDocxText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlDocxParagraph(text, bold = false) {
  const run = bold ? `<w:rPr><w:b/></w:rPr>` : "";
  return `<w:p><w:r>${run}<w:t xml:space="preserve">${xmlDocxText(text)}</w:t></w:r></w:p>`;
}

function writeDocxZip(outputPath, entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const entry of entries) {
      archive.addBuffer(Buffer.from(entry.content, "utf8"), entry.path);
    }
    const output = fs.createWriteStream(outputPath);
    archive.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
    archive.end();
  });
}

const MAX_NATIVE_DOCX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_DOCX_XML_BYTES = 20 * 1024 * 1024;
const NATIVE_DOCX_PARTS = new Set([
  "[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels"
]);

function safePackageEntry(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/")) return false;
  const candidate = name.endsWith("/") ? name.slice(0, -1) : name;
  return Boolean(candidate) && candidate.split("/").every((piece) => piece && piece !== "." && piece !== "..");
}

async function inspectNativeDocxPackage(zipPath) {
  const zipfile = await openZipEntries(zipPath);
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const names = new Set();
    const buffers = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      error ? reject(error) : resolve(value);
    };
    zipfile.on("entry", (entry) => {
      const size = Number(entry.uncompressedSize) || 0;
      if (!safePackageEntry(entry.fileName) || names.has(entry.fileName) || size < 0) {
        return finish(new Error("unsafe DOCX package entry"));
      }
      names.add(entry.fileName);
      total += size;
      if (!Number.isSafeInteger(total) || total > MAX_NATIVE_DOCX_PACKAGE_BYTES) {
        return finish(new Error("DOCX package is too large"));
      }
      if (!NATIVE_DOCX_PARTS.has(entry.fileName)) return zipfile.readEntry();
      if (size > MAX_NATIVE_DOCX_XML_BYTES) return finish(new Error("DOCX XML part is too large"));
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return finish(error);
        const chunks = [];
        let length = 0;
        stream.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_NATIVE_DOCX_XML_BYTES) {
            stream.destroy(new Error("DOCX document part is too large"));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", finish);
        stream.on("end", () => {
          if (settled) return;
          buffers.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("end", () => finish(null, { names, buffers }));
    zipfile.on("error", finish);
    zipfile.readEntry();
  });
}

function opcAttribute(fragment, name) {
  const match = fragment.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function nativeDocxInvalid() {
  const error = new Error("Native PDF conversion produced an invalid DOCX package.");
  error.code = "PDF_OFFICE_OUTPUT_INVALID";
  return error;
}

async function validateNativePdfDocx(outputPath) {
  try {
    const inspected = await inspectNativeDocxPackage(outputPath);
    const contentTypes = inspected.buffers.get("[Content_Types].xml")?.toString("utf8");
    const rootRelationships = inspected.buffers.get("_rels/.rels")?.toString("utf8");
    const documentXml = inspected.buffers.get("word/document.xml")?.toString("utf8");
    if (!contentTypes || !rootRelationships || !documentXml) throw nativeDocxInvalid();
    const parsedContentTypes = parseXmlToJson(contentTypes);
    const parsedRootRelationships = parseXmlToJson(rootRelationships);
    const parsedDocument = parseXmlToJson(documentXml);
    if (!Object.hasOwn(parsedContentTypes, "Types")
      || !Object.hasOwn(parsedRootRelationships, "Relationships")
      || !Object.keys(parsedDocument).some((name) => name === "document" || name.endsWith(":document"))) {
      throw nativeDocxInvalid();
    }
    const mainOverride = [...contentTypes.matchAll(/<Override\b([^>]*)\/?\s*>/gi)].some((match) =>
      opcAttribute(match[1], "PartName") === "/word/document.xml"
      && opcAttribute(match[1], "ContentType") === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
    const mainRelationship = [...rootRelationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].some((match) =>
      opcAttribute(match[1], "Type").endsWith("/officeDocument")
      && opcAttribute(match[1], "Target") === "word/document.xml"
      && !opcAttribute(match[1], "TargetMode"));
    if (!mainOverride || !mainRelationship) throw nativeDocxInvalid();

    const blipIds = [...documentXml.matchAll(/<a:blip\b[^>]*\br:embed=["']([^"']+)["'][^>]*>/gi)]
      .map((match) => match[1]);
    if (blipIds.length) {
      const documentRelationships = inspected.buffers.get("word/_rels/document.xml.rels")?.toString("utf8");
      if (!documentRelationships) throw nativeDocxInvalid();
      const parsedDocumentRelationships = parseXmlToJson(documentRelationships);
      if (!Object.hasOwn(parsedDocumentRelationships, "Relationships")) throw nativeDocxInvalid();
      const relationships = new Map();
      for (const match of documentRelationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
        const id = opcAttribute(match[1], "Id");
        if (!id || relationships.has(id)) throw nativeDocxInvalid();
        relationships.set(id, {
          type: opcAttribute(match[1], "Type"), target: opcAttribute(match[1], "Target"),
          mode: opcAttribute(match[1], "TargetMode")
        });
      }
      for (const id of blipIds) {
        const relationship = relationships.get(id);
        if (!relationship || relationship.mode || !relationship.type.endsWith("/image")
          || !relationship.target.startsWith("media/") || !safePackageEntry(relationship.target)
          || !inspected.names.has(`word/${relationship.target}`)) throw nativeDocxInvalid();
      }
    }

    const editableText = [...documentXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .some((match) => match[1].replace(/<[^>]+>/g, "").trim().length > 0);
    if (!editableText) {
      const error = new Error("Native PDF conversion produced no editable content.");
      error.code = "PDF_DOCX_NO_EDITABLE_CONTENT";
      throw error;
    }
    return { hasEditableContent: true };
  } catch (error) {
    if (["PDF_DOCX_NO_EDITABLE_CONTENT", "PDF_OFFICE_OUTPUT_INVALID"].includes(error?.code)) throw error;
    throw nativeDocxInvalid();
  }
}

async function convertPdfToDocx(inputPath, outputPath, pages, options = {}) {
  // 优先用文档引擎（docengine convert）做版式还原（段落/表格/图片/字体）；引擎缺失或转换失败时回退到 PDF.js 文字提取。
  const docenginePath = options.docenginePath === undefined ? DOCENGINE_PATH : options.docenginePath;
  if (docenginePath) {
    try {
      await withAttemptOutput(outputPath, async (attemptPath) => {
        await (options.run || run)(docenginePath, ["convert", inputPath, attemptPath], { timeout: 1000 * 60 * 10 });
        return (options.validateNativeDocx || validateNativePdfDocx)(attemptPath);
      });
      return;
    } catch (error) {
      await (options.convertStructuredPdf || convertStructuredPdf)({
        inputPath, outputPath, target: "docx", options
      });
      return;
    }
  }

  const source = pages || await extractPdfRowsByPage(inputPath);
  const hasExtractableRows = source.some((page) => page.rows.length);
  if (!hasExtractableRows) {
    throw new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF。扫描版需要 OCR 后才能转 Word。");
  }

  const body = [];
  for (const page of source) {
    body.push(xmlDocxParagraph(page.name, true));
    const multiColumnRows = page.rows.filter((row) => row.length > 1);
    const singleRows = page.rows.filter((row) => row.length <= 1);
    if (multiColumnRows.length) {
      body.push("<w:tbl>");
      for (const row of multiColumnRows) {
        body.push("<w:tr>");
        for (const cell of row) {
          body.push(`<w:tc><w:p><w:r><w:t xml:space="preserve">${xmlDocxText(cell)}</w:t></w:r></w:p></w:tc>`);
        }
        body.push("</w:tr>");
      }
      body.push("</w:tbl>");
    }
    for (const row of singleRows) {
      body.push(xmlDocxParagraph(row[0] || ""));
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join("\n")}
<w:sectPr/>
</w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  await writeDocxZip(outputPath, [
    { path: "[Content_Types].xml", content: contentTypes },
    { path: "_rels/.rels", content: rels },
    { path: "word/document.xml", content: documentXml }
  ]);
}

async function splitPdfToZip(inputPath, outputPath) {
  const src = await PDFDocument.load(await fsp.readFile(inputPath), { ignoreEncryption: true });
  assertPdfPages(src.getPageCount());
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-split-"));
  try {
    const entries = [];
    for (let index = 0; index < src.getPageCount(); index += 1) {
      const single = await PDFDocument.create();
      const [page] = await single.copyPages(src, [index]);
      single.addPage(page);
      const pagePath = path.join(tempDir, `page-${String(index + 1).padStart(3, "0")}.pdf`);
      await fsp.writeFile(pagePath, await single.save());
      entries.push({ inputPath: pagePath, archiveName: `page-${String(index + 1).padStart(3, "0")}.pdf` });
    }
    if (!entries.length) {
      throw new Error("PDF 拆分失败，未生成任何页面。");
    }
    await zipFiles(entries, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function mergePdfFiles(pdfFiles, outputPath) {
  const merged = await PDFDocument.create();
  let totalPages = 0;
  for (const file of pdfFiles) {
    const src = await PDFDocument.load(await fsp.readFile(file.inputPath), { ignoreEncryption: true });
    totalPages += src.getPageCount();
    assertPdfPages(totalPages);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  const bytes = await merged.save();
  if (!bytes.length) {
    throw new Error("PDF 合并失败，未生成任何内容。");
  }
  await fsp.writeFile(outputPath, bytes);
}

async function renderPdfPages(inputPath, target = "png", dpi = 150, { ocr = false } = {}) {
  const sourcePdf = await PDFDocument.load(await fsp.readFile(inputPath), { ignoreEncryption: true });
  assertPdfPages(sourcePdf.getPageCount(), { ocr });
  if (!(await commandExists(PDFTOPPM_PATH, ["-v"]))) {
    throw new Error("PDF 转图片引擎未启用。请确认安装包内置的 Poppler 文件完整。");
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-pages-"));
  try {
    const prefix = path.join(tempDir, "page");
    const formatArg = target === "jpg" ? "-jpeg" : "-png";
    await run(PDFTOPPM_PATH, [formatArg, "-cropbox", "-r", String(dpi), inputPath, prefix], { timeout: 1000 * 60 * 20 });
    const ext = target === "jpg" ? ".jpg" : ".png";
    const files = (await fsp.readdir(tempDir))
      .filter((file) => file.toLowerCase().endsWith(ext))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((file) => path.join(tempDir, file));

    if (!files.length) throw new Error("PDF 转图片失败，未生成任何页面图片。");
    return { tempDir, files };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function convertPdfPagesToImagesZip(inputPath, outputPath, target) {
  const rendered = await renderPdfPages(inputPath, target, 300);
  try {
    await zipFiles(
      rendered.files.map((file, index) => ({
        inputPath: file,
        archiveName: `page-${String(index + 1).padStart(3, "0")}.${target}`
      })),
      outputPath
    );
  } finally {
    await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertScannedPdfToOcrText(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const combined = pages.map((page) => `## ${page.name}\n${page.text || "[OCR 未识别出文字]"}`).join("\n\n").trim();
  await fsp.writeFile(outputPath, `${combined}\n`, "utf8");
}

// 扫描版 PDF -> Word：OCR 识别每页文字，生成可编辑 DOCX（纯文本段落）。
async function convertScannedPdfToOcrDocx(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const combined = pages.map((page) => `## ${page.name}\n${page.text || "[OCR 未识别出文字]"}`).join("\n\n");
  const { convertTextToDocx } = require("./text-docx");
  await convertTextToDocx(combined, "txt", outputPath);
}

// 扫描版 PDF -> HTML：OCR 识别每页文字，生成可读 HTML。
async function convertScannedPdfToOcrHtml(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const body = pages.map((page) =>
    `<h2>${escapeHtml(page.name)}</h2>\n<p>${escapeHtml(page.text || "[OCR 未识别出文字]").replace(/\n/g, "<br>\n")}</p>`
  ).join("\n");
  await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PDF OCR 文本</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6}
h2{color:#333;border-bottom:1px solid #ddd;padding-bottom:4px}
</style>
</head>
<body>
${body}
</body>
</html>`, "utf8");
}

// OCR 扫描版 PDF 的每一页，返回 [{ name, text }]；OCR 不可用或完全识别不出时抛明确错误。
async function ocrScannedPdfPages(inputPath) {
  if (!ocrAvailable()) {
    const error = new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF，需要 OCR 识别后才能转换，但 OCR 引擎未启用。");
    error.code = "PDF_OCR_REQUIRED";
    error.messages = {
      zhCN: "这个 PDF 没有可提取的文字，可能是扫描版图片 PDF，需要 OCR 识别后才能转换，但 OCR 引擎未启用。",
      enUS: "This PDF has no extractable text; it may be a scanned image PDF that requires OCR, but the OCR engine is not available."
    };
    throw error;
  }

  const rendered = await renderPdfPages(inputPath, "png", 300, { ocr: true });
  let worker = null;
  try {
    worker = await createOcrWorker();
    const pages = [];
    for (let index = 0; index < rendered.files.length; index += 1) {
      const text = await recognizeImageTextWithWorker(worker, rendered.files[index]);
      pages.push({ name: `Page ${index + 1}`, text: String(text || "").trim() });
    }
    if (!pages.some((page) => page.text)) {
      throw new Error("OCR 没有识别出文字。请确认 PDF 扫描页清晰、文字方向正确。");
    }
    return pages;
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 演示文稿 -> 图片：LibreOffice 转 PDF 后按页渲染为 PNG/JPG（依赖第四批 office-convert.js）。
async function convertPresentationToImages(inputPath, outputPath, originalName, target) {
  const { convertWithLibreOffice } = require("./office-convert");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ppt-images-"));
  try {
    const pdfPath = path.join(tempDir, "slides.pdf");
    await convertWithLibreOffice(inputPath, pdfPath, originalName, "pdf");
    await convertPdfPagesToImagesZip(pdfPath, outputPath, target);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 演示文稿 -> HTML：LibreOffice 的 pptx->html 导出过滤器在本便携版只输出空页面框架，
// 因此改为 LO 转 PDF 后用 PDF.js 提取每页文字，生成带标题的可读 HTML。
async function convertPresentationToHtml(inputPath, outputPath, originalName) {
  const { convertWithLibreOffice } = require("./office-convert");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ppt-html-"));
  try {
    const pdfPath = path.join(tempDir, "slides.pdf");
    await convertWithLibreOffice(inputPath, pdfPath, originalName, "pdf");
    const pages = await extractPdfRowsByPage(pdfPath);
    const visibleText = pages.flatMap((page) => page.rows.flat()).join(" ").trim();
    if (!visibleText) {
      throw new OfficeQualityError("PRESENTATION_HTML_EMPTY", {
        zhCN: "演示文稿 HTML 导出失败：未提取到任何幻灯片文字。请确认幻灯片是文字版而不是纯图片。",
        enUS: "Presentation HTML export failed: no slide text was extracted. Make sure the slides contain text, not only images."
      });
    }
    const body = pages.map((page) =>
      `<h2>${escapeHtml(page.name)}</h2>\n${page.rows.map((row) => `<p>${escapeHtml(row.join(" "))}</p>`).join("\n")}`
    ).join("\n");
    await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(safeBaseName(originalName))}</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6}
h2{color:#333;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px}
</style>
</head>
<body>
${body}
</body>
</html>`, "utf8");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertZipImagesToPdf(inputPath, outputPath) {
  const zipfile = await openZipEntries(inputPath);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-zip-images-"));
  const imageExts = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tiff", "tif"]);
  try {
    const images = [];
    const pending = new Promise((resolve, reject) => {
      zipfile.on("entry", (entry) => {
        const baseName = path.posix.basename(entry.fileName);
        const ext = path.posix.extname(baseName).toLowerCase().replace(".", "");
        const safeName = sanitize(baseName) || `file-${images.length}`;
        if (imageExts.has(ext) && !entry.fileName.includes("..")) {
          const outPath = path.join(tempDir, `${images.length}-${safeName}`);
          readZipEntryToFile(zipfile, entry, outPath)
            .then(() => {
              images.push({ inputPath: outPath, originalName: safeName });
              zipfile.readEntry();
            })
            .catch(reject);
          return;
        }
        zipfile.readEntry();
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolve();
      });
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
    await pending;
    if (!images.length) {
      throw new Error("ZIP 内没有找到可合并为 PDF 的图片（支持 png/jpg/webp/gif/bmp/avif/tiff）。");
    }
    await convertImagesToPdf(images, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  convertPdfDecrypt,
  assertPdfTableOcrQuality,
  convertStructuredPdf,
  convertPdf,
  xmlDocxText,
  xmlDocxParagraph,
  writeDocxZip,
  convertPdfToDocx,
  validateNativePdfDocx,
  splitPdfToZip,
  mergePdfFiles,
  renderPdfPages,
  convertPdfPagesToImagesZip,
  convertScannedPdfToOcrText,
  convertScannedPdfToOcrDocx,
  convertScannedPdfToOcrHtml,
  ocrScannedPdfPages,
  convertPresentationToImages,
  convertPresentationToHtml,
  convertZipImagesToPdf
};
