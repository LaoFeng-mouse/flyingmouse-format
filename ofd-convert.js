"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { PDFTOPPM_PATH } = require("./config");
const { LIMITS, assertPdfPages } = require("./resource-policy");
const { run } = require("./utils");
const { reportConversionProgress } = require("./conversion-progress");
const { throwIfCanceled } = require("./conversion-cancellation");

const VERIFY_DPI = 96;
const MAX_VERIFY_PIXELS = Math.min(LIMITS.maxImagePixels, 16 * 1024 * 1024);
const MAX_PDF_BYTES = Math.min(LIMITS.workingBytes, 256 * 1024 * 1024);
const ERROR_MESSAGES = {
  OFD_SOURCE_INVALID: ["OFD 源文件不存在、为空或不可读，无法转换。", "The OFD source is missing, empty, or unreadable."],
  OFD_INVALID_EXTENSION: ["仅支持转换 .ofd 格式的 OFD 文件。", "Only .ofd source files are supported."],
  OFD_INVALID_ARCHIVE: ["OFD 转 PDF 失败：压缩包损坏或包含无效资源路径。", "OFD to PDF failed: the archive is damaged or contains invalid resource paths."],
  OFD_INVALID_XML: ["OFD 文档结构无效，已停止转换。", "The OFD document structure is invalid."],
  OFD_MISSING_RESOURCE: ["OFD 缺少页面所需资源，已停止导出以避免内容丢失。", "An OFD page resource is missing. Export stopped to prevent content loss."],
  OFD_MISSING_PAGE: ["OFD 缺少声明的页面，已停止导出以避免丢页。", "A declared OFD page is missing. Export stopped to prevent page loss."],
  OFD_UNSUPPORTED_CONTENT: ["OFD 包含暂不支持的页面内容，已停止导出以避免内容丢失。", "The OFD contains unsupported page content. Export stopped to prevent content loss."],
  OFD_RESOURCE_LIMIT: ["OFD 超过本次安全处理预算，请拆分文档后重试。", "The OFD exceeds the processing budget. Split the document and retry."],
  OFD_RENDER_FAILED: ["OFD 转 PDF 失败，页面内容未能完整绘制。", "OFD to PDF failed because page content could not be fully rendered."],
  OFD_PAGE_COUNT_MISMATCH: ["OFD 转换后的页数与原文档不一致，已停止导出。", "The PDF page count differs from the OFD. Export stopped."],
  OFD_OUTPUT_BLANK: ["OFD 页面含有内容，但转换后的页面为空白，已停止导出。", "An OFD page contains content but its PDF page is blank. Export stopped."],
  OFD_OUTPUT_UNVERIFIED: ["无法确认 OFD 转换后的页面内容完整，已停止导出。", "The converted OFD pages could not be verified. Export stopped."],
  OFD_OUTPUT_VERIFICATION_UNAVAILABLE: ["PDF 页面检查组件不可用，请修复安装后重试。", "The PDF page verification component is unavailable. Repair the installation and retry."]
};

function ofdError(code, details = {}) {
  const [zhCN, enUS] = ERROR_MESSAGES[code] || ERROR_MESSAGES.OFD_RENDER_FAILED;
  return Object.assign(new Error(zhCN), { code, messages: { zhCN, enUS }, details });
}

// Each conversion owns its renderer instance and mutable font buffers, including
// overlapping requests; a consumed PDF subset buffer is never reused.
function purgeOfdConverterCache() {
  const renderer = require.resolve("./ofd-renderer");
  const existed = Boolean(require.cache[renderer]);
  delete require.cache[renderer];
  return existed ? 1 : 0;
}

async function verifyOfdPdf(pdfPath, inspection, { signal } = {}) {
  throwIfCanceled(signal);
  if (!inspection || !Number.isInteger(inspection.pageCount) || inspection.pageCount < 1
    || !Array.isArray(inspection.pages) || inspection.pages.length !== inspection.pageCount) {
    throw ofdError("OFD_OUTPUT_UNVERIFIED");
  }
  assertPdfPages(inspection.pageCount);
  const stat = await fsp.stat(pdfPath);
  if (!stat.isFile() || stat.size < 5 || stat.size > MAX_PDF_BYTES) throw ofdError("OFD_RESOURCE_LIMIT");
  let document;
  try { document = await PDFDocument.load(await fsp.readFile(pdfPath)); }
  catch { throw ofdError("OFD_OUTPUT_UNVERIFIED"); }
  if (document.getPageCount() !== inspection.pageCount) throw ofdError("OFD_PAGE_COUNT_MISMATCH");
  // Validation resolution never changes the exported PDF or its embedded data.
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const pixelWidth = Math.ceil(width * VERIFY_DPI / 72), pixelHeight = Math.ceil(height * VERIFY_DPI / 72);
    if (![width, height, pixelWidth, pixelHeight].every(value => Number.isFinite(value) && value > 0)
      || pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > MAX_VERIFY_PIXELS) {
      throw ofdError("OFD_RESOURCE_LIMIT");
    }
  }
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ofd-check-"));
  const pages = [];
  try {
    for (let index = 0; index < inspection.pageCount; index += 1) {
      throwIfCanceled(signal);
      reportConversionProgress({ stage: "validating", completed: index, total: inspection.pageCount, unit: "pages" });
      // libvips caches file sources. A different filename per page prevents a
      // previous visible page from hiding a later blank page during validation.
      const prefix = path.join(scratch, "page-" + (index + 1));
      try {
        await run(PDFTOPPM_PATH, ["-f", String(index + 1), "-l", String(index + 1), "-singlefile", "-png", "-r", String(VERIFY_DPI), pdfPath, prefix],
          { timeout: 60000, signal, maxStdoutBytes: 65536 });
      } catch (error) {
        throwIfCanceled(signal);
        if (error?.code === "CONVERSION_CANCELED") throw error;
        throw ofdError(error?.code === "ENOENT" ? "OFD_OUTPUT_VERIFICATION_UNAVAILABLE" : "OFD_OUTPUT_UNVERIFIED", { page: index + 1 });
      }
      throwIfCanceled(signal);
      let visible;
      try {
        const image = sharp(prefix + ".png", { limitInputPixels: MAX_VERIFY_PIXELS, failOn: "error" }).flatten({ background: "#ffffff" }).removeAlpha().toColourspace("srgb");
        const stats = await image.stats();
        visible = stats.channels.slice(0, 3).some(channel => channel.min < 255);
      } catch { throw ofdError("OFD_OUTPUT_UNVERIFIED", { page: index + 1 }); }
      const sourcePage = inspection.pages[index];
      const expectsVisible = sourcePage.expectsVisibleContent ?? sourcePage.hasContent;
      if (expectsVisible !== true && expectsVisible !== false) throw ofdError("OFD_OUTPUT_UNVERIFIED");
      if (expectsVisible && !visible) throw ofdError("OFD_OUTPUT_BLANK", { page: index + 1 });
      pages.push({ page: index + 1, visible, expectsVisible });
      await fsp.unlink(prefix + ".png");
    }
    reportConversionProgress({ stage: "validating", completed: pages.length, total: pages.length, unit: "pages" });
    return { pageCount: pages.length, pages };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

async function convertOfdToPdf(inputPath, outputPath, originalName, options = {}) {
  throwIfCanceled(options.signal);
  let stat;
  try { stat = await fsp.stat(inputPath); } catch { throw ofdError("OFD_SOURCE_INVALID"); }
  if (!stat.isFile() || stat.size === 0) throw ofdError("OFD_SOURCE_INVALID");
  if (path.extname(originalName || inputPath).toLowerCase() !== ".ofd") throw ofdError("OFD_INVALID_EXTENSION");
  const destination = path.resolve(outputPath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(path.dirname(destination), ".flyingmouse-ofd-"));
  try {
    purgeOfdConverterCache();
    const renderer = require("./ofd-renderer");
    let inspection;
    const pdf = await renderer.convert(inputPath, {
      silent: true, signal: options.signal, onInspect: value => { inspection = value; }
    });
    throwIfCanceled(options.signal);
    if (!(pdf instanceof Uint8Array) || !pdf.length || pdf.length > MAX_PDF_BYTES) throw ofdError("OFD_RESOURCE_LIMIT");
    const candidate = path.join(scratch, "candidate.pdf");
    await fsp.writeFile(candidate, pdf, { flag: "wx" });
    await verifyOfdPdf(candidate, inspection, options);
    throwIfCanceled(options.signal);
    // The candidate is fully verified before exclusive publication. Never
    // overwrite an unrelated pre-existing CLI destination.
    await fsp.copyFile(candidate, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === "CONVERSION_CANCELED" || error?.code === "EEXIST") throw error;
    if (error?.code && Object.hasOwn(ERROR_MESSAGES, error.code)) throw ofdError(error.code, error.details || {});
    if (error?.errorCode) throw error;
    throw ofdError("OFD_RENDER_FAILED");
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

module.exports = { convertOfdToPdf, purgeOfdConverterCache, verifyOfdPdf };
