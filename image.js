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
const { FFMPEG_PATH } = require("./config");
const { run } = require("./utils");
const {
  LIMITS,
  ResourceLimitError,
  assertImageMetadata,
  assertImagePdfBudget
} = require("./resource-policy");
const { isBmpFileSync, decodeBmpToRaw } = require("./bmp-input");
const { convertRasterImage } = require("./image-conversion");

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

  return { inputPath, tempDir: null };
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
  for (const file of imageFiles) metadataList.push(await inspectImageMetadata(file.inputPath));
  assertImagePdfBudget(metadataList);

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

module.exports = {
  convertImage,
  prepareImageInput,
  isHeicFileSync,
  inspectImageMetadata,
  convertImageToVideo,
  pdfAscii,
  pdfNumber,
  readImageForPdf,
  readPngAsPdfImage,
  convertImagesToPdf
};
