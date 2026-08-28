const LIMITS = Object.freeze({
  maxImagePixels: 50_000_000,
  maxImageDimension: 16_384,
  maxImagePdfPixels: 100_000_000,
  maxBatchBytes: 2 * 1024 * 1024 * 1024
});

const STRUCTURE_LIMITS = Object.freeze({
  maxBlocksPerPage: 5000,
  maxTablesPerPage: 100,
  maxCellsPerTable: 20000,
  maxTotalBlocks: 50000,
  maxTotalTables: 1000,
  maxTotalCells: 200000,
  maxManifestNodes: 1000000,
  maxNestingDepth: 64
});

const MESSAGES = Object.freeze({
  IMAGE_METADATA_INVALID: {
    zhCN: "无法读取图片尺寸，请确认图片文件完整。",
    enUS: "The image dimensions could not be read. Make sure the image is valid."
  },
  IMAGE_PIXELS_EXCEEDED: {
    zhCN: "图片解码像素超过 5000 万限制，请缩小图片后重试。",
    enUS: "The decoded image exceeds the 50 megapixel limit. Resize it and try again."
  },
  IMAGE_DIMENSION_EXCEEDED: {
    zhCN: "图片单边尺寸超过 16384 像素限制，请缩小图片后重试。",
    enUS: "One image dimension exceeds the 16,384 pixel limit. Resize it and try again."
  },
  IMAGE_PDF_BUDGET_EXCEEDED: {
    zhCN: "合并图片的总解码像素超过 1 亿限制，请减少图片或缩小尺寸。",
    enUS: "The images exceed the 100 megapixel PDF merge budget. Remove or resize some images."
  },
  BATCH_BYTES_EXCEEDED: {
    zhCN: "本批文件总大小超过 2GB，请分批转换。",
    enUS: "This batch exceeds the 2 GB limit. Convert the files in smaller batches."
  },
  BATCH_FILE_SIZE_INVALID: {
    zhCN: "无法确认批量文件大小，已停止处理以保护系统资源。",
    enUS: "A batch file size is invalid. Processing stopped to protect system resources."
  },
  PDF_PAGE_COUNT_INVALID: {
    zhCN: "无法读取 PDF 页数，请确认 PDF 文件完整且未损坏。",
    enUS: "The PDF page count could not be read. Make sure the PDF is valid."
  }
});

// 把消息里的 {key} 占位符替换为 details 里的值（如 {pages}）
function renderMessage(text, details) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    details[key] != null ? String(details[key]) : match
  );
}

class ResourceLimitError extends Error {
  constructor(errorCode, details = {}) {
    const messages = MESSAGES[errorCode] || {
      zhCN: "文件超出资源限制。",
      enUS: "The file exceeds a resource limit."
    };
    super(renderMessage(messages.zhCN, details));
    this.name = "ResourceLimitError";
    this.errorCode = errorCode;
    this.messages = {
      zhCN: renderMessage(messages.zhCN, details),
      enUS: renderMessage(messages.enUS, details)
    };
    this.details = details;
  }
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function imageDecodedPixels(metadata) {
  const width = positiveInteger(metadata?.width);
  const height = positiveInteger(metadata?.height);
  if (!width || !height) throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  const pages = positiveInteger(metadata?.pages) || 1;
  const declaredPageHeight = metadata?.pageHeight == null ? 0 : positiveInteger(metadata.pageHeight);
  if (metadata?.pageHeight != null && !declaredPageHeight) {
    throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  }
  if (height % pages !== 0) throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  const frameHeight = declaredPageHeight || (height / pages);
  if (frameHeight * pages !== height) throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  return width * frameHeight * pages;
}

function assertImageMetadata(metadata) {
  const width = positiveInteger(metadata?.width);
  const totalHeight = positiveInteger(metadata?.height);
  if (!width || !totalHeight) throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  const pages = positiveInteger(metadata?.pages) || 1;
  const frameHeight = positiveInteger(metadata?.pageHeight) || (totalHeight % pages === 0 ? totalHeight / pages : 0);
  if (!frameHeight || frameHeight * pages !== totalHeight) {
    throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  }
  if (width > LIMITS.maxImageDimension || frameHeight > LIMITS.maxImageDimension) {
    throw new ResourceLimitError("IMAGE_DIMENSION_EXCEEDED", { width, height: frameHeight });
  }
  const pixels = imageDecodedPixels(metadata);
  if (pixels > LIMITS.maxImagePixels) {
    throw new ResourceLimitError("IMAGE_PIXELS_EXCEEDED", { pixels });
  }
  return pixels;
}

function assertImagePdfBudget(metadataList) {
  let total = 0;
  for (const metadata of metadataList || []) {
    total += assertImageMetadata(metadata);
    if (total > LIMITS.maxImagePdfPixels) {
      throw new ResourceLimitError("IMAGE_PDF_BUDGET_EXCEEDED", { pixels: total });
    }
  }
  return total;
}

function assertBatchBytes(files) {
  let total = 0;
  for (const file of files || []) {
    if (typeof file?.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new ResourceLimitError("BATCH_FILE_SIZE_INVALID");
    }
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new ResourceLimitError("BATCH_FILE_SIZE_INVALID");
  }
  if (total > LIMITS.maxBatchBytes) {
    throw new ResourceLimitError("BATCH_BYTES_EXCEEDED", { bytes: total });
  }
  return total;
}

// PDF 页数不做上限限制（原文件多少页就转换多少页，1:1 还原；加载慢由用户自行权衡）。
// 这里只校验页数是有效正整数。
function assertPdfPages(pageCount) {
  const count = positiveInteger(pageCount);
  if (!count) throw new ResourceLimitError("PDF_PAGE_COUNT_INVALID");
  return count;
}

module.exports = {
  LIMITS,
  STRUCTURE_LIMITS,
  ResourceLimitError,
  imageDecodedPixels,
  assertImageMetadata,
  assertImagePdfBudget,
  assertBatchBytes,
  assertPdfPages
};
