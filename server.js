const { randomUUID } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { pathToFileURL } = require("url");
const express = require("express");
const mime = require("mime-types");
const multer = require("multer");
const sanitize = require("sanitize-filename");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const yazl = require("yazl");
const { PDFDocument } = require("pdf-lib");
const mammoth = require("mammoth");
const TurndownService = require("turndown");

const ROOT = __dirname;
const DEFAULT_PORT = Number(process.env.PORT || 5177);
const RUNTIME_DIR = process.env.FLYINGMOUSE_RUNTIME_DIR || path.join(os.tmpdir(), "flyingmouse-format-runtime");
const UPLOAD_DIR = path.join(RUNTIME_DIR, "uploads");
const OUTPUT_DIR = path.join(RUNTIME_DIR, "converted");
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const app = express();
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

function bundledFfmpegPath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_FFMPEG_PATH,
    resourcesPath && path.join(resourcesPath, "ffmpeg", "ffmpeg.exe"),
    path.join(ROOT, "bin", "ffmpeg", "ffmpeg.exe"),
    path.join(process.cwd(), "bin", "ffmpeg", "ffmpeg.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "ffmpeg";
}

const FFMPEG_PATH = bundledFfmpegPath();

function bundledLibreOfficePath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_LIBREOFFICE_PATH,
    resourcesPath && path.join(resourcesPath, "libreoffice", "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com"),
    resourcesPath && path.join(resourcesPath, "libreoffice", "App", "libreoffice", "program", "soffice.com"),
    resourcesPath && path.join(resourcesPath, "libreoffice", "program", "soffice.com"),
    path.join(ROOT, "bin", "libreoffice", "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com"),
    path.join(ROOT, "bin", "libreoffice", "App", "libreoffice", "program", "soffice.com"),
    path.join(ROOT, "bin", "libreoffice", "program", "soffice.com"),
    path.join(process.cwd(), "bin", "libreoffice", "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com"),
    "soffice"
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "soffice" || fs.existsSync(candidate)) || "soffice";
}

const LIBREOFFICE_PATH = bundledLibreOfficePath();

function bundledPdftoppmPath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_PDFTOPPM_PATH,
    resourcesPath && path.join(resourcesPath, "poppler", "Library", "bin", "pdftoppm.exe"),
    resourcesPath && path.join(resourcesPath, "poppler", "bin", "pdftoppm.cmd"),
    path.join(ROOT, "bin", "poppler", "Library", "bin", "pdftoppm.exe"),
    path.join(ROOT, "bin", "poppler", "bin", "pdftoppm.cmd"),
    path.join(process.cwd(), "bin", "poppler", "Library", "bin", "pdftoppm.exe"),
    "pdftoppm"
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "pdftoppm" || fs.existsSync(candidate)) || "pdftoppm";
}

const PDFTOPPM_PATH = bundledPdftoppmPath();

function bundledTessdataPath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_TESSDATA_PATH,
    resourcesPath && path.join(resourcesPath, "tessdata"),
    path.join(ROOT, "bin", "tessdata"),
    path.join(process.cwd(), "bin", "tessdata")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "eng.traineddata.gz"))) || candidates[0] || "";
}

const TESSDATA_PATH = bundledTessdataPath();

const imageInput = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "bmp", "heic", "heif"]);
const imageFormatTargets = ["png", "jpg", "webp", "avif", "tiff", "pdf"];
const imageVideoTargets = ["mp4", "webm"];
const imageOcrTargets = ["txt"];
const imageTargets = [...imageFormatTargets, ...imageVideoTargets, ...imageOcrTargets];
const textInput = new Set(["txt", "md", "markdown", "html", "htm", "json", "csv", "log", "xml", "yaml", "yml"]);
const textTargets = ["txt", "md", "html", "json", "csv"];
const documentInput = new Set(["doc", "docx", "odt", "rtf", "wps", "wpt", "wpd"]);
const documentTargets = ["pdf", "docx", "odt", "rtf", "txt", "html", "md"];
const spreadsheetInput = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "et", "ett"]);
const spreadsheetTargets = ["pdf", "xlsx", "ods", "csv", "html"];
const presentationInput = new Set(["ppt", "pptx", "odp", "dps", "dpt"]);
const presentationTargets = ["pdf", "pptx", "odp", "html"];
const pdfInput = new Set(["pdf"]);
const pdfTextTargets = ["xlsx", "txt", "html"];
const pdfImageTargets = ["png", "jpg"];
const pdfTargets = [...pdfTextTargets, ...pdfImageTargets, "pdf"];
const audioInput = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma"]);
const videoInput = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv"]);
const mediaAudioTargets = ["mp3", "wav", "flac", "m4a", "ogg", "aac", "opus", "wma"];
const mediaVideoTargets = ["mp4", "webm", "mkv", "mov"];
const mediaTargets = [...mediaVideoTargets, ...mediaAudioTargets];
const allTargets = new Set([
  ...imageTargets,
  ...textTargets,
  ...documentTargets,
  ...spreadsheetTargets,
  ...presentationTargets,
  ...pdfTargets,
  ...mediaTargets,
  "zip"
]);
const downloads = new Map();
let cachedTesseract = null;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 1000 * 60 * 15 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr || stdout || error.message;
        reject(new Error(detail.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function commandExists(command, versionArgs = ["-version"]) {
  try {
    await run(command, versionArgs, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function extFromName(name = "") {
  return path.extname(name).replace(".", "").toLowerCase();
}

function decodeUploadFileName(name = "") {
  const original = String(name || "file");

  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const looksLikeMojibake = /(?:Ã|Â|â|ä|å|æ|ç|è|é|ð|þ|œ|€)/.test(original);
    return looksLikeMojibake && decoded && !decoded.includes("\uFFFD") ? decoded : original;
  } catch {
    return original;
  }
}

function normalizeExt(ext) {
  if (ext === "jpeg") return "jpg";
  if (ext === "markdown") return "md";
  if (ext === "htm") return "html";
  if (ext === "tif") return "tiff";
  return ext;
}

function categoryForExt(rawExt) {
  const ext = normalizeExt(rawExt);
  if (imageInput.has(ext) || imageInput.has(rawExt)) return "image";
  if (pdfInput.has(ext) || pdfInput.has(rawExt)) return "pdf";
  if (documentInput.has(ext) || documentInput.has(rawExt)) return "document";
  if (spreadsheetInput.has(ext) || spreadsheetInput.has(rawExt)) return "spreadsheet";
  if (presentationInput.has(ext) || presentationInput.has(rawExt)) return "presentation";
  if (textInput.has(ext) || textInput.has(rawExt)) return "text";
  if (audioInput.has(ext) || audioInput.has(rawExt)) return "audio";
  if (videoInput.has(ext) || videoInput.has(rawExt)) return "video";
  return "unknown";
}

function targetsForExt(rawExt, tools) {
  const category = categoryForExt(rawExt);
  const targets = new Set(["zip"]);

  if (category === "image") {
    imageFormatTargets.forEach((target) => targets.add(target));
    if (tools.ffmpeg) {
      imageVideoTargets.forEach((target) => targets.add(target));
    }
    if (tools.ocr) {
      imageOcrTargets.forEach((target) => targets.add(target));
    }
  }

  if (category === "text") {
    textTargets.forEach((target) => targets.add(target));
    if (tools.libreoffice) {
      targets.add("pdf");
    }
    if (["txt", "md", "markdown", "html", "htm"].includes(normalizeExt(rawExt))) {
      targets.add("docx");
    }
  }

  if (category === "pdf") {
    pdfTextTargets.forEach((target) => targets.add(target));
    if (tools.poppler) {
      pdfImageTargets.forEach((target) => targets.add(target));
      targets.add("pdf");
    }
  }

  if (category === "document" && tools.libreoffice) {
    documentTargets.forEach((target) => targets.add(target));
  }

  if (category === "spreadsheet" && tools.libreoffice) {
    spreadsheetTargets.forEach((target) => targets.add(target));
  }

  if (category === "presentation" && tools.libreoffice) {
    presentationTargets.forEach((target) => targets.add(target));
  }

  if (category === "audio" && tools.ffmpeg) {
    mediaAudioTargets.forEach((target) => targets.add(target));
  }

  if (category === "video" && tools.ffmpeg) {
    mediaTargets.forEach((target) => targets.add(target));
  }

  return [...targets].filter((target) => {
    const normalizedInput = normalizeExt(rawExt);
    if (category === "pdf" && target === "pdf") return true;
    return target !== normalizedInput || target === "zip";
  });
}

function safeBaseName(originalName) {
  const parsed = path.parse(sanitize(originalName || "file"));
  return (parsed.name || "converted").trim().slice(0, 180) || "converted";
}

function outputExtFor(category, targetExt) {
  if (category === "pdf" && pdfImageTargets.includes(targetExt)) return "zip";
  if (category === "pdf" && targetExt === "pdf") return "zip";
  return targetExt;
}

function outputNameFor(originalName, targetExt, outputExt = targetExt) {
  const suffix = outputExt === targetExt ? targetExt : `${targetExt}.${outputExt}`;
  return `${safeBaseName(originalName)}.${suffix}`;
}

function outputPathFor(originalName, targetExt, outputExt = targetExt) {
  return path.join(OUTPUT_DIR, `${Date.now()}-${randomUUID()}-${outputNameFor(originalName, targetExt, outputExt)}`);
}

function downloadUrlFor(filePath, downloadName, mimeType) {
  const id = randomUUID();
  downloads.set(id, {
    filePath,
    downloadName,
    mimeType,
    createdAt: Date.now()
  });
  return `/downloads/${id}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let cachedPdfjsPromise = null;

function loadPdfjs() {
  if (!cachedPdfjsPromise) {
    cachedPdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return cachedPdfjsPromise;
}

function asarUnpackedPath(filePath) {
  return filePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function loadTesseract() {
  if (!cachedTesseract) {
    cachedTesseract = require("tesseract.js");
  }
  return cachedTesseract;
}

function ocrRuntimePaths() {
  try {
    const resourcesPath = process.resourcesPath || "";
    const resourceCorePath = resourcesPath && path.join(resourcesPath, "tesseract.js-core");
    let resolvedCorePath = "";
    try {
      resolvedCorePath = path.dirname(asarUnpackedPath(require.resolve("tesseract.js-core/tesseract-core.wasm.js")));
    } catch {
      resolvedCorePath = "";
    }
    const corePath = resourceCorePath && fs.existsSync(resourceCorePath) ? resourceCorePath : resolvedCorePath;
    return {
      langPath: TESSDATA_PATH,
      corePath,
      workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js")
    };
  } catch {
    return null;
  }
}

function ocrAvailable() {
  const paths = ocrRuntimePaths();
  return Boolean(
    paths
    && fs.existsSync(paths.langPath)
    && fs.existsSync(path.join(paths.langPath, "eng.traineddata.gz"))
    && fs.existsSync(path.join(paths.langPath, "chi_sim.traineddata.gz"))
    && fs.existsSync(paths.corePath)
    && fs.existsSync(paths.workerPath)
  );
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let inList = false;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);

    if (heading) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      const level = heading[1].length;
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    if (bullet) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }

    if (inList) {
      output.push("</ul>");
      inList = false;
    }

    if (!line.trim()) {
      output.push("");
    } else {
      output.push(`<p>${escapeHtml(line)}</p>`);
    }
  }

  if (inList) output.push("</ul>");
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Converted document</title></head>
<body>
${output.join("\n")}
</body>
</html>`;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function csvToJson(csv) {
  const rows = csv.replace(/\r\n/g, "\n").split("\n").filter(Boolean).map((line) => {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  });

  const headers = rows.shift() || [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] || ""])));
}

function jsonToCsv(jsonText) {
  const data = parseJsonText(jsonText);
  const rows = Array.isArray(data) ? data : [data];
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers.map(quote).join(","), ...rows.map((row) => headers.map((header) => quote(row?.[header])).join(","))].join("\n");
}

async function convertImage(inputPath, outputPath, target) {
  if (target === "pdf") {
    await convertImagesToPdf([{ inputPath, originalName: path.basename(inputPath) }], outputPath);
    return;
  }

  if (target === "txt") {
    await convertImageToOcrText(inputPath, outputPath);
    return;
  }

  if (target === "mp4" || target === "webm") {
    await convertImageToVideo(inputPath, outputPath, target);
    return;
  }

  const image = sharp(inputPath, { animated: true, limitInputPixels: false }).rotate();
  const normalized = target === "jpg" ? "jpeg" : target;
  await image.toFormat(normalized, target === "jpg" ? { quality: 90 } : undefined).toFile(outputPath);
}

async function convertImageToVideo(inputPath, outputPath, target) {
  const fd = fs.openSync(inputPath, "r");
  let isGif = false;
  try {
    const magic = Buffer.alloc(6);
    fs.readSync(fd, magic, 0, 6, 0);
    isGif = magic.toString("latin1") === "GIF87a" || magic.toString("latin1") === "GIF89a";
  } finally {
    fs.closeSync(fd);
  }

  const args = ["-hide_banner", "-y"];
  if (isGif) {
    args.push("-i", inputPath);
  } else {
    args.push("-loop", "1", "-i", inputPath, "-t", "3");
  }
  args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an");
  if (target === "mp4") {
    args.push("-codec:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  } else {
    args.push("-codec:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-pix_fmt", "yuv420p");
  }
  args.push(outputPath);
  await run(FFMPEG_PATH, args, { timeout: 1000 * 60 * 10 });
}

async function prepareImageForOcr(inputPath) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ocr-image-"));
  const outputPath = path.join(tempDir, "ocr-input.png");
  const metadata = await sharp(inputPath, { limitInputPixels: false }).metadata();
  const pipeline = sharp(inputPath, { limitInputPixels: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1 });

  if (metadata.width && metadata.width < 1600) {
    pipeline.resize({ width: 1600, withoutEnlargement: false });
  }

  await pipeline.png().toFile(outputPath);
  return { tempDir, outputPath };
}

async function createOcrWorker() {
  if (!ocrAvailable()) {
    throw new Error("OCR 引擎未启用。请确认安装包内置的 Tesseract 语言文件完整。");
  }

  const { createWorker } = loadTesseract();
  const paths = ocrRuntimePaths();
  const worker = await createWorker("eng+chi_sim", 1, {
    langPath: paths.langPath,
    corePath: paths.corePath,
    workerPath: paths.workerPath,
    cacheMethod: "none"
  });
  await worker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "300"
  });
  return worker;
}

async function recognizeImageTextWithWorker(worker, inputPath) {
  const prepared = await prepareImageForOcr(inputPath);
  try {
    const { data } = await worker.recognize(prepared.outputPath);
    return String(data?.text || "").replace(/\r\n/g, "\n").trim();
  } finally {
    await fsp.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeImageText(inputPath) {
  const worker = await createOcrWorker();
  try {
    return await recognizeImageTextWithWorker(worker, inputPath);
  } finally {
    await worker.terminate();
  }
}

async function convertImageToOcrText(inputPath, outputPath) {
  const text = await recognizeImageText(inputPath);
  if (!text) {
    throw new Error("OCR 没有识别出文字。请确认图片清晰、文字方向正确。");
  }
  await fsp.writeFile(outputPath, `${text}\n`, "utf8");
}

function pdfAscii(value) {
  return Buffer.from(value, "latin1");
}

function pdfNumber(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "");
}

async function readImageForPdf(inputPath) {
  const { data, info } = await sharp(inputPath, { limitInputPixels: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColorspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels || 3;
  let rgb = data;
  if (channels !== 3) {
    rgb = Buffer.alloc(info.width * info.height * 3);
    for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
      rgb[pixel * 3] = data[pixel * channels];
      rgb[pixel * 3 + 1] = data[pixel * channels + 1];
      rgb[pixel * 3 + 2] = data[pixel * channels + 2];
    }
  }

  return {
    width: info.width,
    height: info.height,
    data: zlib.deflateSync(rgb)
  };
}

async function convertImagesToPdf(imageFiles, outputPath) {
  if (!imageFiles.length) {
    throw new Error("请先选择要转换为 PDF 的图片。");
  }

  const images = [];
  for (const file of imageFiles) {
    images.push(await readImageForPdf(file.inputPath));
  }

  const objects = [];
  const pageRefs = [];
  const addObject = (number, content) => {
    objects.push({ number, content: Buffer.isBuffer(content) ? content : pdfAscii(content) });
  };

  addObject(1, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const pageNumber = 3 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const pageWidth = Math.max(1, image.width);
    const pageHeight = Math.max(1, image.height);
    pageRefs.push(`${pageNumber} 0 R`);

    addObject(pageNumber, `${pageNumber} 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(pageWidth)} ${pdfNumber(pageHeight)}] /Resources << /XObject << /Im${index + 1} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>
endobj
`);

    addObject(imageNumber, Buffer.concat([
      pdfAscii(`${imageNumber} 0 obj
<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.length} >>
stream
`),
      image.data,
      pdfAscii("\nendstream\nendobj\n")
    ]));

    const content = `q
${pdfNumber(pageWidth)} 0 0 ${pdfNumber(pageHeight)} 0 0 cm
/Im${index + 1} Do
Q
`;
    addObject(contentNumber, `${contentNumber} 0 obj
<< /Length ${Buffer.byteLength(content, "latin1")} >>
stream
${content}endstream
endobj
`);
  }

  addObject(2, `2 0 obj
<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageRefs.length} >>
endobj
`);

  objects.sort((a, b) => a.number - b.number);
  const chunks = [pdfAscii("%PDF-1.4\n")];
  const offsets = [0];
  for (const object of objects) {
    offsets[object.number] = Buffer.concat(chunks).length;
    chunks.push(object.content);
  }

  const body = Buffer.concat(chunks);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let number = 1; number <= objects.length; number += 1) {
    xref += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  await fsp.writeFile(outputPath, Buffer.concat([body, pdfAscii(xref + trailer)]));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdInlineRuns(text) {
  const runs = [];
  const pattern = /(\*\*.+?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push({ t: text.slice(lastIndex, match.index) });
    const token = match[0];
    if (token.startsWith("**")) runs.push({ t: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ t: token.slice(1, -1), code: true });
    else runs.push({ t: token.slice(1, -1), italic: true });
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) runs.push({ t: text.slice(lastIndex) });
  return runs.length ? runs : [{ t: text }];
}

function docxRunXml(runs, base = {}) {
  return runs.map((run) => {
    const props = [];
    if (run.bold || base.bold) props.push("<w:b/>");
    if (run.italic || base.italic) props.push("<w:i/>");
    if (run.code) {
      props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      props.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
    }
    if (base.size) props.push(`<w:sz w:val="${base.size}"/><w:szCs w:val="${base.size}"/>`);
    const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
    return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.t)}</w:t></w:r>`;
  }).join("");
}

function docxParagraphXml(runs, options = {}) {
  const pPr = [];
  if (options.indent) pPr.push(`<w:ind w:left="${options.indent}"/>`);
  if (options.after) pPr.push(`<w:spacing w:after="${options.after}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${pPrXml}${docxRunXml(runs, options)}</w:p>`;
}

async function convertTextToDocx(raw, source, outputPath) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const paragraphs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push(docxParagraphXml([{ t: "" }]));
      continue;
    }
    if (source === "md") {
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = Number(heading[1].length);
        const size = [36, 32, 28, 26, 24, 24][level - 1];
        paragraphs.push(docxParagraphXml(mdInlineRuns(heading[2]), { size, bold: true, after: 120 }));
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        paragraphs.push(docxParagraphXml([{ t: "• " }, ...mdInlineRuns(bullet[1])], { indent: 360 }));
        continue;
      }
      paragraphs.push(docxParagraphXml(mdInlineRuns(trimmed)));
      continue;
    }
    paragraphs.push(docxParagraphXml([{ t: source === "html" || source === "htm" ? htmlToText(trimmed) : trimmed }]));
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr/></w:body></w:document>`;

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(contentTypes), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(rels), "_rels/.rels");
  zip.addBuffer(Buffer.from(documentXml), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(outputPath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

async function convertText(inputPath, outputPath, inputExt, target, originalName = `converted.${normalizeExt(inputExt) || "txt"}`) {
  const raw = await fsp.readFile(inputPath, "utf8");
  const source = normalizeExt(inputExt);
  let converted = raw;

  if (target === "pdf") {
    if (source === "md") {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-textpdf-"));
      const htmlPath = path.join(tempDir, "converted.html");
      await fsp.writeFile(htmlPath, markdownToHtml(raw), "utf8");
      try {
        await convertWithLibreOffice(htmlPath, outputPath, "converted.html", "pdf");
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      await convertWithLibreOffice(inputPath, outputPath, originalName, "pdf");
    }
    return;
  }

  if (target === "docx") {
    await convertTextToDocx(raw, source, outputPath);
    return;
  }

  if (target === "txt") {
    if (source === "html") converted = htmlToText(raw);
    else if (source === "json") converted = JSON.stringify(parseJsonText(raw), null, 2);
  } else if (target === "html") {
    if (source === "md") converted = markdownToHtml(raw);
    else if (source === "html") converted = raw;
    else converted = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Converted text</title></head>
<body><pre>${escapeHtml(raw)}</pre></body>
</html>`;
  } else if (target === "md") {
    if (source === "html") converted = htmlToText(raw);
    else if (source === "json") converted = `\`\`\`json\n${JSON.stringify(parseJsonText(raw), null, 2)}\n\`\`\`\n`;
  } else if (target === "json") {
    if (source === "json") converted = JSON.stringify(parseJsonText(raw), null, 2);
    else if (source === "csv") converted = JSON.stringify(csvToJson(raw), null, 2);
    else converted = JSON.stringify({ text: raw }, null, 2);
  } else if (target === "csv") {
    if (source === "json") converted = jsonToCsv(raw);
    else converted = raw.split(/\r?\n/).map((line) => `"${line.replaceAll('"', '""')}"`).join("\n");
  }

  await fsp.writeFile(outputPath, converted, "utf8");
}

function libreOfficeFilterFor(target) {
  const filters = {
    txt: "txt:Text",
    csv: "csv:Text - txt - csv (StarCalc)"
  };
  return filters[target] || target;
}

async function findConvertedFile(outDir, target) {
  const files = await fsp.readdir(outDir).catch(() => []);
  const normalizedTarget = target.toLowerCase();
  const matches = [];

  for (const fileName of files) {
    const filePath = path.join(outDir, fileName);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isFile() && normalizeExt(extFromName(fileName)) === normalizedTarget) {
      matches.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath || null;
}

async function convertWithLibreOffice(inputPath, outputPath, originalName, target) {
  if (!(await commandExists(LIBREOFFICE_PATH, ["--version"]))) {
    throw new Error("文档转换引擎未启用。请确认安装包内置的 LibreOffice 文件完整。");
  }

  const tempDir = path.join(RUNTIME_DIR, `lo-${randomUUID()}`);
  const outDir = path.join(tempDir, "out");
  const profileDir = path.join(tempDir, "profile");
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(profileDir, { recursive: true });

  const originalExt = extFromName(originalName) || "bin";
  const safeName = sanitize(originalName || `input.${originalExt}`) || `input.${originalExt}`;
  const workingInput = path.join(tempDir, safeName.includes(".") ? safeName : `${safeName}.${originalExt}`);

  try {
    await fsp.copyFile(inputPath, workingInput);
    const args = [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      "--nodefault",
      "--nolockcheck",
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--convert-to",
      libreOfficeFilterFor(target),
      "--outdir",
      outDir,
      workingInput
    ];

    await run(LIBREOFFICE_PATH, args, { timeout: 1000 * 60 * 10 });
    const convertedPath = await findConvertedFile(outDir, target);
    if (!convertedPath) {
      throw new Error("文档转换失败，可能是不支持这个源格式或文件已损坏。");
    }
    await fsp.copyFile(convertedPath, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertDocumentToMarkdown(inputPath, outputPath, inputExt, originalName) {
  const ext = normalizeExt(inputExt);
  let html;
  if (ext === "docx") {
    const result = await mammoth.convertToHtml({ path: inputPath });
    html = result.value || "";
  } else {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-docmd-"));
    const htmlPath = path.join(tempDir, "converted.html");
    try {
      await convertWithLibreOffice(inputPath, htmlPath, originalName, "html");
      html = await fsp.readFile(htmlPath, "utf8");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const markdown = turndown.turndown(html).trim();
  if (!markdown) {
    throw new Error("文档转 Markdown 失败，未提取到任何内容。");
  }
  await fsp.writeFile(outputPath, `${markdown}\n`, "utf8");
}

async function convertDocumentToText(inputPath, outputPath, inputExt, originalName) {
  const ext = normalizeExt(inputExt);
  let text;
  if (ext === "docx") {
    // LibreOffice 的 txt 导出过滤器在本便携版不可用（报错/卡死），docx 直接用 mammoth 提取纯文本
    const result = await mammoth.extractRawText({ path: inputPath });
    text = (result.value || "").trim();
  } else {
    // doc/odt/rtf/wps 等走 LibreOffice html 导出（探测可用）再转纯文本
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-doctxt-"));
    const htmlPath = path.join(tempDir, "converted.html");
    try {
      await convertWithLibreOffice(inputPath, htmlPath, originalName, "html");
      text = htmlToText(await fsp.readFile(htmlPath, "utf8")).trim();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!text) {
    throw new Error("文档转文本失败，未提取到任何内容。");
  }
  await fsp.writeFile(outputPath, `${text}\n`, "utf8");
}

function groupPdfItemsIntoRows(items) {
  const cleanItems = items
    .filter((item) => String(item.str || "").trim())
    .map((item) => ({
      text: String(item.str).trim(),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rowBuckets = [];
  for (const item of cleanItems) {
    let row = rowBuckets.find((bucket) => Math.abs(bucket.y - item.y) <= 3);
    if (!row) {
      row = { y: item.y, items: [] };
      rowBuckets.push(row);
    }
    row.items.push(item);
    row.y = (row.y * (row.items.length - 1) + item.y) / row.items.length;
  }

  const anchors = [];
  for (const item of cleanItems) {
    let anchor = anchors.find((candidate) => Math.abs(candidate.x - item.x) <= 10);
    if (!anchor) {
      anchor = { x: item.x, count: 0 };
      anchors.push(anchor);
    }
    anchor.x = (anchor.x * anchor.count + item.x) / (anchor.count + 1);
    anchor.count += 1;
  }
  anchors.sort((a, b) => a.x - b.x);

  return rowBuckets
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const cells = Array.from({ length: Math.max(anchors.length, 1) }, () => "");
      for (const item of row.items.sort((a, b) => a.x - b.x)) {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        anchors.forEach((anchor, index) => {
          const distance = Math.abs(anchor.x - item.x);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        });
        cells[bestIndex] = cells[bestIndex] ? `${cells[bestIndex]} ${item.text}` : item.text;
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells;
    })
    .filter((row) => row.length);
}

async function extractPdfRowsByPage(inputPath) {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(inputPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      name: `Page ${pageNumber}`,
      rows: groupPdfItemsIntoRows(content.items)
    });
  }

  await loadingTask.destroy();
  return pages;
}

function sheetName(value) {
  return String(value).replace(/[\\/?*:[\]]/g, " ").slice(0, 31) || "Sheet";
}

function applyColumnWidths(sheet, rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const length = String(cell || "").length;
      widths[index] = Math.max(widths[index] || 8, Math.min(length + 2, 48));
    });
  }
  sheet.columns = widths.map((wch) => ({ width: wch }));
}

async function convertPdf(inputPath, outputPath, target) {
  if (target === "pdf") {
    await splitPdfToZip(inputPath, outputPath);
    return;
  }

  if (pdfImageTargets.includes(target)) {
    await convertPdfPagesToImagesZip(inputPath, outputPath, target);
    return;
  }

  const pages = await extractPdfRowsByPage(inputPath);
  const hasExtractableRows = pages.some((page) => page.rows.length);

  if (!hasExtractableRows) {
    if (target === "txt") {
      await convertScannedPdfToOcrText(inputPath, outputPath);
      return;
    }
    throw new Error("这个 PDF 没有可提取的文字表格，可能是扫描版图片 PDF。扫描版需要 OCR 后才能转 Excel。");
  }

  if (target === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    for (const page of pages) {
      const rows = page.rows.length ? page.rows : [[""]];
      const sheet = workbook.addWorksheet(sheetName(page.name));
      sheet.addRows(rows);
      applyColumnWidths(sheet, rows);
    }
    await workbook.xlsx.writeFile(outputPath);
    return;
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

  throw new Error("PDF 暂时只支持转换为 XLSX、TXT、HTML、PNG、JPG，或拆分为单页 PDF。");
}

async function splitPdfToZip(inputPath, outputPath) {
  const src = await PDFDocument.load(await fsp.readFile(inputPath), { ignoreEncryption: true });
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
  for (const file of pdfFiles) {
    const src = await PDFDocument.load(await fsp.readFile(file.inputPath), { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  const bytes = await merged.save();
  if (!bytes.length) {
    throw new Error("PDF 合并失败，未生成任何内容。");
  }
  await fsp.writeFile(outputPath, bytes);
}

async function renderPdfPages(inputPath, target = "png", dpi = 150) {
  if (!(await commandExists(PDFTOPPM_PATH, ["-v"]))) {
    throw new Error("PDF 转图片引擎未启用。请确认安装包内置的 Poppler 文件完整。");
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-pages-"));
  const prefix = path.join(tempDir, "page");
  const formatArg = target === "jpg" ? "-jpeg" : "-png";
  await run(PDFTOPPM_PATH, [formatArg, "-r", String(dpi), inputPath, prefix], { timeout: 1000 * 60 * 20 });
  const ext = target === "jpg" ? ".jpg" : ".png";
  const files = (await fsp.readdir(tempDir))
    .filter((file) => file.toLowerCase().endsWith(ext))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => path.join(tempDir, file));

  if (!files.length) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("PDF 转图片失败，未生成任何页面图片。");
  }

  return { tempDir, files };
}

async function convertPdfPagesToImagesZip(inputPath, outputPath, target) {
  const rendered = await renderPdfPages(inputPath, target, 150);
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
  if (!ocrAvailable()) {
    throw new Error("OCR 引擎未启用。请确认安装包内置的 Tesseract 语言文件完整。");
  }

  const rendered = await renderPdfPages(inputPath, "png", 300);
  let worker = null;
  try {
    worker = await createOcrWorker();
    const pages = [];
    for (let index = 0; index < rendered.files.length; index += 1) {
      const text = await recognizeImageTextWithWorker(worker, rendered.files[index]);
      pages.push(`## Page ${index + 1}\n${text || "[OCR 未识别出文字]"}`);
    }
    const combined = pages.join("\n\n").trim();
    if (!combined || !pages.some((page) => !page.includes("[OCR 未识别出文字]"))) {
      throw new Error("OCR 没有识别出文字。请确认 PDF 扫描页清晰、文字方向正确。");
    }
    await fsp.writeFile(outputPath, `${combined}\n`, "utf8");
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertMedia(inputPath, outputPath, target, category) {
  const args = ["-hide_banner", "-y", "-i", inputPath];

  if (["mp3", "wav", "flac", "m4a", "ogg", "aac", "opus", "wma"].includes(target)) {
    args.push("-vn");
    if (target === "mp3") args.push("-codec:a", "libmp3lame", "-q:a", "2");
    if (target === "m4a") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "ogg") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "aac") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "opus") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "wma") args.push("-codec:a", "wmav2", "-b:a", "192k");
  } else if (category === "audio") {
    throw new Error("音频文件不能直接转换为视频容器。请选择音频目标格式。");
  } else if (target === "mp4" || target === "mov") {
    args.push("-codec:v", "libx264", "-preset", "medium", "-crf", "23", "-codec:a", "aac", "-movflags", "+faststart");
  } else if (target === "webm") {
    args.push("-codec:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-codec:a", "libopus");
  } else if (target === "mkv") {
    args.push("-codec:v", "libx264", "-preset", "medium", "-crf", "23", "-codec:a", "aac");
  }

  args.push(outputPath);
  await run(FFMPEG_PATH, args, { timeout: 1000 * 60 * 30 });
}

async function zipFile(inputPath, outputPath, originalName, compressionLevel = 6) {
  await zipFiles([{ inputPath, archiveName: sanitize(originalName || "file") || "file" }], outputPath, compressionLevel);
}

async function zipFiles(files, outputPath, compressionLevel = 6) {
  const levelNum = Number(compressionLevel);
  const level = Number.isFinite(levelNum) ? Math.min(9, Math.max(0, levelNum)) : 6;
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const file of files) {
      archive.addFile(file.inputPath, sanitize(file.archiveName || "file") || "file", { compressionLevel: level });
    }
    archive.end();
  });
}

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

let cachedTools = null;

async function getTools() {
  if (!cachedTools) {
    cachedTools = {
      ffmpeg: await commandExists(FFMPEG_PATH),
      libreoffice: await commandExists(LIBREOFFICE_PATH, ["--version"]),
      poppler: await commandExists(PDFTOPPM_PATH, ["-v"]),
      ocr: ocrAvailable(),
      pdf: true,
      sharp: true,
      zip: true
    };
  }
  return cachedTools;
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

function parseJsonText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON 解析失败：文件内容不是有效的 JSON。");
  }
}

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
});
app.use(express.static(path.join(ROOT, "public")));
app.use(express.json());

app.get("/api/capabilities", async (_req, res) => {
  const tools = await getTools();
  res.json({
    tools,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    groups: {
      image: { inputs: [...imageInput].sort(), targets: [...imageFormatTargets, ...(tools.ffmpeg ? imageVideoTargets : []), ...(tools.ocr ? imageOcrTargets : [])] },
      text: { inputs: [...textInput].sort(), targets: [...textTargets, ...(tools.libreoffice ? ["pdf"] : []), "docx"] },
      document: { inputs: [...documentInput].sort(), targets: documentTargets },
      spreadsheet: { inputs: [...spreadsheetInput].sort(), targets: spreadsheetTargets },
      presentation: { inputs: [...presentationInput].sort(), targets: presentationTargets },
      pdf: { inputs: [...pdfInput].sort(), targets: [...pdfTextTargets, ...(tools.poppler ? [...pdfImageTargets, "pdf"] : [])] },
      audio: { inputs: [...audioInput].sort(), targets: mediaAudioTargets },
      video: { inputs: [...videoInput].sort(), targets: mediaTargets },
      any: { inputs: ["*"], targets: ["zip"] }
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
  res.json({ extension: ext, category: categoryForExt(ext), targets: targetsForExt(ext, tools) });
});

app.post("/api/convert-images-to-pdf", assertLocalWebRequest, upload.array("files", 100), async (req, res) => {
  const files = req.files || [];

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

  if (imageFiles.some((file) => file.category !== "image")) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    res.status(400).json({ error: "批量合并 PDF 只支持图片文件。请先移除非图片文件。" });
    return;
  }

  const firstBaseName = safeBaseName(imageFiles[0].originalName);
  const combinedName = imageFiles.length > 1 ? `${firstBaseName}等${imageFiles.length}个文件.pdf` : `${firstBaseName}.pdf`;
  const outputPath = outputPathFor(combinedName, "pdf");
  const downloadName = outputNameFor(combinedName, "pdf");

  try {
    await convertImagesToPdf(imageFiles, outputPath);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    const mimeType = "application/pdf";
    res.json({
      ok: true,
      fileName: downloadName,
      category: "image",
      mimeType,
      downloadUrl: downloadUrlFor(outputPath, downloadName, mimeType)
    });
  } catch (error) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message || "图片合并 PDF 失败。" });
  }
});

app.post("/api/merge-pdfs", assertLocalWebRequest, upload.array("files", 100), async (req, res) => {
  const files = req.files || [];

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

  try {
    await mergePdfFiles(pdfFiles, outputPath);
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    res.json({
      ok: true,
      fileName: downloadName,
      category: "pdf",
      mimeType: "application/pdf",
      downloadUrl: downloadUrlFor(outputPath, downloadName, "application/pdf")
    });
  } catch (error) {
    await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message || "合并 PDF 失败。" });
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
    await fsp.rm(file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: "目标格式暂不支持。" });
    return;
  }

  const inputExt = normalizeExt(extFromName(originalName));
  const category = categoryForExt(inputExt);
  const allowedTargets = targetsForExt(inputExt, tools);

  if (!allowedTargets.includes(requestedTarget)) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: "这个源文件暂时不能转换成所选格式。" });
    return;
  }

  const outputExt = outputExtFor(category, requestedTarget);
  const outputPath = outputPathFor(originalName, requestedTarget, outputExt);
  const downloadName = outputNameFor(originalName, requestedTarget, outputExt);

  try {
    if (requestedTarget === "zip") {
      const levelNum = Number(req.body?.compressionLevel);
      const level = Number.isFinite(levelNum) ? Math.min(9, Math.max(0, levelNum)) : 6;
      await zipFile(file.path, outputPath, originalName, level);
    } else if (category === "image") {
      await convertImage(file.path, outputPath, requestedTarget);
    } else if (category === "text") {
      await convertText(file.path, outputPath, inputExt, requestedTarget, originalName);
    } else if (category === "pdf") {
      await convertPdf(file.path, outputPath, requestedTarget);
    } else if (category === "document" || category === "spreadsheet" || category === "presentation") {
      if (category === "document" && requestedTarget === "md") {
        await convertDocumentToMarkdown(file.path, outputPath, inputExt, originalName);
      } else if (category === "document" && requestedTarget === "txt") {
        await convertDocumentToText(file.path, outputPath, inputExt, originalName);
      } else {
        await convertWithLibreOffice(file.path, outputPath, originalName, requestedTarget);
      }
    } else if (category === "audio" || category === "video") {
      await convertMedia(file.path, outputPath, requestedTarget, category);
    } else {
      throw new Error("暂时无法识别这个文件类型。");
    }

    await fsp.rm(file.path, { force: true }).catch(() => {});
    const mimeType = mime.lookup(downloadName) || "application/octet-stream";
    const payload = {
      ok: true,
      fileName: downloadName,
      category,
      mimeType,
      downloadUrl: downloadUrlFor(outputPath, downloadName, mimeType)
    };
    if (requestedTarget === "zip") {
      const originalBytes = file.size || 0;
      const compressedBytes = (await fsp.stat(outputPath)).size;
      payload.originalBytes = originalBytes;
      payload.compressedBytes = compressedBytes;
      payload.compressionRatio = compressedBytes >= originalBytes
        ? 0
        : Math.round((1 - compressedBytes / originalBytes) * 100);
    }
    res.json(payload);
  } catch (error) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message || "转换失败。" });
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

app.use((error, _req, res, _next) => {
  if (error?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "文件太大，当前原型最大支持 1GB。" });
    return;
  }
  res.status(500).json({ error: error.message || "服务器出错。" });
});

let cleanupTimer = null;

function startServer(port = DEFAULT_PORT) {
  ensureDirs();
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupOldFiles, 1000 * 60 * 20);
    cleanupTimer.unref();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`
      });
    });
    server.on("error", reject);
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

module.exports = { app, startServer };
