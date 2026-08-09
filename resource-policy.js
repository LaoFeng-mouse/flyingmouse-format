const LIMITS = Object.freeze({
  maxImagePixels: 50_000_000,
  maxImageDimension: 16_384,
  maxImagePdfPixels: 100_000_000,
  maxBatchBytes: 2 * 1024 * 1024 * 1024,
  maxPdfPages: 500,
  maxOcrPdfPages: 100
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
  },
  PDF_PAGES_EXCEEDED: {
    zhCN: "PDF 超过 500 页限制，请拆分后重试。",
    enUS: "The PDF exceeds the 500 page limit. Split it and try again."
  },
  OCR_PDF_PAGES_EXCEEDED: {
    zhCN: "OCR 最多处理 100 页 PDF，请拆分后重试。",
    enUS: "OCR supports PDFs up to 100 pages. Split the PDF and try again."
  }
});

class ResourceLimitError extends Error {
  constructor(errorCode, details = {}) {
    const messages = MESSAGES[errorCode] || {
      zhCN: "文件超出资源限制。",
      enUS: "The file exceeds a resource limit."
    };
    super(messages.zhCN);
    this.name = "ResourceLimitError";
    this.errorCode = errorCode;
    this.messages = messages;
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
  const frameHeight = positiveInteger(metadata?.pageHeight) || Math.ceil(height / pages);
  return width * frameHeight * pages;
}

function assertImageMetadata(metadata) {
  const width = positiveInteger(metadata?.width);
  const height = positiveInteger(metadata?.pageHeight) || positiveInteger(metadata?.height);
  if (!width || !height) throw new ResourceLimitError("IMAGE_METADATA_INVALID");
  if (width > LIMITS.maxImageDimension || height > LIMITS.maxImageDimension) {
    throw new ResourceLimitError("IMAGE_DIMENSION_EXCEEDED", { width, height });
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

function assertPdfPages(pageCount, { ocr = false } = {}) {
  const count = positiveInteger(pageCount);
  if (!count) throw new ResourceLimitError("PDF_PAGE_COUNT_INVALID");
  const maximum = ocr ? LIMITS.maxOcrPdfPages : LIMITS.maxPdfPages;
  if (count > maximum) {
    throw new ResourceLimitError(ocr ? "OCR_PDF_PAGES_EXCEEDED" : "PDF_PAGES_EXCEEDED", { pages: count });
  }
  return count;
}

module.exports = {
  LIMITS,
  ResourceLimitError,
  imageDecodedPixels,
  assertImageMetadata,
  assertImagePdfBudget,
  assertBatchBytes,
  assertPdfPages
};
