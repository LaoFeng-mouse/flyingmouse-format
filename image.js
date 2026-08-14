// image.js — 飞鼠格式图片转换域：图片解码/中转、图片→PDF、图片→视频、OCR 输入预处理。
// 第二批抽取自 server.js（零逻辑改动，纯搬移）。
// 注意：convertImage 的 OCR 分支延迟 require("./ocr")，避免与 ocr.js 顶层循环依赖
//（ocr.js 需要本模块的 inspectImageMetadata，本模块需要 ocr.js 的 convertImageToOcrText）。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const sharp = require("sharp");
const { FFMPEG_PATH, DCRAW_PATH, rawInput } = require("./config");
const RAW_EXTENSIONS = rawInput;
const { run } = require("./utils");
const {
  LIMITS,
  ResourceLimitError,
  assertImageMetadata,
  assertImagePdfBudget
} = require("./resource-policy");
const { isBmpFileSync, decodeBmpToRaw } = require("./bmp-input");
const { isIcoFileSync, extractBestFrame, encodeIco } = require("./ico-format");
const { convertRasterImage, WARNING_MESSAGES } = require("./image-conversion");

// ICO 输出：把输入图缩放到多尺寸（16/24/32/48/64/128/256）生成 PNG 帧，组装成 ICO 容器。
// ICO 是静态格式；动图只取第一帧并附动画压平警告（与其它静态图片目标一致）。
async function convertToIco(inputPath, outputPath) {
  const metadata = await sharp(inputPath, { animated: true, limitInputPixels: LIMITS.maxImagePixels }).metadata();
  const animated = Number(metadata.pages || 1) > 1;
  const warnings = [];
  if (animated) warnings.push({ code: "ANIMATION_FLATTENED", messages: WARNING_MESSAGES.ANIMATION_FLATTENED });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) {
    const png = await sharp(inputPath, { page: 0, pages: 1, limitInputPixels: LIMITS.maxImagePixels })
      .rotate()
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    frames.push({ size, data: png });
  }
  await fsp.writeFile(outputPath, encodeIco(frames));
  return { warnings };
}

async function convertImage(inputPath, outputPath, target) {
  const prepared = await prepareImageInput(inputPath);
  try {
    if (target === "pdf") {
      await convertImagesToPdf([{ inputPath: prepared.inputPath, originalName: path.basename(prepared.inputPath) }], outputPath);
      return { warnings: [] };
    }

    if (target === "txt") {
      const { convertImageToOcrText } = require("./ocr");
      await convertImageToOcrText(prepared.inputPath, outputPath);
      return { warnings: [] };
    }

    if (target === "ico") {
      return await convertToIco(prepared.inputPath, outputPath);
    }

    if (target === "mp4" || target === "webm") {
      await convertImageToVideo(prepared.inputPath, outputPath, target);
      return { warnings: [] };
    }

    await inspectImageMetadata(prepared.inputPath, true);
    // 必须 await：finally 会删除 BMP 解码的临时目录，未 await 时删除先于转换完成，
    // macOS（文件可删）会报 decoded.png missing，Windows（句柄占用删除失败）侥幸通过。
    const result = await convertRasterImage(prepared.inputPath, outputPath, target, { maxPixels: LIMITS.maxImagePixels });
    return result;
  } finally {
    if (prepared.tempDir) await fsp.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// sharp 的预编译构建不支持 BMP 输入（无解码器）且 libheif 只编译了 AV1（AVIF），
// HEIC/HEIF（HEVC 编码）能读元数据但解不了像素。这里统一中转：
//   - BMP   -> 纯 JS 解码成 PNG
//   - HEIC  -> 打包内置 ffmpeg（含 hevc 解码器）转 PNG
// 让下游统一走 PNG。
async function prepareImageInput(inputPath) {
  // 先读文件头判断（不整读大图）；只有需要中转的格式才解码进内存。
  if (isIcoFileSync(inputPath)) {
    // ICO 容器：提取最清晰帧（PNG 帧直接落盘；BMP DIB 帧解码成 raw 再转 PNG）。
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ico-input-"));
    const pngPath = path.join(tempDir, "decoded.png");
    const frame = extractBestFrame(await fsp.readFile(inputPath));
    if (frame.png) {
      await fsp.writeFile(pngPath, frame.data);
    } else {
      const { width, height, data } = decodeBmpToRaw(frame.data);
      await sharp(data, { raw: { width, height, channels: 3 }, limitInputPixels: LIMITS.maxImagePixels })
        .png()
        .toFile(pngPath);
    }
    return { inputPath: pngPath, tempDir };
  }

  if (isBmpFileSync(inputPath)) {
    const { width, height, data } = decodeBmpToRaw(await fsp.readFile(inputPath));
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-bmp-input-"));
    const pngPath = path.join(tempDir, "decoded.png");
    await sharp(data, { raw: { width, height, channels: 3 }, limitInputPixels: LIMITS.maxImagePixels })
      .png()
      .toFile(pngPath);
    return { inputPath: pngPath, tempDir };
  }

  if (isHeicFileSync(inputPath)) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-heic-input-"));
    const pngPath = path.join(tempDir, "decoded.png");
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", inputPath, pngPath], { timeout: 1000 * 60 * 5 });
    if (!fs.existsSync(pngPath)) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error("HEIC 图片解码失败：无法从该文件提取像素数据。");
    }
    return { inputPath: pngPath, tempDir };
  }

  if (isTgaFileSync(inputPath)) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-tga-input-"));
    const pngPath = path.join(tempDir, "decoded.png");
    // -frames:v 1 确保只输出单帧（避免 image2 序列名警告，也防止多帧 TGA 撑爆输出）。
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", inputPath, "-frames:v", "1", pngPath], { timeout: 1000 * 60 * 5 });
    if (!fs.existsSync(pngPath)) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error("TGA 图片解码失败：无法从该文件提取像素数据。");
    }
    return { inputPath: pngPath, tempDir };
  }

  // 相机 RAW 原片（CR2/NEF/ARW/DNG 等）：sharp/libvips 无 dcraw delegate，用打包内置
  // dcraw.exe 解出 16-bit TIFF（sRGB）让下游统一走 sharp。
  if (isRawFileSync(inputPath)) {
    if (!DCRAW_PATH) {
      throw new Error("RAW 解码引擎（dcraw）不可用：未找到 dcraw.exe。");
    }
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-raw-input-"));
    // dcraw 不支持 -O（部分版本报 Unknown option），输出 <basename>.tiff 固定生成在输入
    // 所在目录。先把输入复制到临时目录再解码：源目录可能只读（U 盘/系统目录），
    // 且避免在用户目录残留 .tiff。
    const tempInput = path.join(tempDir, path.basename(inputPath));
    await fsp.copyFile(inputPath, tempInput);
    // dcraw -T 输出 16-bit TIFF；-o 1 = sRGB 色彩空间（默认 ACES 线性会偏灰，勿去掉）
    await run(DCRAW_PATH, ["-T", "-o", "1", tempInput], { timeout: 1000 * 60 * 5 });
    const stem = path.basename(tempInput, path.extname(tempInput));
    const tiffCandidates = [
      path.join(tempDir, `${stem}.tiff`),
      path.join(tempDir, `${stem}.tif`)
    ];
    const tiffPath = tiffCandidates.find((c) => fs.existsSync(c));
    if (!tiffPath) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error("RAW 图片解码失败：无法从该文件提取像素数据。");
    }
    return { inputPath: tiffPath, tempDir };
  }

  return { inputPath, tempDir: null };
}

// 相机 RAW 扩展名白名单（与 config.rawInput 对应；按扩展名判断，不读文件头——
// RAW 无统一魔数，dcraw 靠内容识别，这里先按扩展名分流）
function isRawFileSync(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return RAW_EXTENSIONS.has(ext);
}

// HEIC/HEIF 是 ISO BMFF 容器（ftyp 盒子），major brand 为 heic/heif/mif1/heix/heim；
// AVIF（avif/avis）sharp 原生可解，不在此中转范围。
function isHeicFileSync(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, 12, 0);
    if (read < 12) return false;
    const boxType = header.toString("latin1", 4, 8);
    const majorBrand = header.toString("latin1", 8, 12).toLowerCase();
    return boxType === "ftyp" && ["heic", "heif", "mif1", "heix", "heim"].includes(majorBrand);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// TGA（Truevision Targa）是简单位图容器：18 字节头（imageType 字段）+ 可选调色板 +
// 像素数据（未压缩或 RLE）。sharp/libvips 无 TGA 解码器，但内置 ffmpeg 支持，按扩展名
// 分流（与 RAW 同理，TGA 无统一魔数）。旧版 TGA 尾部可能带 "TRUEVISION-XFILE." 签名，
// 但很多软件不写，不能作为可靠判据。
function isTgaFileSync(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return ext === "tga";
}

async function inspectImageMetadata(inputPath, animated = false) {
  let metadata;
  try {
    metadata = await sharp(inputPath, {
      animated,
      limitInputPixels: LIMITS.maxImagePixels
    }).metadata();
  } catch (error) {
    if (/pixel limit|input image exceeds/i.test(String(error?.message || ""))) {
      throw new ResourceLimitError("IMAGE_PIXELS_EXCEEDED");
    }
    throw error;
  }
  assertImageMetadata(metadata);
  return metadata;
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

function pdfAscii(value) {
  return Buffer.from(value, "latin1");
}

function pdfNumber(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "");
}

async function readImageForPdf(inputPath) {
  // sharp 的预编译构建不支持 BMP 输入：批量/ZIP 图片合并 PDF 时直接解码 BMP。
  // 先读文件头判断，避免把非 BMP 大图整读进内存。
  if (isBmpFileSync(inputPath)) {
    const rawBmp = decodeBmpToRaw(fs.readFileSync(inputPath));
    return {
      width: rawBmp.width,
      height: rawBmp.height,
      data: zlib.deflateSync(rawBmp.data)
    };
  }

  // HEIC/HEIF（HEVC）sharp 解不了像素，用 ffmpeg 转 PNG 再提取 raw。
  if (isHeicFileSync(inputPath)) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-heic-pdf-"));
    try {
      const pngPath = path.join(tempDir, "decoded.png");
      await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", inputPath, pngPath], { timeout: 1000 * 60 * 5 });
      return await readPngAsPdfImage(pngPath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // TGA 同理：sharp 无解码器，用 ffmpeg 转 PNG 再提取 raw（图片合并 PDF 路径）。
  if (isTgaFileSync(inputPath)) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-tga-pdf-"));
    try {
      const pngPath = path.join(tempDir, "decoded.png");
      await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", inputPath, "-frames:v", "1", pngPath], { timeout: 1000 * 60 * 5 });
      return await readPngAsPdfImage(pngPath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return readPngAsPdfImage(inputPath);
}

async function readPngAsPdfImage(inputPath) {
  const { data, info } = await sharp(inputPath, { limitInputPixels: LIMITS.maxImagePixels })
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

  const metadataList = [];
  for (const file of imageFiles) {
    if (file?.blank) {
      metadataList.push({ width: 595, height: 842, pages: 1, pageHeight: 842 });
      continue;
    }
    metadataList.push(await inspectImageMetadata(file.inputPath));
  }
  assertImagePdfBudget(metadataList);

  const images = [];
  for (const file of imageFiles) {
    if (file?.blank) {
      // 空白页：A4 竖版比例（595×842pt），纯白 RGB 图像，deflate 压缩
      const blankWidth = 595;
      const blankHeight = 842;
      const rgb = Buffer.alloc(blankWidth * blankHeight * 3, 0xff);
      images.push({
        width: blankWidth,
        height: blankHeight,
        data: zlib.deflateSync(rgb)
      });
      continue;
    }
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

module.exports = {
  convertImage,
  prepareImageInput,
  isHeicFileSync,
  isTgaFileSync,
  isRawFileSync,
  inspectImageMetadata,
  convertImageToVideo,
  pdfAscii,
  pdfNumber,
  readImageForPdf,
  readPngAsPdfImage,
  convertImagesToPdf
};
