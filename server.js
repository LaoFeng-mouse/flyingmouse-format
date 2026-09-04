const { randomUUID } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { fileURLToPath, pathToFileURL } = require("url");
const express = require("express");
const mime = require("mime-types");
const multer = require("multer");
const sanitize = require("sanitize-filename");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const yazl = require("yazl");
const yauzl = require("yauzl");
const { PDFDocument } = require("pdf-lib");

const { createTurndownService, htmlToMarkdown, markdownToHtml, csvToJsonObjects, jsonToCsv, csvToMarkdown, csvToHtmlTable } = require("./text-conversion");
const { convertRasterImage } = require("./image-conversion");
const { isBmpFileSync, decodeBmpToRaw } = require("./bmp-input");
const { xmlToJson } = require("./xml-json");
const { convertEbook, convertTextToEpub } = require("./ebook");
const yaml = require("js-yaml");
const {
  LIMITS,
  ResourceLimitError,
  assertImageMetadata,
  assertImagePdfBudget,
  assertBatchBytes,
  assertPdfPages
} = require("./resource-policy");
const { buildPdfTableWorkbook, detectTableLinesFromRaw } = require("./pdf-table-runtime");
const { convertOfdToPdf } = require("./ofd-convert");
const { OfficeEngineError, probeLibreOffice, runLibreOffice } = require("./office-engine");
const { inspectXlsxForCsv } = require("./office-quality");
const logger = require("./logger");

// Prefer the Electron main process's debug.log (set via FLYINGMOUSE_LOG_FILE
// or setLogFile); standalone `node server.js` falls back to a temp file.
if (process.env.FLYINGMOUSE_LOG_FILE) {
  logger.setLogFile(process.env.FLYINGMOUSE_LOG_FILE);
}

const config = require("./config");
const {
  ensureDirs,
  run,
  commandExists,
  extFromName,
  decodeUploadFileName,
  normalizeExt,
  categoryForExt,
  targetsForExt,
  platformCapabilities,
  experimentalInputWarning,
  safeBaseName,
  outputExtFor,
  outputNameFor,
  outputPathFor,
  registerDownload,
  escapeHtml
} = require("./utils");
const { convertMedia, probeAudioTrack } = require("./media");
const { zipFiles, openZipEntries, readZipEntryToFile, listZipEntries } = require("./zip-util");
const {
  convertPdfDecrypt,
  assertPdfTableOcrQuality,
  convertPdf,
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
} = require("./pdf");
const {
  htmlToText,
  escapeXml,
  mdInlineRuns,
  docxRunXml,
  docxParagraphXml,
  splitHtmlIntoLines,
  convertTextToDocx,
  parseJsonText,
  convertText,
  convertCsvToXlsx,
  convertCsvToPdf,
  parseCsvRecords,
  readTabularText
} = require("./text-docx");
const {
  libreOfficeFilterFor,
  findConvertedFile,
  convertWithLibreOffice,
  convertDocumentToMarkdown,
  convertDocumentToText
} = require("./office-convert");
const {
  convertImage,
  prepareImageInput,
  isHeicFileSync,
  inspectImageMetadata,
  convertImageToVideo,
  pdfAscii,
  pdfNumber,
  readImageForPdf,
  readPngAsPdfImage,
  convertImagesToPdf
} = require("./image");
const {
  ocrAvailable,
  createOcrWorker,
  recognizeImageTextWithWorker,
  convertImageToOcrText
} = require("./ocr");
const {
  normalizePdfjsEntry,
  isMissingPdfjsEntry,
  resolvePdfjsEntrySpecifiers,
  loadPdfjsModule,
  createPdfjsLoader,
  loadPdfjs
} = require("./pdfjs");
const {
  groupPdfItemsIntoRows,
  extractPdfRowsByPage,
  sheetName,
  applyColumnWidths,
  renderPdfTablePage,
  preparePdfTableOcrImage,
  recognizePdfTablePage,
  extractComplexPdfTableModel,
  addPdfTableNotes,
  writePdfTableWorkbook
} = require("./pdf-table");
const {
  ROOT,
  DEFAULT_PORT,
  RUNTIME_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR,
  MAX_UPLOAD_BYTES,
  FFMPEG_PATH,
  LIBREOFFICE_PATH,
  PDFTOPPM_PATH,
  TESSDATA_PATH,
  DCRAW_PATH,
  imageInput,
  rawInput,
  imageFormatTargets,
  imageVideoTargets,
  imageOcrTargets,
  imageTargets,
  textInput,
  textTargets,
  documentInput,
  documentTargets,
  spreadsheetInput,
  spreadsheetTargets,
  presentationInput,
  presentationTargets,
  pdfInput,
  pdfTextTargets,
  pdfImageTargets,
  audioInput,
  videoInput,
  mediaAudioTargets,
  mediaVideoTargets,
  mediaTargets,
  experimentalInputsByCategory,
  experimentalInputSet,
  allTargets,
  downloads
} = require("./config");

const app = express();
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

let cachedTesseract = null;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

async function cleanupOldFiles() {
  const cutoff = Date.now() - 1000 * 60 * 60;
  for (const [id, item] of downloads.entries()) {
    if (item.createdAt < cutoff) downloads.delete(id);
  }
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(dir, file);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fsp.rm(filePath, { force: true }).catch(() => {});
      }
    }));
  }
}

// md 转换产物若带图片外置目录（<下载名>.assets/），返回该目录路径；否则 null。
// 目录名基于 downloadName（与 office-convert 的 outputNameFor(originalName,"md") 一致），
// 不能用 mdPath 前缀（outputPath 带时间戳-uuid，会找不到）。
async function findMarkdownAssetsDir(mdPath, downloadName) {
  const mdBasename = path.basename(downloadName, path.extname(downloadName));
  const assetsDir = path.join(path.dirname(mdPath), `${mdBasename}.assets`);
  try {
    const stat = await fsp.stat(assetsDir);
    if (stat.isDirectory()) return assetsDir;
  } catch {
    // no assets dir
  }
  return null;
}

// 列出 assets 目录内的文件，生成相对 md 下载 URL 的资产清单。
async function listDownloadAssets(assetsDir, downloadUrl) {
  const names = await fsp.readdir(assetsDir).catch(() => []);
  const assets = [];
  for (const name of names) {
    const filePath = path.join(assetsDir, name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    assets.push({
      name,
      url: `${downloadUrl}/asset/${encodeURIComponent(name)}`
    });
  }
  return assets;
}

let cachedTools = null;
let cachedToolDetails = {};

async function getTools() {
  if (!cachedTools) {
    let officeProbe = null;
    try {
      officeProbe = await probeLibreOffice(LIBREOFFICE_PATH, { runtimeDir: RUNTIME_DIR });
      cachedToolDetails.libreoffice = officeProbe;
    } catch (error) {
      cachedToolDetails.libreoffice = {
        enabled: false,
        errorCode: error.code || "OFFICE_ENGINE_START_FAILED",
        messages: error.messages
      };
      logger.warn("LibreOffice capability probe failed", error);
    }
    cachedTools = {
      ffmpeg: await commandExists(FFMPEG_PATH),
      libreoffice: Boolean(officeProbe?.enabled),
      poppler: await commandExists(PDFTOPPM_PATH, ["-v"]),
      ocr: ocrAvailable(),
      pdf: true,
      sharp: true
    };
  }
  return cachedTools;
}

async function getToolDiagnostics() {
  const tools = await getTools();
  return {
    ffmpeg: { enabled: tools.ffmpeg, executable: FFMPEG_PATH },
    libreoffice: { ...cachedToolDetails.libreoffice, executable: LIBREOFFICE_PATH },
    poppler: { enabled: tools.poppler, executable: PDFTOPPM_PATH },
    ocr: { enabled: tools.ocr, version: require("tesseract.js/package.json").version },
    pdfjs: { enabled: tools.pdf, version: require("pdfjs-dist/package.json").version },
    sharp: { enabled: tools.sharp, version: sharp.versions.sharp }
  };
}

function isLocalWebOrigin(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1");
  } catch {
    return false;
  }
}

function assertLocalWebRequest(req, res, next) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin && !isLocalWebOrigin(origin)) {
    res.status(403).json({ error: "拒绝跨站请求。" });
    return;
  }
  if (referer && !isLocalWebOrigin(referer)) {
    res.status(403).json({ error: "拒绝跨站请求。" });
    return;
  }
  next();
}

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
});
app.use(express.static(path.join(ROOT, "public")));
app.use(express.json());

function resourceErrorPayload(error) {
  return {
    error: error.message,
    errorCode: error.errorCode,
    messages: error.messages,
    details: error.details
  };
}

function sendResourceError(res, error) {
  if (!(error instanceof ResourceLimitError)) return false;
  res.status(413).json(resourceErrorPayload(error));
  return true;
}

app.get("/api/capabilities", async (_req, res) => {
  const tools = await getTools();
  res.json({
    tools,
    platform: platformCapabilities(),
    toolDetails: cachedToolDetails,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    limits: LIMITS,
    groups: {
      image: { inputs: [...imageInput, ...(DCRAW_PATH ? rawInput : [])].sort(), targets: [...imageFormatTargets, ...(tools.ffmpeg ? imageVideoTargets : []), ...(tools.ocr ? imageOcrTargets : [])], experimentalInputs: [...(experimentalInputsByCategory.image || []), ...(DCRAW_PATH ? rawInput : [])].sort() },
      text: { inputs: [...textInput].sort(), targets: [...textTargets, ...(tools.libreoffice ? ["pdf"] : []), "docx"] },
      document: { inputs: [...documentInput].sort(), targets: documentTargets, experimentalInputs: experimentalInputsByCategory.document },
      spreadsheet: { inputs: [...spreadsheetInput].sort(), targets: spreadsheetTargets, experimentalInputs: experimentalInputsByCategory.spreadsheet },
      presentation: { inputs: [...presentationInput].sort(), targets: presentationTargets, experimentalInputs: experimentalInputsByCategory.presentation },
      pdf: { inputs: [...pdfInput].sort(), targets: [...pdfTextTargets, ...(tools.poppler ? [...pdfImageTargets, "pdf"] : [])] },
      audio: { inputs: [...audioInput].sort(), targets: mediaAudioTargets, experimentalInputs: experimentalInputsByCategory.audio },
      video: { inputs: [...videoInput].sort(), targets: mediaTargets },
      any: { inputs: ["*"], targets: [] }
    },
    optional: [
      { name: "LibreOffice", enabled: tools.libreoffice, formats: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "wps", "pdf"] },
      { name: "PDF table extractor", enabled: tools.pdf, formats: ["pdf", "xlsx", "txt", "html"] },
      { name: "Poppler PDF renderer", enabled: tools.poppler, formats: ["pdf", "png", "jpg"] },
      { name: "Tesseract OCR", enabled: tools.ocr, formats: ["image", "pdf", "txt"] }
    ]
  });
});

app.post("/api/targets", async (req, res) => {
  const tools = await getTools();
  const ext = normalizeExt(String(req.body?.extension || "").toLowerCase());
  res.json({ extension: ext, category: categoryForExt(ext), targets: targetsForExt(ext, tools), experimental: experimentalInputSet.has(ext) });
});

app.post("/api/convert-images-to-pdf", assertLocalWebRequest, upload.array("files"), async (req, res) => {
  const files = req.files || [];

  try {
    assertBatchBytes(files);
  } catch (error) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    if (sendResourceError(res, error)) return;
    throw error;
  }

  if (!files.length) {
    res.status(400).json({ error: "请先选择要合并为 PDF 的图片。" });
    return;
  }

  const imageFiles = files.map((file) => {
    const originalName = decodeUploadFileName(file.originalname);
    return {
      inputPath: file.path,
      originalName,
      category: categoryForExt(normalizeExt(extFromName(originalName)))
    };
  });

  // 空白页：前端队列里插入的空白页条目。blanks=0,3 表示在上传文件流（不含
  // 空白页）的第 0 个文件之前、第 3 个文件之后插入空白页；从后往前插入避免
  // 索引错位，PDF 生成时空白页输出纯白 A4 页。
  const blankAfter = new Set(
    String(req.body?.blanks || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map(Number)
      .filter((item) => Number.isFinite(item) && item >= 0 && item <= imageFiles.length)
  );
  for (const blankIndex of [...blankAfter].sort((a, b) => b - a)) {
    imageFiles.splice(blankIndex, 0, { inputPath: "", originalName: "", category: "image", blank: true });
  }

  if (imageFiles.some((file) => file.category !== "image")) {
    logger.warn(`Rejected images-to-pdf: non-image file included (${imageFiles.map((f) => f.originalName).join(", ")})`);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    res.status(400).json({ error: "批量合并 PDF 只支持图片文件。请先移除非图片文件。" });
    return;
  }

  const firstBaseName = safeBaseName(imageFiles[0].originalName);
  // 拖入文件夹/选择目录转 PDF 时直接用文件夹名命名（folderName 由前端从
  // webkitRelativePath 或目录选择器传入），否则沿用「第一个文件等N个文件」。
  const folderName = String(req.body?.folderName || "").trim();
  const pdfBaseName = folderName ? safeBaseName(folderName) : firstBaseName;
  const combinedName = folderName
    ? `${pdfBaseName}.pdf`
    : (imageFiles.length > 1 ? `${firstBaseName}等${imageFiles.length}个文件.pdf` : `${firstBaseName}.pdf`);
  const outputPath = outputPathFor(combinedName, "pdf");
  const downloadName = outputNameFor(combinedName, "pdf");
  logger.info(`Images-to-PDF request: ${imageFiles.length} image(s) -> "${downloadName}"`);

  try {
    await convertImagesToPdf(imageFiles, outputPath);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    const mimeType = "application/pdf";
    logger.info(`Images-to-PDF succeeded: "${downloadName}"`);
    const registered = registerDownload(outputPath, downloadName, mimeType);
    const previewSize = (await fsp.stat(outputPath)).size;
    res.json({
      ok: true,
      fileName: downloadName,
      category: "image",
      mimeType,
      ...registered,
      previewSize
    });
  } catch (error) {
    logger.error(`Images-to-PDF failed: "${combinedName}"`, error);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    if (!sendResourceError(res, error)) res.status(500).json({ error: error.message || "图片合并 PDF 失败。" });
  }
});

app.post("/api/merge-pdfs", assertLocalWebRequest, upload.array("files"), async (req, res) => {
  const files = req.files || [];

  try {
    assertBatchBytes(files);
  } catch (error) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    if (sendResourceError(res, error)) return;
    throw error;
  }

  if (!files.length) {
    res.status(400).json({ error: "请先选择要合并的 PDF 文件。" });
    return;
  }

  const pdfFiles = files.map((file) => ({
    inputPath: file.path,
    originalName: decodeUploadFileName(file.originalname)
  }));

  if (pdfFiles.some((file) => normalizeExt(extFromName(file.originalName)) !== "pdf")) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    res.status(400).json({ error: "批量合并 PDF 只支持 PDF 文件。请先移除非 PDF 文件。" });
    return;
  }

  const firstBaseName = safeBaseName(pdfFiles[0].originalName);
  const combinedName = pdfFiles.length > 1 ? `${firstBaseName}等${pdfFiles.length}个文件.pdf` : `${firstBaseName}.pdf`;
  const outputPath = outputPathFor(combinedName, "pdf");
  const downloadName = outputNameFor(combinedName, "pdf");
  logger.info(`Merge-PDFs request: ${pdfFiles.length} PDF(s) -> "${downloadName}"`);

  try {
    await mergePdfFiles(pdfFiles, outputPath);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    logger.info(`Merge-PDFs succeeded: "${downloadName}"`);
    const mimeType = "application/pdf";
    const registered = registerDownload(outputPath, downloadName, mimeType);
    const previewSize = (await fsp.stat(outputPath)).size;
    res.json({
      ok: true,
      fileName: downloadName,
      category: "pdf",
      mimeType,
      ...registered,
      previewSize
    });
  } catch (error) {
    logger.error(`Merge-PDFs failed: "${combinedName}"`, error);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    if (!sendResourceError(res, error)) res.status(500).json({ error: error.message || "合并 PDF 失败。" });
  }
});

app.post("/api/convert", assertLocalWebRequest, upload.single("file"), async (req, res) => {
  const tools = await getTools();
  const file = req.file;
  const originalName = decodeUploadFileName(file?.originalname);
  const requestedTarget = normalizeExt(String(req.body.targetFormat || "").toLowerCase());

  if (!file) {
    res.status(400).json({ error: "请先选择一个文件。" });
    return;
  }

  if (!allTargets.has(requestedTarget)) {
    logger.warn(`Rejected convert request: unsupported target "${requestedTarget}" for "${originalName}"`);
    await fsp.rm(file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: "目标格式暂不支持。", errorCode: "UNSUPPORTED_TARGET" });
    return;
  }

  const inputExt = normalizeExt(extFromName(originalName));
  const category = categoryForExt(inputExt);
  const allowedTargets = targetsForExt(inputExt, tools);
  logger.info(`Convert request: "${originalName}" (${inputExt}/${category}) -> ${requestedTarget} (${file.size} bytes)`);

  if (!allowedTargets.includes(requestedTarget)) {
    logger.warn(`Rejected convert request: ${category} file "${originalName}" cannot target ${requestedTarget}`);
    await fsp.rm(file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: "这个源文件暂时不能转换成所选格式。", errorCode: "TARGET_UNAVAILABLE_FOR_SOURCE" });
    return;
  }

  const outputExt = outputExtFor(category, requestedTarget);
  const pdfAction = String(req.body?.pdfAction || "");
  // PDF→PDF 的加密/解密输出单个 .pdf，拆分输出 .pdf.zip（打包多页）
  const effectiveOutputExt = (category === "pdf" && requestedTarget === "pdf" && (pdfAction === "encrypt" || pdfAction === "decrypt"))
    ? "pdf"
    : outputExt;
  const outputPath = outputPathFor(originalName, requestedTarget, effectiveOutputExt);
  const downloadName = outputNameFor(originalName, requestedTarget, effectiveOutputExt);
  let conversionResult = { warnings: [] };

  try {
    if (category === "image") {
      conversionResult = await convertImage(file.path, outputPath, requestedTarget);
    } else if (category === "text") {
      if (["epub", "mobi"].includes(inputExt)) {
        await convertEbook(file.path, outputPath, inputExt, requestedTarget, originalName);
      } else if (requestedTarget === "epub") {
        await convertTextToEpub(await fsp.readFile(file.path, "utf8"), inputExt, originalName, outputPath);
      } else {
        conversionResult = await convertText(file.path, outputPath, inputExt, requestedTarget, originalName);
      }
    } else if (category === "pdf") {
      await convertPdf(file.path, outputPath, requestedTarget, {
        pdfAction,
        password: String(req.body?.password || ""),
        splitMode: String(req.body?.splitMode || "page"),
        groupSize: String(req.body?.groupSize || "1")
      });
    } else if (category === "zip") {
      await convertZipImagesToPdf(file.path, outputPath);
    } else if (category === "spreadsheet" && ["csv", "tsv"].includes(inputExt) && ["txt", "md", "json"].includes(requestedTarget)) {
      conversionResult = await convertText(file.path, outputPath, inputExt, requestedTarget, originalName);
    } else if (category === "spreadsheet" && ["csv", "tsv"].includes(inputExt) && ["epub", "xlsx", "html", "pdf"].includes(requestedTarget)) {
      // LO 的 csv/tsv 导入过滤器 headless 下假成功（exit 0 零输出），全部用自有实现
      const tabular = await readTabularText(file.path, inputExt);
      if (requestedTarget === "epub") await convertTextToEpub(tabular, "csv", originalName, outputPath);
      else if (requestedTarget === "xlsx") await convertCsvToXlsx(tabular, outputPath);
      else if (requestedTarget === "html") await fsp.writeFile(outputPath, csvToHtmlTable(tabular), "utf8");
      else await convertCsvToPdf(tabular, outputPath);
    } else if (category === "document" || category === "spreadsheet" || category === "presentation") {
      if (inputExt === "ofd") {
        // OFD（国标 GB/T 33190）走自有链路（ofd-convert.js → PDF），LibreOffice 打不开。
        // targetsForExt 已把 ofd 的目标限定为 pdf/zip，zip 在顶部分支处理，此处必为 pdf。
        // originalName 用于扩展名校验（multer 临时文件无扩展名）。
        await convertOfdToPdf(file.path, outputPath, originalName);
      } else if (category === "presentation" && ["png", "jpg"].includes(requestedTarget)) {
        await convertPresentationToImages(file.path, outputPath, originalName, requestedTarget);
      } else if (category === "presentation" && requestedTarget === "html") {
        await convertPresentationToHtml(file.path, outputPath, originalName);
      } else if (category === "document" && requestedTarget === "md") {
        await convertDocumentToMarkdown(file.path, outputPath, inputExt, originalName);
      } else if (category === "document" && requestedTarget === "txt") {
        await convertDocumentToText(file.path, outputPath, inputExt, originalName);
      } else {
        if (category === "spreadsheet" && inputExt === "xlsx" && requestedTarget === "csv") {
          conversionResult = await inspectXlsxForCsv(file.path);
        }
        await convertWithLibreOffice(file.path, outputPath, originalName, requestedTarget);
      }
    } else if (category === "audio" || category === "video") {
      const videoCodec = ["h264", "h265", "av1"].includes(String(req.body?.videoCodec || ""))
        ? String(req.body.videoCodec)
        : "h264";
      // 透明背景色：white / black / 十六进制色值（白名单在 alphaCompositeArgs 内校验）。
      const alphaBackground = String(req.body?.alphaBackground || "").trim() || "white";
      await convertMedia(file.path, outputPath, requestedTarget, category, { videoCodec, alphaBackground });
    } else {
      throw new Error("暂时无法识别这个文件类型。");
    }

    await fsp.rm(file.path, { force: true }).catch(() => {});
    const mimeType = mime.lookup(downloadName) || "application/octet-stream";
    // md 转换产物若带图片外置目录（.assets/），随 downloads 一起注册，
    // 保存时主进程按 assets 清单把图片拷到 md 同目录，保证相对引用可用。
    let mdAssetsDir = null;
    if (requestedTarget === "md" && category === "document") {
      mdAssetsDir = await findMarkdownAssetsDir(outputPath, downloadName);
    }
    const registered = registerDownload(outputPath, downloadName, mimeType, { assetsDir: mdAssetsDir });
    if (mdAssetsDir) registered.assets = await listDownloadAssets(mdAssetsDir, registered.downloadUrl);
    const previewSize = (await fsp.stat(outputPath)).size;
    const payload = {
      ok: true,
      fileName: downloadName,
      category,
      mimeType,
      ...registered,
      previewSize
    };
    if (Array.isArray(conversionResult?.warnings) && conversionResult.warnings.length) {
      payload.warnings = conversionResult.warnings;
    }
    if (experimentalInputSet.has(inputExt)) {
      payload.warnings = [...(payload.warnings || []), experimentalInputWarning(inputExt)];
    }
    logger.info(`Convert succeeded: "${originalName}" -> ${downloadName} (${requestedTarget})`);
    res.json(payload);
  } catch (error) {
    const isClientConversionError = [
      "CSV_PARSE_FAILED",
      "PDF_TABLE_OCR_REQUIRED",
      "PDF_TABLE_OCR_EMPTY",
      "MEDIA_NO_AUDIO_TRACK",
      "PDF_OCR_REQUIRED",
      "XML_JSON_PARSE_FAILED",
      "YAML_JSON_PARSE_FAILED",
      "PDF_ENCRYPT_UNAVAILABLE",
      "PDF_ENCRYPT_NO_PASSWORD",
      "PRESENTATION_HTML_EMPTY",
      "BMP_UNSUPPORTED_VARIANT",
      "JSON_CSV_PATH_COLLISION",
      "PDF_TABLE_OCR_LOW_QUALITY"
    ].includes(error?.code);
    const isResourceLimitError = error instanceof ResourceLimitError;
    const isOfficeEngineError = error instanceof OfficeEngineError;
    if (isClientConversionError || isResourceLimitError) logger.warn(`Convert rejected: "${originalName}" -> ${requestedTarget}`, error);
    else logger.error(`Convert failed: "${originalName}" -> ${requestedTarget}`, error);
    await fsp.rm(file.path, { force: true }).catch(() => {});
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    const payload = isResourceLimitError ? resourceErrorPayload(error) : { error: error.message || "转换失败。" };
    if (error?.code) payload.errorCode = error.code;
    if (error?.messages) payload.messages = error.messages;
    if (isOfficeEngineError) {
      payload.messages = error.messages;
      payload.details = error.details;
    }
    res.status(isResourceLimitError ? 413 : (isClientConversionError ? 422 : 500)).json(payload);
  }
});

app.get("/downloads/:id", (req, res) => {
  const item = downloads.get(req.params.id);
  if (!item) {
    res.status(404).send("File expired or not found.");
    return;
  }

  res.download(item.filePath, item.downloadName, (error) => {
    if (!error) return;
    if (!res.headersSent) res.status(500).send(error.message);
  });
});

// md 转换产物的图片外置文件下载：/downloads/<id>/asset/<name>。
// 只允许读取该 downloads 条目登记的 assets 目录内的文件，防止路径穿越。
app.get("/downloads/:id/asset/:name", async (req, res) => {
  const item = downloads.get(req.params.id);
  if (!item || !/^[A-Za-z0-9-]+$/.test(req.params.id)) {
    res.status(404).send("File expired or not found.");
    return;
  }
  const assetsDir = item.assetsDir;
  if (!assetsDir) {
    res.status(404).send("No assets for this download.");
    return;
  }
  const name = String(req.params.name || "");
  if (!name || name.includes("\\") || name.includes("/") || name === "." || name === "..") {
    res.status(400).send("Invalid asset name.");
    return;
  }
  const filePath = path.join(assetsDir, name);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.status(404).send("Asset not found.");
    return;
  }
  res.download(filePath, name, (error) => {
    if (!error) return;
    if (!res.headersSent) res.status(500).send(error.message);
  });
});

app.get("/previews/:id", (req, res) => {
  const item = downloads.get(req.params.id);
  if (!item || !/^[A-Za-z0-9-]+$/.test(req.params.id) || req.originalUrl.includes("?")) {
    res.status(404).send("File expired or not found.");
    return;
  }
  const inlineName = encodeURIComponent(path.basename(item.downloadName)).replaceAll("'", "%27");
  res.setHeader("Content-Type", item.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="preview"; filename*=UTF-8''${inlineName}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (String(item.mimeType).includes("html")) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox");
  } else {
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
  }
  res.sendFile(path.resolve(item.filePath), (error) => {
    if (!error) return;
    if (!res.headersSent) res.status(500).send(error.message);
  });
});

app.use((error, _req, res, _next) => {
  if (error?.code === "LIMIT_FILE_SIZE") {
    logger.warn(`Rejected upload: file too large (max ${MAX_UPLOAD_BYTES} bytes)`);
    res.status(413).json({ error: "文件太大，无法上传。请检查磁盘空间后重试。" });
    return;
  }
  logger.error("Unhandled server error", error);
  res.status(500).json({ error: error.message || "服务器出错。" });
});

let cleanupTimer = null;

function startServer(port = DEFAULT_PORT) {
  ensureDirs();
  logger.info(`Server starting (runtime dir: ${RUNTIME_DIR}, engines: ffmpeg=${FFMPEG_PATH}, libreoffice=${LIBREOFFICE_PATH}, poppler=${PDFTOPPM_PATH}, tessdata=${TESSDATA_PATH})`);
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupOldFiles, 1000 * 60 * 20);
    cleanupTimer.unref();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      logger.info(`Server listening on http://127.0.0.1:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`
      });
    });
    server.on("error", (error) => {
      logger.error(`Server failed to start on port ${port}`, error);
      reject(error);
    });
  });
}

if (require.main === module) {
  startServer().then(({ url }) => {
    console.log(`Format converter running at ${url}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, startServer, createPdfjsLoader, getToolDiagnostics, isMissingPdfjsEntry, loadPdfjsModule, platformCapabilities, assertPdfTableOcrQuality };
