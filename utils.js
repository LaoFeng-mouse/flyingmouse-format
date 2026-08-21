// utils.js — 飞鼠格式服务端通用工具：进程执行、文件名/格式处理、输出命名。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const sanitize = require("sanitize-filename");
const logger = require("./logger");
const {
  OUTPUT_DIR,
  imageInput,
  rawInput,
  imageFormatTargets,
  imageVideoTargets,
  imageOcrTargets,
  textInput,
  textTargets,
  documentInput,
  documentTargets,
  ofdOnlyPdfTargets,
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
  experimentalInputSet,
  downloads
} = require("./config");

function ensureDirs() {
  fs.mkdirSync(require("./config").UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 1000 * 60 * 15 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr || stdout || error.message;
        logger.warn(`Command failed: ${command} ${(args || []).join(" ")}`, {
          message: detail.trim() || error.message,
          stack: error.stack
        });
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
  return path.extname(String(name || "")).replace(".", "").toLowerCase();
}

function decodeUploadFileName(name = "") {
  const original = String(name || "file");

  // UTF-8 mojibake：浏览器/Electron 的 FormData 用 UTF-8 编码文件名，
  // multer 的 busboy 按 latin1 解码后会出现 Ã© 这类字符，还原回 UTF-8。
  // 解码成功直接返回，不再往下走 GBK（避免把正确中文名二次转换）。
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const looksLikeMojibake = /(?:Ã|Â|â|ä|å|æ|ç|è|é|ð|þ|œ|€)/.test(original);
    if (looksLikeMojibake && decoded && !decoded.includes("\uFFFD")) {
      return decoded;
    }
  } catch {
    // fall through to GBK attempt
  }

  // GBK mojibake：命令行/某些上传场景（curl -F filename、微信传输文件名、老
  // 客户端）会用系统代码页（中文 Windows = GBK/936）编码文件名，multer 按
  // latin1 解码后出现 °×À¼µÄ 这类字符（2026-08-14 实测：中文文件名上传返回
  // 乱码）。仅当文件名含高字节 latin1 字符（≥0x80）时按 GBK 再解一次。
  if ([...original].some((ch) => ch.charCodeAt(0) >= 0x80)) {
    try {
      const bytes = Buffer.from(original, "latin1");
      const decoded = new TextDecoder("gbk").decode(bytes);
      if (decoded && !decoded.includes("\uFFFD") && decoded !== original) {
        return decoded;
      }
    } catch {
      // TextDecoder 不支持 gbk 时原样返回
    }
  }
  return original;
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
  if (imageInput.has(ext) || imageInput.has(rawExt) || rawInput.has(ext) || rawInput.has(rawExt)) return "image";
  if (pdfInput.has(ext) || pdfInput.has(rawExt)) return "pdf";
  if (documentInput.has(ext) || documentInput.has(rawExt)) return "document";
  if (spreadsheetInput.has(ext) || spreadsheetInput.has(rawExt)) return "spreadsheet";
  if (presentationInput.has(ext) || presentationInput.has(rawExt)) return "presentation";
  if (textInput.has(ext) || textInput.has(rawExt)) return "text";
  if (audioInput.has(ext) || audioInput.has(rawExt)) return "audio";
  if (videoInput.has(ext) || videoInput.has(rawExt)) return "video";
  if (ext === "zip") return "zip";
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

  // 电子书输入（EPUB/MOBI）是二进制容器，仅支持文本类目标；MOBI 只支持 EPUB/TXT/MD。
  if (["epub", "mobi"].includes(normalizeExt(rawExt))) {
    return [...targets].filter((target) => ["epub", "txt", "md", "zip"].includes(target));
  }

  if (category === "pdf") {
    pdfTextTargets.forEach((target) => targets.add(target));
    if (tools.poppler) {
      pdfImageTargets.forEach((target) => targets.add(target));
      targets.add("pdf");
    }
  }

  // OFD 只走自有转换链路（ofd-convert.js → PDF），LibreOffice 打不开 OFD，
  // 提前返回避免 document 分支把 docx/odt/txt 等无效目标加进来。
  if (normalizeExt(rawExt) === "ofd") {
    ofdOnlyPdfTargets.forEach((target) => targets.add(target));
    return [...targets];
  }

  if (category === "document" && tools.libreoffice) {
    documentTargets.forEach((target) => targets.add(target));
  }

  if (category === "spreadsheet" && tools.libreoffice) {
    spreadsheetTargets.forEach((target) => targets.add(target));
  }

  if (["csv", "tsv"].includes(normalizeExt(rawExt))) {
    textTargets.forEach((target) => targets.add(target));
    // csv/tsv 的 xlsx/pdf/html/epub 有自有实现（见 /api/convert 分发）；xls/ods 的
    // LO 分隔文本导入在 headless 下假成功（exit 0 零输出），不提供，避免 500。
    // xlsx 用 exceljs 生成，不依赖 LibreOffice（CI 无 LO 环境也必须可用）。
    targets.add("xlsx");
    targets.delete("xls");
    targets.delete("ods");
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

  if (category === "zip") {
    targets.add("pdf");
  }

  return [...targets].filter((target) => {
    const normalizedInput = normalizeExt(rawExt);
    if (category === "pdf" && target === "pdf") return true;
    if (category === "image" && ["gif", "webp"].includes(normalizedInput) && target === "tiff") return false;
    return target !== normalizedInput || target === "zip";
  });
}

function platformCapabilities(platform = process.platform, arch = process.arch) {
  return {
    os: platform,
    arch
  };
}

function experimentalInputWarning(inputExt) {
  return {
    code: "EXPERIMENTAL_INPUT",
    details: { inputFormat: inputExt },
    messages: {
      zhCN: `${inputExt.toUpperCase()} 输入仍属实验性，尚未覆盖足够真实样本；请复核转换结果。`,
      enUS: `${inputExt.toUpperCase()} input is experimental and lacks broad real-file validation; review the converted result.`
    }
  };
}

function safeBaseName(originalName) {
  const parsed = path.parse(sanitize(originalName || "file"));
  return (parsed.name || "converted").trim().slice(0, 180) || "converted";
}

function outputExtFor(category, targetExt) {
  if (category === "pdf" && pdfImageTargets.includes(targetExt)) return "zip";
  if (category === "pdf" && targetExt === "pdf") return "zip";
  if (category === "presentation" && ["png", "jpg"].includes(targetExt)) return "zip";
  return targetExt;
}

function outputNameFor(originalName, targetExt, outputExt = targetExt) {
  const suffix = outputExt === targetExt ? targetExt : `${targetExt}.${outputExt}`;
  return `${safeBaseName(originalName)}.${suffix}`;
}

function outputPathFor(originalName, targetExt, outputExt = targetExt) {
  return path.join(OUTPUT_DIR, `${Date.now()}-${randomUUID()}-${outputNameFor(originalName, targetExt, outputExt)}`);
}

function previewKindFor(downloadName, mimeType) {
  const ext = normalizeExt(extFromName(downloadName));
  if (String(mimeType).startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  if (String(mimeType).startsWith("audio/")) return "audio";
  if (String(mimeType).startsWith("video/")) return "video";
  if (["txt", "md", "json", "csv", "tsv", "xml", "yaml", "yml", "log", "html"].includes(ext)) return "text";
  return "unsupported";
}

function registerDownload(filePath, downloadName, mimeType, options = {}) {
  const id = randomUUID();
  downloads.set(id, {
    filePath,
    downloadName,
    mimeType,
    assetsDir: options.assetsDir || null,
    createdAt: Date.now()
  });
  return {
    downloadUrl: `/downloads/${id}`,
    previewUrl: `/previews/${id}`,
    previewKind: previewKindFor(downloadName, mimeType)
  };
}

function downloadUrlFor(filePath, downloadName, mimeType) {
  return registerDownload(filePath, downloadName, mimeType).downloadUrl;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

module.exports = {
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
  previewKindFor,
  registerDownload,
  downloadUrlFor,
  escapeHtml
};
