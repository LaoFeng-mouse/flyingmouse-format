const fsp = require("node:fs/promises");
const { loadPdfjs } = require("./pdfjs");

const MIN_NATIVE_CHARACTERS = 24;
const MIN_PRINTABLE_RATIO = 0.8;
const FULL_PAGE_IMAGE_COVERAGE = 0.7;

function boundedNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function classifyPageMetrics(metrics = {}) {
  const characterCount = boundedNumber(metrics.characterCount);
  const printableRatio = boundedNumber(metrics.printableRatio, 0, 1);
  const imageCoverage = boundedNumber(metrics.imageCoverage, 0, 1);
  const reliableText = characterCount >= MIN_NATIVE_CHARACTERS
    && printableRatio >= MIN_PRINTABLE_RATIO;
  return reliableText && imageCoverage < FULL_PAGE_IMAGE_COVERAGE ? "native" : "scanned";
}

function classifyDocument(pages = []) {
  const normalized = pages.map((page, index) => {
    const metrics = {
      pageNumber: Number.isInteger(page.pageNumber) && page.pageNumber > 0
        ? page.pageNumber
        : index + 1,
      characterCount: boundedNumber(page.characterCount),
      printableRatio: boundedNumber(page.printableRatio, 0, 1),
      imageCoverage: boundedNumber(page.imageCoverage, 0, 1)
    };
    return { ...metrics, kind: classifyPageMetrics(metrics) };
  });
  const kinds = new Set(normalized.map((page) => page.kind));
  return {
    kind: kinds.size > 1 ? "mixed" : normalized[0]?.kind || "scanned",
    pages: normalized
  };
}

function imagePaintOperators(OPS = {}) {
  return new Set([
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintSolidColorImageMask
  ].filter(Number.isInteger));
}

function textMetrics(textContent) {
  const characters = (textContent?.items || [])
    .flatMap((item) => Array.from(typeof item.str === "string" ? item.str : ""))
    .filter((character) => !/\s/u.test(character));
  const printableCount = characters.filter((character) => !/\p{C}/u.test(character)).length;
  return {
    characterCount: characters.length,
    printableRatio: characters.length ? printableCount / characters.length : 0
  };
}

async function classifyPdf(inputPath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(inputPath));
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });

  try {
    const pdf = await loadingTask.promise;
    const imageOperators = imagePaintOperators(pdfjs.OPS);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList()
      ]);
      const metrics = textMetrics(textContent);
      const paintsPageImage = operatorList.fnArray.some((operator) => imageOperators.has(operator));
      pages.push({
        pageNumber,
        ...metrics,
        imageCoverage: paintsPageImage && metrics.characterCount < MIN_NATIVE_CHARACTERS ? 1 : 0
      });
    }
    return classifyDocument(pages);
  } finally {
    await loadingTask.destroy();
  }
}

module.exports = {
  MIN_NATIVE_CHARACTERS,
  MIN_PRINTABLE_RATIO,
  FULL_PAGE_IMAGE_COVERAGE,
  classifyPageMetrics,
  classifyDocument,
  classifyPdf
};
