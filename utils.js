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
  imageFormatTargets,
  imageVideoTargets,
  imageOcrTargets,
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
    arch,
    standardNcm: true,
    av3a: platform === "win32"
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
  downloadUrlFor,
  escapeHtml
};
