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

function finiteNumericArray(value, expectedLength) {
  try {
    const numbers = Array.from(value || [], Number);
    return numbers.length === expectedLength && numbers.every(Number.isFinite)
      ? numbers
      : null;
  } catch {
    return null;
  }
}

function transformedRectangleBounds(transform, rectangle) {
  const points = [
    [rectangle.x0, rectangle.y0],
    [rectangle.x1, rectangle.y0],
    [rectangle.x0, rectangle.y1],
    [rectangle.x1, rectangle.y1]
  ].map(([x, y]) => ({
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5]
  }));
  if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    return null;
  }
  return {
    x0: Math.min(...points.map((point) => point.x)),
    y0: Math.min(...points.map((point) => point.y)),
    x1: Math.max(...points.map((point) => point.x)),
    y1: Math.max(...points.map((point) => point.y))
  };
}

function intersectRectangles(left, right) {
  if (!left || !right) return null;
  const intersection = {
    x0: Math.max(left.x0, right.x0),
    y0: Math.max(left.y0, right.y0),
    x1: Math.min(left.x1, right.x1),
    y1: Math.min(left.y1, right.y1)
  };
  return intersection.x1 > intersection.x0 && intersection.y1 > intersection.y0
    ? intersection
    : null;
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
  const directImageOperators = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject
  ].filter(Number.isInteger));
  const unitRectangle = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const pageRectangle = { x0: 0, y0: 0, x1: width, y1: height };
  let state = { transform: initialTransform, clip: pageRectangle };
  let graphicsStack = [];
  const formStack = [];
  const rectangles = [];
  let malformed = false;

  const cloneState = (source) => ({
    transform: source.transform.slice(),
    clip: source.clip && { ...source.clip }
  });
  const addPaintedUnitRectangle = (transform) => {
    // PDF images paint a transformed unit rectangle. We intentionally retain
    // its axis-aligned bounds: this is bounded and conservative, but can
    // overcount rotated or sheared polygons until polygon union is warranted.
    const bounds = transformedRectangleBounds(transform, unitRectangle);
    const clipped = intersectRectangles(bounds, state.clip);
    if (clipped) rectangles.push(clipped);
  };
  const addTransformedInstances = (transforms) => {
    for (const instanceTransform of transforms) {
      const parsed = finiteNumericArray(instanceTransform, 6);
      if (!parsed) {
        malformed = true;
        continue;
      }
      addPaintedUnitRectangle(multiplyTransforms(state.transform, parsed));
    }
  };
  const transformsFromPositions = (matrixValues, positions) => {
    const parsedMatrix = finiteNumericArray(matrixValues, 4);
    let parsedPositions;
    try {
      parsedPositions = Array.from(positions || [], Number);
    } catch {
      parsedPositions = [];
    }
    if (!parsedMatrix || parsedPositions.length % 2 !== 0 || !parsedPositions.every(Number.isFinite)) {
      malformed = true;
      return [];
    }
    const [a, b, c, d] = parsedMatrix;
    const transforms = [];
    for (let index = 0; index < parsedPositions.length; index += 2) {
      transforms.push([a, b, c, d, parsedPositions[index], parsedPositions[index + 1]]);
    }
    return transforms;
  };

  for (let index = 0; index < (operatorList?.fnArray || []).length; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList?.argsArray?.[index] || [];
    if (operator === OPS.save) {
      graphicsStack.push(cloneState(state));
      continue;
    }
    if (operator === OPS.restore) {
      if (graphicsStack.length) {
        state = graphicsStack.pop();
      } else {
        malformed = true;
      }
      continue;
    }
    if (operator === OPS.transform) {
      const next = finiteNumericArray(args, 6);
      if (next) {
        state.transform = multiplyTransforms(state.transform, next);
      } else {
        malformed = true;
      }
      continue;
    }
    if (operator === OPS.paintFormXObjectBegin) {
      formStack.push({
        state: cloneState(state),
        graphicsStack: graphicsStack.map(cloneState)
      });
      const formMatrix = args[0] == null ? null : finiteNumericArray(args[0], 6);
      if (args[0] != null && !formMatrix) {
        malformed = true;
        state.clip = null;
      } else if (formMatrix) {
        state.transform = multiplyTransforms(state.transform, formMatrix);
      }
      if (args[1] != null) {
        const bbox = finiteNumericArray(args[1], 4);
        if (!bbox || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
          malformed = true;
          state.clip = null;
        } else {
          const formBounds = transformedRectangleBounds(state.transform, {
            x0: bbox[0],
            y0: bbox[1],
            x1: bbox[2],
            y1: bbox[3]
          });
          state.clip = intersectRectangles(state.clip, formBounds);
        }
      }
      continue;
    }
    if (operator === OPS.paintFormXObjectEnd) {
      const frame = formStack.pop();
      if (!frame) {
        malformed = true;
      } else {
        if (graphicsStack.length !== frame.graphicsStack.length) malformed = true;
        state = frame.state;
        graphicsStack = frame.graphicsStack;
      }
      continue;
    }
    if (directImageOperators.has(operator) || operator === OPS.paintSolidColorImageMask) {
      addPaintedUnitRectangle(state.transform);
      continue;
    }
    if (operator === OPS.paintImageXObjectRepeat) {
      addTransformedInstances(transformsFromPositions([args[1], 0, 0, args[2]], args[3]));
      continue;
    }
    if (operator === OPS.paintImageMaskXObjectRepeat) {
      addTransformedInstances(transformsFromPositions(
        [args[1], args[2] ?? 0, args[3] ?? 0, args[4]],
        args[5]
      ));
      continue;
    }
    if (operator === OPS.paintImageMaskXObjectGroup) {
      const images = args[0];
      if (!Array.isArray(images)) {
        malformed = true;
      } else {
        addTransformedInstances(images.map((image) => image?.transform));
      }
      continue;
    }
    if (operator === OPS.paintInlineImageXObjectGroup) {
      const map = args[1];
      if (!Array.isArray(map)) {
        malformed = true;
      } else {
        addTransformedInstances(map.map((entry) => entry?.transform));
      }
    }
  }
  if (graphicsStack.length || formStack.length) malformed = true;
  const coverage = malformed ? 1 : rectangleUnionArea(rectangles) / (width * height);
  return Math.min(1, Math.max(0, Number.isFinite(coverage) ? coverage : 1));
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
