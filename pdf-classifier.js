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
  const printableShortText = characterCount > 0
    && characterCount < MIN_NATIVE_CHARACTERS
    && printableRatio >= MIN_PRINTABLE_RATIO;
  return ((reliableText || printableShortText) && imageCoverage < FULL_PAGE_IMAGE_COVERAGE)
    ? "native"
    : "scanned";
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

function multiplyTransforms(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function rectangleUnionArea(rectangles) {
  const valid = rectangles.filter((rectangle) => {
    const values = [rectangle?.x0, rectangle?.y0, rectangle?.x1, rectangle?.y1];
    return values.every(Number.isFinite)
      && rectangle.x1 > rectangle.x0
      && rectangle.y1 > rectangle.y0;
  });
  const xValues = [...new Set(valid.flatMap((rectangle) => [rectangle.x0, rectangle.x1]))]
    .sort((left, right) => left - right);
  let area = 0;
  for (let index = 0; index < xValues.length - 1; index += 1) {
    const x0 = xValues[index];
    const x1 = xValues[index + 1];
    if (x1 <= x0) continue;
    const intervals = valid
      .filter((rectangle) => rectangle.x0 < x1 && rectangle.x1 > x0)
      .map((rectangle) => [rectangle.y0, rectangle.y1])
      .sort((left, right) => left[0] - right[0]);
    let coveredHeight = 0;
    let currentStart;
    let currentEnd;
    for (const [start, end] of intervals) {
      if (currentStart === undefined) {
        currentStart = start;
        currentEnd = end;
      } else if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end);
      } else {
        coveredHeight += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      }
    }
    if (currentStart !== undefined) coveredHeight += currentEnd - currentStart;
    area += (x1 - x0) * coveredHeight;
  }
  return area;
}

function imageCoverageFromOperators(operatorList, OPS, viewport) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const initialTransform = Array.from(viewport?.transform || [], Number);
  if (!(width > 0 && height > 0) || initialTransform.length !== 6 || !initialTransform.every(Number.isFinite)) {
    return 0;
  }
  const imageOperators = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject
  ].filter(Number.isInteger));
  let transform = initialTransform;
  const stack = [];
  const rectangles = [];
  for (let index = 0; index < (operatorList?.fnArray || []).length; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === OPS.save) {
      stack.push(transform.slice());
      continue;
    }
    if (operator === OPS.restore) {
      if (stack.length) transform = stack.pop();
      continue;
    }
    if (operator === OPS.transform) {
      const next = Array.from(operatorList.argsArray[index] || [], Number);
      if (next.length === 6 && next.every(Number.isFinite)) {
        transform = multiplyTransforms(transform, next);
      }
      continue;
    }
    if (!imageOperators.has(operator)) continue;
    const points = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ].map(([x, y]) => ({
      x: transform[0] * x + transform[2] * y + transform[4],
      y: transform[1] * x + transform[3] * y + transform[5]
    }));
    if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
    const x0 = Math.max(0, Math.min(...points.map((point) => point.x)));
    const y0 = Math.max(0, Math.min(...points.map((point) => point.y)));
    const x1 = Math.min(width, Math.max(...points.map((point) => point.x)));
    const y1 = Math.min(height, Math.max(...points.map((point) => point.y)));
    if (x1 > x0 && y1 > y0) rectangles.push({ x0, y0, x1, y1 });
  }
  return Math.min(1, Math.max(0, rectangleUnionArea(rectangles) / (width * height)));
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
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList()
      ]);
      const metrics = textMetrics(textContent);
      pages.push({
        pageNumber,
        ...metrics,
        imageCoverage: imageCoverageFromOperators(operatorList, pdfjs.OPS, viewport)
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
  rectangleUnionArea,
  imageCoverageFromOperators,
  classifyPageMetrics,
  classifyDocument,
  classifyPdf
};
