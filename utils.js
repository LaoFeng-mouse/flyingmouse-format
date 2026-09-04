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

// 双后缀输入：path.extname 只看最后一段，这里集中登记「真实格式在倒数第二段」的输入名。
// 加密音频：VIPER HiFi / 酷狗客户端导出的 .vpr.flac、QQ 音乐新版 .mgg2.flac（unlock-music 同规则）。
// 电子书：FictionBook 官方发行普遍打成 .fb2.zip（ZIP 内含单个 .fb2），
// 不登记的话会被当成 zip 而进不了 fb2 转换分支（2026-08-31 补）。
const DOUBLE_SUFFIX_INPUTS = [
  { suffix: ".vpr.flac", ext: "vpr" },
  { suffix: ".mgg2.flac", ext: "mgg2" },
  { suffix: ".fb2.zip", ext: "fb2" }
];

function doubleSuffixFor(name = "") {
  const lower = String(name || "").toLowerCase();
  return DOUBLE_SUFFIX_INPUTS.find((entry) => lower.endsWith(entry.suffix)) || null;
}

function extFromName(name = "") {
  const matched = doubleSuffixFor(name);
  if (matched) return matched.ext;
  return path.extname(name).replace(".", "").toLowerCase();
}

function decodeUploadFileName(name = "") {
  const original = String(name || "file");

  // UTF-8 mojibake：浏览器/Electron 的 FormData 用 UTF-8 编码文件名，
  // multer 的 busboy 按 latin1 解码后会出现 Ã© 这类字符，还原回 UTF-8。
  // 判据改为「latin1→utf8 解码后无 U+FFFD 且 ≠ 原串」：不再用字符白名单，
  // 因此对所有多字节字符集都成立——中文、日文、韩文、阿拉伯文、俄文、emoji
  // 全能被还原（2026-08-31 实测：旧白名单漏掉韩文/阿文，出现 íêµ­ì´Ø§Ù 乱码），
  // 而真正的 GBK 内容解码必产生 U+FFFD，会正确落回下面的 GBK 分支。
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const hasHighByte = [...original].some((ch) => ch.charCodeAt(0) >= 0x80);
    // 组合变音符号（U+0300–U+036F 等）：GBK 字节如 0xD6D0 0xCEC4（"中文"）恰好同时是
    // 合法 UTF-8（解出希伯来字母+组合音标），无此护栏会把 GBK 内容错误吞进 UTF-8 分支。
    const combiningMarks = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/;
    if (hasHighByte && decoded && decoded !== original && !decoded.includes("\uFFFD") && !combiningMarks.test(decoded)) {
      return decoded;
    }
  } catch {
    // fall through to GBK attempt
  }

  // GBK mojibake：命令行/某些上传场景（curl -F filename、微信传输文件名、老
  // 客户端）会用系统代码页（中文 Windows = GBK/936）编码文件名，multer 按
  // latin1 解码后出现 °×À¼µÄ 这类字符（2026-08-14 实测：中文文件名上传返回
  // 乱码）。仅当文件名含高字节 latin1 字符（≥0x80）时按 GBK 再解一次。
  // 护栏：只有「高字节成对相邻」时才尝试 GBK。真正的 GBK 中文名每个汉字占两个
  // ≥0x80 字节，必然出现相邻高字节；真 latin1 西欧名里高字节是孤立的（前后都是
  // ASCII 字母），无此护栏时 0xF8 0x72（ø + r）恰好是合法 GBK 序列，
  // Bjørn Åsnes.flac 会被错解成 Bj鴕n 舠nes.flac（2026-08-31 实测并修复）。
  if (/[\u0080-\u00ff]{2}/.test(original)) {
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
  const targets = new Set();

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

  // 电子书输入（EPUB/MOBI）是二进制容器。EPUB 的 pdf/docx/html 走「合并 spine
  // html -> LibreOffice」管线（ebook.js convertEpubViaLibreOffice，LO 存在才可用）；
  // MOBI 只支持 EPUB/TXT/MD。
  if (normalizeExt(rawExt) === "epub") {
    const epubTargets = ["txt", "md", "html"];
    if (tools.libreoffice) epubTargets.push("pdf", "docx");
    return [...targets].filter((target) => epubTargets.includes(target));
  }
  if (normalizeExt(rawExt) === "mobi" || normalizeExt(rawExt) === "azw3") {
    return [...targets].filter((target) => ["epub", "txt", "md"].includes(target));
  }
  if (normalizeExt(rawExt) === "fb2") {
    return [...targets].filter((target) => ["txt", "md", "html", "epub"].includes(target));
  }

  if (category === "pdf") {
    pdfTextTargets.forEach((target) => targets.add(target));
    // ODT 产物经 LibreOffice 产出（docx 中间件 → odt）。无 LibreOffice（如 win7 构建）时隐藏，
    // 避免能力面板暴露出一个点了必报错的目标。
    if (!tools.libreoffice) targets.delete("odt");
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
    return target !== normalizedInput;
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
  const cleaned = sanitize(originalName || "file");
  const matched = doubleSuffixFor(cleaned);
  // 双后缀输入整段剥掉，否则产物名会带残尾（song.vpr.mp3 / book.fb2.txt）。
  const base = matched ? cleaned.slice(0, -matched.suffix.length) : path.parse(cleaned).name;
  return (base || "converted").trim().slice(0, 180) || "converted";
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
