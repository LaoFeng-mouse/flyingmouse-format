const sharp = require("sharp");
const { encodeBmpFromRaw } = require("./bmp-output");

const WARNING_MESSAGES = {
  ANIMATION_FLATTENED: {
    zhCN: "动画图片已转换为第一帧静态图片。",
    enUS: "The animated image was converted to its first static frame."
  },
  ALPHA_COMPOSITED_WHITE: {
    zhCN: "JPEG 不支持透明通道，透明区域已使用白色背景合成。",
    enUS: "JPEG does not support transparency, so transparent areas were composited onto white."
  }
};

function warning(code) {
  return { code, messages: WARNING_MESSAGES[code] };
}

function animationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function convertRasterImage(inputPath, outputPath, target, options = {}) {
  const maxPixels = options.maxPixels || Number.MAX_SAFE_INTEGER;
  const metadata = await sharp(inputPath, { animated: true, limitInputPixels: maxPixels }).metadata();
  const pages = Number(metadata.pages || 1);
  const animated = pages > 1;
  const normalizedTarget = target === "jpg" ? "jpeg" : target;
  const warnings = [];

  if (animated && normalizedTarget === "tiff") {
    throw animationError(
      "ANIMATION_TARGET_UNSUPPORTED",
      "Animated input cannot be converted to TIFF without losing frame timing."
    );
  }

  if (animated && normalizedTarget === "webp") {
    await sharp(inputPath, { animated: true, limitInputPixels: maxPixels })
      .rotate()
      .webp({ quality: 90 })
      .toFile(outputPath);
    const outputMetadata = await sharp(outputPath, { animated: true, limitInputPixels: maxPixels }).metadata();
    const inputDelay = Array.isArray(metadata.delay) ? metadata.delay.map(Number) : [];
    const outputDelay = Array.isArray(outputMetadata.delay) ? outputMetadata.delay.map(Number) : [];
    if (Number(outputMetadata.pages || 1) !== pages || JSON.stringify(outputDelay) !== JSON.stringify(inputDelay)) {
      throw animationError(
        "ANIMATION_PRESERVATION_FAILED",
        "Animated WebP output did not preserve frame count and timing."
      );
    }
    return { warnings };
  }

  if (animated && normalizedTarget === "gif") {
    await sharp(inputPath, { animated: true, limitInputPixels: maxPixels })
      .rotate()
      .gif()
      .toFile(outputPath);
    const outputMetadata = await sharp(outputPath, { animated: true, limitInputPixels: maxPixels }).metadata();
    if (Number(outputMetadata.pages || 1) !== pages) {
      throw animationError(
        "ANIMATION_PRESERVATION_FAILED",
        "Animated GIF output did not preserve the input frame count."
      );
    }
    return { warnings };
  }

  // BMP 输出：sharp 无 BMP 编码器，取第一帧（动图压平，与其它静态目标一致）
  // 转 raw RGB 后走自研 24 位编码器（bmp-output.js）。
  if (normalizedTarget === "bmp") {
    if (animated) warnings.push(warning("ANIMATION_FLATTENED"));
    const { data, info } = await sharp(inputPath, {
      page: 0,
      pages: 1,
      limitInputPixels: maxPixels
    }).rotate().raw().toBuffer({ resolveWithObject: true });
    const bmp = encodeBmpFromRaw({
      width: info.width,
      height: info.height,
      data,
      channels: info.channels >= 3 ? info.channels : 3
    });
    const fsp = require("fs/promises");
    await fsp.writeFile(outputPath, bmp);
    return { warnings };
  }

  const image = sharp(inputPath, {
    page: 0,
    pages: 1,
    limitInputPixels: maxPixels
  }).rotate();

  if (animated) warnings.push(warning("ANIMATION_FLATTENED"));
  if (normalizedTarget === "jpeg" && metadata.hasAlpha) {
    image.flatten({ background: { r: 255, g: 255, b: 255 } });
    warnings.push(warning("ALPHA_COMPOSITED_WHITE"));
  }
  const outputOptions = normalizedTarget === "jpeg"
    ? { quality: 90 }
    : (normalizedTarget === "webp" ? { quality: 90 } : (normalizedTarget === "tiff" ? { compression: "lzw" } : undefined));
  await image.toFormat(normalizedTarget, outputOptions).toFile(outputPath);
  return { warnings };
}

module.exports = { WARNING_MESSAGES, convertRasterImage };
