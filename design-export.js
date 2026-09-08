// design-export.js — 设计稿（.ai / .psd）→ 图片导出链路（2026-09-08 新增）。
// .ai 现代文件本质是 PDF 封装（实测泰文包装稿 poppler 直渲无缺字），复制到临时目录
// 改后缀 .pdf 后与 PDF 共用 renderPdfPages/emitPdfPageImages 链路；.psd 先经
// LibreOffice Draw 转 PDF（实测图层合成完整）再走同一条链路。产物装配（单页散图 /
// 多页按源名打 zip）由 server.js 调用方完成。

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

// 设计稿转「可渲染的 PDF」：ai=PDF 封装直接改名，psd=LibreOffice Draw 中转。
// tempDir 由调用方负责最终清理（emit 的 zip 装配完成后统一 rm）。
async function normalizeDesignToPdf(inputPath, inputExt) {
  const { convertWithLibreOffice } = require("./office-convert");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-design-"));
  const pdfPath = path.join(tempDir, "design.pdf");
  if (inputExt === "ai") {
    // Illustrator 自 CS 起默认「PDF 兼容」保存，文件头即 %PDF；无兼容的旧版会在
    // renderPdfPages 的 PDFDocument.load 处报错（宁可不给也不给错图）。
    await fsp.copyFile(inputPath, pdfPath);
  } else {
    await convertWithLibreOffice(inputPath, pdfPath, `design.${inputExt}`, "pdf");
  }
  return { pdfPath, tempDir };
}

// 设计稿 → 单张 PNG（供 convertImage 的通用图片链路消费）。ext 显式传入（'ai'|'psd'，
// multer 临时文件无扩展名）。ai：poppler 栅格化第 1 页；psd：LibreOffice 直接导图
// （实测图层合成完整，省一跳）。
async function designToPng(inputPath, ext) {
  const { renderPdfPages } = require("./pdf");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-design-input-"));
  const pngPath = path.join(tempDir, "decoded.png");
  try {
    if (ext === "ai") {
      const normalized = await normalizeDesignToPdf(inputPath, ext);
      try {
        const rendered = await renderPdfPages(normalized.pdfPath, "png", 300);
        try {
          if (!rendered.files.length) throw new Error("AI 文件栅格化失败：未渲染出任何页面。");
          await fsp.copyFile(rendered.files[0], pngPath);
        } finally {
          await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
        }
      } finally {
        await fsp.rm(normalized.tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      const { convertWithLibreOffice } = require("./office-convert");
      const loOut = path.join(tempDir, "flat.png");
      await convertWithLibreOffice(inputPath, loOut, `design.${ext}`, "png");
      await fsp.copyFile(loOut, pngPath);
      await fsp.rm(loOut, { force: true }).catch(() => {});
    }
    return { inputPath: pngPath, tempDir };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { normalizeDesignToPdf, designToPng };
