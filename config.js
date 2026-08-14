// config.js — 飞鼠格式服务端共享配置：引擎路径解析、目录、格式常量。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const DEFAULT_PORT = Number(process.env.PORT || 5177);
const RUNTIME_DIR = process.env.FLYINGMOUSE_RUNTIME_DIR || path.join(os.tmpdir(), "flyingmouse-format-runtime");
const UPLOAD_DIR = path.join(RUNTIME_DIR, "uploads");
const OUTPUT_DIR = path.join(RUNTIME_DIR, "converted");
const MAX_UPLOAD_BYTES = Number.MAX_SAFE_INTEGER;

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

function bundledDcrawPath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_DCRAW_PATH,
    resourcesPath && path.join(resourcesPath, "dcraw", "dcraw.exe"),
    path.join(ROOT, "bin", "dcraw", "dcraw.exe"),
    path.join(process.cwd(), "bin", "dcraw", "dcraw.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function bundledDocenginePath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_DOCENGINE_PATH,
    resourcesPath && path.join(resourcesPath, "docengine", "docengine.exe"),
    path.join(ROOT, "bin", "docengine", "docengine.exe"),
    path.join(process.cwd(), "bin", "docengine", "docengine.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function bundledQpdfPath() {
  const resourcesPath = process.resourcesPath || "";
  const candidates = [
    process.env.FLYINGMOUSE_QPDF_PATH,
    resourcesPath && path.join(resourcesPath, "qpdf", "bin", "qpdf.exe"),
    path.join(ROOT, "bin", "qpdf", "extracted", "qpdf-12.4.0-msvc64", "bin", "qpdf.exe"),
    path.join(process.cwd(), "bin", "qpdf", "extracted", "qpdf-12.4.0-msvc64", "bin", "qpdf.exe"),
    "qpdf"
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "qpdf" || fs.existsSync(candidate)) || "qpdf";
}

const FFMPEG_PATH = bundledFfmpegPath();
const LIBREOFFICE_PATH = bundledLibreOfficePath();
const PDFTOPPM_PATH = bundledPdftoppmPath();
const TESSDATA_PATH = bundledTessdataPath();
const DCRAW_PATH = bundledDcrawPath();
const DOCENGINE_PATH = bundledDocenginePath();
const QPDF_PATH = bundledQpdfPath();

const imageInput = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "bmp", "heic", "heif", "ico", "tga"]);
// 相机 RAW 原片（dcraw/libraw 可解码的常见扩展名）
const rawInput = new Set(["cr2", "cr3", "crw", "nef", "arw", "dng", "raf", "rw2", "orf", "pef", "srw", "3fr", "erf", "fff", "iiq", "kdc", "mef", "mrw", "x3f"]);
const imageFormatTargets = ["png", "jpg", "webp", "gif", "avif", "tiff", "ico", "pdf"];
const imageVideoTargets = ["mp4", "webm"];
const imageOcrTargets = ["txt"];
const imageTargets = [...imageFormatTargets, ...imageVideoTargets, ...imageOcrTargets];
const textInput = new Set(["txt", "md", "markdown", "html", "htm", "json", "csv", "log", "xml", "yaml", "yml", "epub", "mobi"]);
const textTargets = ["txt", "md", "html", "json", "csv", "epub"];
const documentInput = new Set(["doc", "docx", "odt", "rtf", "wps", "wpt", "wpd"]);
const documentTargets = ["pdf", "docx", "odt", "rtf", "txt", "html", "md"];
const spreadsheetInput = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "et", "ett"]);
const spreadsheetTargets = ["pdf", "xlsx", "xls", "ods", "csv", "html"];
const presentationInput = new Set(["ppt", "pptx", "odp", "dps", "dpt"]);
const presentationTargets = ["pdf", "pptx", "odp", "html", "png", "jpg"];
const pdfInput = new Set(["pdf"]);
const pdfTextTargets = ["xlsx", "txt", "html", "docx"];
const pdfImageTargets = ["png", "jpg"];
const pdfTargets = [...pdfTextTargets, ...pdfImageTargets, "pdf"];
const audioInput = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "ncm", "kgg", "mflac", "mgg", "kgma", "mmp4", "kwm", "vpr"]);
// 加密音频解锁格式（DRM 规避）。商店版（Microsoft Store）构建时隐藏这些入口，降低法律风险。
const unlockAudioInputs = new Set(["ncm", "kgg", "mflac", "mgg", "kgma", "mmp4", "kwm", "vpr"]);
const videoInput = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv"]);
const mediaAudioTargets = ["mp3", "wav", "flac", "m4a", "ogg", "aac", "opus", "wma"];
const mediaVideoTargets = ["mp4", "webm", "mkv", "mov", "gif"];
const mediaTargets = [...mediaVideoTargets, ...mediaAudioTargets];
const experimentalInputsByCategory = Object.freeze({
  image: ["heic", "heif", "ico", "tga"],
  raw: [...rawInput],
  document: ["wpd", "wps", "wpt"],
  spreadsheet: ["et", "ett"],
  presentation: ["dps", "dpt"],
  audio: ["kgg", "mflac", "kwm"]
});
const experimentalInputSet = new Set(Object.values(experimentalInputsByCategory).flat());
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

// 运行时下载登记表（downloadUrlFor 写入 / 路由读取，跨模块共享同一实例）。
const downloads = new Map();

module.exports = {
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
  DOCENGINE_PATH,
  QPDF_PATH,
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
  pdfTargets,
  audioInput,
  unlockAudioInputs,
  videoInput,
  mediaAudioTargets,
  mediaVideoTargets,
  mediaTargets,
  experimentalInputsByCategory,
  experimentalInputSet,
  allTargets,
  downloads
};
