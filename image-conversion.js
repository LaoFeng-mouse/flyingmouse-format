const sharp = require("sharp");

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
  const maxPixels = options.maxPixels || 50_000_000;
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
      .webp()
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
  await image.toFormat(normalizedTarget, normalizedTarget === "jpeg" ? { quality: 90 } : undefined).toFile(outputPath);
  return { warnings };
}

module.exports = { WARNING_MESSAGES, convertRasterImage };
