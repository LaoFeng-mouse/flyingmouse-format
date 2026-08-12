// ocr.js — 飞鼠格式 OCR 运行时：tesseract 加载、worker 创建、图片/PDF 页文字识别。
// 第二批抽取自 server.js（零逻辑改动，纯搬移）。
// 顶层 require("./image") 获取 inspectImageMetadata（prepareImageForOcr 需要）；
// image.js 的 convertImage 延迟 require 本模块，避免顶层循环依赖。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
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
    && fs.existsSync(path.join(paths.langPath, "tha.traineddata.gz"))
    && fs.existsSync(paths.corePath)
    && fs.existsSync(paths.workerPath)
  );
}

async function prepareImageForOcr(inputPath) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ocr-image-"));
  const outputPath = path.join(tempDir, "ocr-input.png");
  const metadata = await inspectImageMetadata(inputPath);
  const pipeline = sharp(inputPath, { limitInputPixels: LIMITS.maxImagePixels })
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
  const worker = await createWorker("eng+chi_sim+tha", 1, {
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

module.exports = {
  loadTesseract,
  ocrRuntimePaths,
  ocrAvailable,
  prepareImageForOcr,
  createOcrWorker,
  recognizeImageTextWithWorker,
  recognizeImageText,
  convertImageToOcrText
};
