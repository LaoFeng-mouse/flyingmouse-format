// ocr.js — 飞鼠格式 OCR 运行时：tesseract 加载、worker 创建、图片/PDF 页文字识别。
// 第二批抽取自 server.js（零逻辑改动，纯搬移）。
// 顶层 require("./image") 获取 inspectImageMetadata（prepareImageForOcr 需要）；
// image.js 的 convertImage 延迟 require 本模块，避免顶层循环依赖。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { throwIfCanceled } = require("./conversion-cancellation");
const { TESSDATA_PATH } = require("./config");
const { LIMITS } = require("./resource-policy");
const { inspectImageMetadata } = require("./image");

let cachedTesseract = null;

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

async function prepareImageForOcr(inputPath) {
  const metadata = await inspectImageMetadata(inputPath);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ocr-image-"));
  const outputPath = path.join(tempDir, "ocr-input.png");
  const pipeline = sharp(inputPath, { limitInputPixels: LIMITS.maxImagePixels })
    .rotate()
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1 });

  // 中文 OCR 在约 300 DPI 时识别最稳：A4 宽度 8.27in × 300 ≈ 2480px。
  // 小于该宽度的图片放大到 2480，避免小字漏识别；更大的原图保持原分辨率。
  if (metadata.width && metadata.width < 2480) {
    pipeline.resize({ width: 2480, withoutEnlargement: false });
  }

  try {
    await pipeline.png().toFile(outputPath);
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { tempDir, outputPath };
}

function ocrError(code, zhCN, enUS, details = {}) {
  return Object.assign(new Error(zhCN), { code, errorCode: code, messages: { zhCN, enUS }, details });
}

async function createOcrWorker() {
  const ownedTasks = require("./owned-tasks");
  ownedTasks.assertAccepting();
  if (!ocrAvailable()) {
    throw ocrError("OCR_ENGINE_UNAVAILABLE",
      "OCR 引擎或中英文语言文件缺失，请修复或重新安装飞鼠格式。",
      "The OCR engine or Chinese/English language files are missing. Repair or reinstall FlyingMouse Format.");
  }

  const { createWorker } = loadTesseract();
  const paths = ocrRuntimePaths();
  // 语言集固定中英文：牺牲泰文，避免泰文模型抢认中文、产出乱码；中文识别优先。
  const worker = await ownedTasks.trackPendingWorker(createWorker("eng+chi_sim", 1, {
    langPath: paths.langPath,
    corePath: paths.corePath,
    workerPath: paths.workerPath,
    cacheMethod: "none"
  }));
  try {
    ownedTasks.assertAccepting();
    await worker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300"
    });
    ownedTasks.assertAccepting();
  } catch (error) {
    await worker.terminate().catch(() => {});
    throw error;
  }
  return worker;
}

// Confidence alone can hide one garbled heading in an otherwise readable page.
// Weight the low-confidence words by visible characters, retaining every original
// decimal separator and punctuation mark in the actual text (never guess amounts).
function ocrQuality(data) {
  const text = String(data?.text || "").replace(/\r\n/g, "\n").trim();
  const confidence = Number.isFinite(data?.confidence) ? Math.max(0, Math.min(100, data.confidence)) : null;
  const lines = (data?.blocks || []).flatMap((block) => (block.paragraphs || [])
    .flatMap((paragraph) => paragraph.lines || []));
  const words = lines.flatMap(line => line.words || []);
  let characters = 0;
  let weakCharacters = 0;
  let uncertainNumbers = false;
  let uncertainText = false;
  for (const word of words) {
    const length = String(word.text || "").replace(/\s/g, "").length;
    characters += length;
    if (Number.isFinite(word.confidence) && word.confidence < 60) weakCharacters += length;
    if (Number.isFinite(word.confidence) && word.confidence < 70 && /\d/.test(word.text || "")) uncertainNumbers = true;
    if (Number.isFinite(word.confidence) && word.confidence < 50 && length >= 2 && /[\p{L}\p{N}]/u.test(word.text || "")) uncertainText = true;
  }
  const weakFraction = characters ? weakCharacters / characters : 0;
  // Digital paragraphs on the same page must not dilute a broken scan heading
  // or body line. Judge long, predominantly uncertain lines independently; a
  // short isolated low-confidence token still gets the ordinary review warning.
  const unreliableLines = lines.filter(line => {
    let count = 0, weak = 0, weighted = 0;
    for (const word of line.words || []) {
      if (!Number.isFinite(word.confidence)) continue;
      const length = (String(word.text || '').match(/[\p{L}\p{N}]/gu) || []).length;
      count += length;
      weighted += length * word.confidence;
      if (word.confidence < 60) weak += length;
    }
    return count >= 6 && weighted / count < 45 && weak / count > 0.65;
  }).length;
  return { text, confidence, weakFraction, uncertainNumbers, uncertainText, unreliableLines };
}

function reliableOcr(result) {
  return Boolean(result.text && result.confidence >= 80 && result.weakFraction <= 0.2 && !result.unreliableLines);
}

function ocrCandidateScore(result) {
  if (!result.text) return -1;
  return (result.confidence ?? 0) - 20 * result.weakFraction - Math.min(45, 15 * result.unreliableLines);
}

async function recognizeImageResultWithWorker(worker, inputPath, options = {}) {
  throwIfCanceled(options.signal);
  const prepared = await prepareImageForOcr(inputPath);
  try {
    const recognize = async (imagePath, pageMode, orientation = 0) => {
      throwIfCanceled(options.signal);
      const { data } = await worker.recognize(imagePath, {
        rotateAuto: true,
        tessedit_pageseg_mode: pageMode
      }, { text: true, blocks: true });
      throwIfCanceled(options.signal);
      return {
        ...ocrQuality(data),
        orientation,
        deskewAngle: Number.isFinite(data?.rotateRadians) ? data.rotateRadians * 180 / Math.PI : 0,
        pageMode
      };
    };
    // SINGLE_BLOCK preserves the existing good document/amount recognition.
    // rotateAuto additionally corrects small scan angles using FindLines; it does
    // not require a new osd/legacy model or a second full recognition pass.
    let best = await recognize(prepared.outputPath, "6");
    const first = best;
    if (!reliableOcr(best)) {
      const automatic = await recognize(prepared.outputPath, "3");
      if (ocrCandidateScore(automatic) > ocrCandidateScore(best)) best = automatic;
    }
    // AUTO often recovers sideways lines itself. Only uncertain documents pay
    // for physical rotation retries; clear clean/skewed scans finish in one pass.
    if (!reliableOcr(best)) {
      const stats = await sharp(prepared.outputPath, { limitInputPixels: LIMITS.maxImagePixels })
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).stats();
      const blank = stats.channels.every((channel) => channel.stdev < 1);
      if (!blank) {
        // AUTO already handles most sideways text; an upside-down page is the
        // next useful candidate and should not need two wasted sideways passes.
        for (const orientation of [180, 90, 270]) {
          throwIfCanceled(options.signal);
          const rotatedPath = path.join(prepared.tempDir, `ocr-${orientation}.png`);
          await sharp(prepared.outputPath, { limitInputPixels: LIMITS.maxImagePixels })
            .rotate(orientation, { background: "#ffffff" }).png().toFile(rotatedPath);
          const candidate = await recognize(rotatedPath, "6", orientation);
          if (ocrCandidateScore(candidate) > ocrCandidateScore(best)) best = candidate;
          if (reliableOcr(best)) break;
        }
      }
    }
    if (best.text && ((best.confidence !== null && best.confidence < 60) || best.weakFraction > 0.5 || best.unreliableLines)) {
      const pageNumber = Number.isSafeInteger(options.pageNumber) && options.pageNumber > 0
        ? options.pageNumber : null;
      throw ocrError("OCR_LOW_CONFIDENCE",
        `${pageNumber ? `第 ${pageNumber} 页的` : ""}扫描文字识别质量过低，已停止导出以避免生成乱码。请核对该页的清晰度、方向和文字内容后重试。`,
        `OCR quality${pageNumber ? ` on page ${pageNumber}` : ""} is too low to export reliably. Check the scan's clarity, orientation and text before trying again.`,
        { confidence: best.confidence, unreliableLines: best.unreliableLines,
          ...(pageNumber ? { pageNumber } : {}) });
    }
    const warnings = [];
    if (best.orientation) warnings.push({ code: "OCR_ORIENTATION_CORRECTED", messages: {
      zhCN: `已自动旋转扫描件 ${best.orientation}° 识别，请核对文字和金额。`,
      enUS: `The scan was rotated ${best.orientation}° for OCR. Review the text and amounts.`
    } });
    if (Math.abs(best.deskewAngle) >= 0.3) warnings.push({ code: "OCR_DESKEWED", messages: {
      zhCN: "已自动校正扫描件倾斜，请核对文字和金额。",
      enUS: "The scan was automatically deskewed. Review the text and amounts."
    } });
    if (best.pageMode !== first.pageMode) warnings.push({ code: "OCR_LAYOUT_RECOVERED", messages: {
      zhCN: "已重新分析扫描件文字方向和布局，请核对阅读顺序、文字和金额。",
      enUS: "OCR recovered the text using automatic layout analysis. Review reading order, text and amounts."
    } });
    if (best.text && (!reliableOcr(best) || best.uncertainNumbers || best.uncertainText || best.weakFraction > 0.1)) {
      warnings.push({ code: "OCR_REVIEW_RECOMMENDED", messages: {
        zhCN: "部分文字或数字的识别置信度较低，请对照原件核对，尤其是金额、编号和标点。",
        enUS: "Some OCR text or numbers have low confidence. Check the original, especially amounts, identifiers and punctuation."
      } });
    }
    return { text: best.text, confidence: best.confidence, warnings, orientation: best.orientation, deskewAngle: best.deskewAngle };
  } finally {
    await fsp.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeImageTextWithWorker(worker, inputPath, options = {}) {
  return (await recognizeImageResultWithWorker(worker, inputPath, options)).text;
}

async function recognizeImageResult(inputPath, options = {}) {
  throwIfCanceled(options.signal);
  const metadata = await inspectImageMetadata(inputPath, true);
  const pageCount = Number(metadata.pages || 1);
  const worker = await createOcrWorker();
  let pageDirectory;
  try {
    if (metadata.format === "tiff" && pageCount > 1) {
      pageDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ocr-pages-"));
      const pages = [];
      const warnings = new Map();
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        throwIfCanceled(options.signal);
        // Decode only the current document page. Keeping a single worker avoids
        // loading Chinese/English models again for each page of a fax or scan.
        const pagePath = path.join(pageDirectory, "page.png");
        await sharp(inputPath, { page: pageIndex, pages: 1, limitInputPixels: LIMITS.maxImagePixels })
          .rotate().png().toFile(pagePath);
        const result = await recognizeImageResultWithWorker(worker, pagePath, { ...options, pageNumber: pageIndex + 1 });
        pages.push({ pageNumber: pageIndex + 1, ...result });
        for (const warning of result.warnings) warnings.set(warning.code, warning);
        await fsp.rm(pagePath, { force: true });
      }
      const recognizedPages = pages.filter(page => page.text.trim());
      if (recognizedPages.length < pages.length) warnings.set("OCR_PAGE_NO_TEXT", {
        code: "OCR_PAGE_NO_TEXT", messages: {
          zhCN: "部分 TIFF 页面未识别出文字，已保留页码占位；请确认这些页为空白或重新提供清晰扫描件。",
          enUS: "Some TIFF pages yielded no text. Page placeholders were retained; verify that these pages are blank or provide clearer scans."
        }
      });
      warnings.set("OCR_MULTIPAGE_DOCUMENT", { code: "OCR_MULTIPAGE_DOCUMENT", messages: {
        zhCN: `已按原顺序识别全部 ${pageCount} 页 TIFF，并保留页码，请核对各页文字。`,
        enUS: `All ${pageCount} TIFF pages were processed in source order with page labels. Review the text on each page.`
      } });
      const confidenceValues = recognizedPages.map(page => page.confidence).filter(Number.isFinite);
      return {
        text: recognizedPages.length ? pages.map(page => `第 ${page.pageNumber} 页 / Page ${page.pageNumber}\n${page.text || "[本页未识别出文字 / No text recognized on this page]"}`).join("\n\n") : "",
        confidence: confidenceValues.length ? Math.min(...confidenceValues) : 0,
        warnings: [...warnings.values()], orientation: 0, deskewAngle: 0, pages
      };
    }
    const result = await recognizeImageResultWithWorker(worker, inputPath, options);
    if (pageCount > 1) {
      // Animation frames are not separate document pages. Keep the established
      // first-frame behavior, but make the omitted frames visible to the user.
      result.warnings.push({ code: "ANIMATION_FLATTENED", messages: {
        zhCN: "动画图片只识别第一帧文字，其余帧未导出。",
        enUS: "OCR extracted text from the first animation frame only; remaining frames were not exported."
      } });
    }
    return result;
  } finally {
    try {
      await worker.terminate();
    } finally {
      if (pageDirectory) await fsp.rm(pageDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function recognizeImageText(inputPath, options = {}) {
  return (await recognizeImageResult(inputPath, options)).text;
}

async function convertImageToOcrText(inputPath, outputPath, options = {}) {
  const result = await recognizeImageResult(inputPath, options);
  throwIfCanceled(options.signal);
  if (!result.text) {
    throw ocrError("OCR_NO_TEXT", "OCR 没有识别出文字。请确认图片包含清晰的文字。",
      "OCR found no text. Check that the image contains legible text.");
  }
  await fsp.writeFile(outputPath, `${result.text}\n`, "utf8");
  return { warnings: result.warnings };
}

module.exports = {
  loadTesseract,
  ocrRuntimePaths,
  ocrAvailable,
  prepareImageForOcr,
  createOcrWorker,
  recognizeImageResultWithWorker,
  recognizeImageResult,
  recognizeImageTextWithWorker,
  recognizeImageText,
  convertImageToOcrText
};
