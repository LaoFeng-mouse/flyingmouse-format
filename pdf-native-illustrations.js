// A narrow native-DOCX exception for explicitly captioned illustrations.
// Returning null preserves the ordinary OCR requirement. This does not infer
// that arbitrary raster content is an illustration from its coverage alone.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { loadPdfjs } = require('./pdfjs');
const { throwIfCanceled } = require('./conversion-cancellation');

const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_PAGE_PIXELS = 100_000_000;
const MAX_IMAGES = 24;
const EPSILON = 0.1; // points; only floating-point geometry tolerance
const CAPTION = /^(?:图\s*\d+(?:[.．-]\d+)*|(?:fig\.?|figure)\s+\d+(?:[.-]\d+)*)(?=\s|[：:、.．(（]|$)/iu;
const numbers = (value, count) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const result = Array.from(value);
  return result.length === count && result.every(Number.isFinite) ? result : null;
};
const boundsValid = value => numbers(value, 4) && value[2] > value[0] && value[3] > value[1];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const axisAligned = matrix => numbers(matrix, 6) && Math.abs(matrix[1]) < 1e-7
  && Math.abs(matrix[2]) < 1e-7 && matrix[0] > 0 && matrix[3] < 0;
const transformBounds = (matrix, box) => {
  const xs = [matrix[0]*box[0]+matrix[4], matrix[0]*box[2]+matrix[4]];
  const ys = [matrix[3]*box[1]+matrix[5], matrix[3]*box[3]+matrix[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const contains = (outer, inner) => outer && inner[0] >= outer[0]-EPSILON && inner[1] >= outer[1]-EPSILON
  && inner[2] <= outer[2]+EPSILON && inner[3] <= outer[3]+EPSILON;
const overlap = (a, b) => Math.min(a[2], b[2])-Math.max(a[0], b[0]) > EPSILON
  && Math.min(a[3], b[3])-Math.max(a[1], b[1]) > EPSILON;
const intersection = (a, b) => {
  const value = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return boundsValid(value) ? value : null;
};

function rectangularPath(args) {
  // PDF.js 6 emits [paintOperation, [DrawOPS Float32Array], minMax].
  // Validate the actual closed four-edge path, never just its bounding box.
  if (!Array.isArray(args?.[1]) || args[1].length !== 1) return null;
  const data = numbers(args[1][0], 13), declared = numbers(args[2], 4);
  if (!data || !declared || data[0] !== 0 || data[3] !== 1 || data[6] !== 1 || data[9] !== 1 || data[12] !== 4) return null;
  const points = [[data[1], data[2]], [data[4], data[5]], [data[7], data[8]], [data[10], data[11]]];
  const box = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  if (!boundsValid(box) || box.some((n, index) => Math.abs(n-declared[index]) > EPSILON)) return null;
  if (new Set(points.map(p => p.join(','))).size !== 4) return null;
  for (let index = 0; index < 4; index++) {
    const point = points[index], next = points[(index+1)%4];
    if (!([box[0], box[2]].includes(point[0]) && [box[1], box[3]].includes(point[1]))) return null;
    if ((point[0] === next[0]) === (point[1] === next[1])) return null;
  }
  return box;
}

function neutralGraphicsState(args) {
  return Array.isArray(args?.[0]) && args[0].every(entry => Array.isArray(entry) && entry.length === 2
    && ((['CA', 'ca'].includes(entry[0]) && entry[1] === 1)
      || (entry[0] === 'BM' && ['source-over', 'Normal'].includes(entry[1]))
      || (entry[0] === 'SMask' && (entry[1] === false || entry[1] === 'None'))));
}

function straightPathBounds(args) {
  // Heading rules and table borders use only move/line/close commands. Derive
  // their bounds from the actual path, including zero-height horizontal lines;
  // a supplied bounding box alone does not prove an unknown drawing is safe.
  const declared = numbers(args?.[2], 4);
  if (!declared || !Array.isArray(args?.[1]) || !args[1].length) return null;
  const points = [];
  let coordinates = 0, hasSegment = false;
  for (const part of args[1]) {
    if ((!Array.isArray(part) && !ArrayBuffer.isView(part)) || (coordinates += part.length) > 100_000) return null;
    const data = Array.from(part);
    let active = false;
    for (let index = 0; index < data.length;) {
      const operation = data[index++];
      if (operation === 4) { if (!active) return null; continue; }
      if (![0, 1].includes(operation) || index + 1 >= data.length) return null;
      const x = data[index++], y = data[index++];
      if (!Number.isFinite(x) || !Number.isFinite(y) || operation === 1 && !active) return null;
      if (operation === 1) hasSegment = true;
      points.push([x, y]); active = true;
    }
  }
  if (!hasSegment || !points.length) return null;
  const box = [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
  if (box.some((value, index) => Math.abs(value - declared[index]) > EPSILON)) return null;
  return box;
}

function vectorPaintBounds(args, OPS, state) {
  const fills = [OPS.fill, OPS.eoFill];
  const strokes = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke];
  if (![...fills, ...strokes].includes(args[0])) return null;
  const rawBounds = straightPathBounds(args);
  if (!rawBounds) return null;
  const box = transformBounds(state.matrix, rawBounds);
  if (strokes.includes(args[0])) {
    // Stroke width follows the current CTM. Conservatively include square
    // caps and the full miter limit; a hairline gets at least a one-point box.
    const scale = Math.max(Math.abs(state.matrix[0]), Math.abs(state.matrix[3]));
    const width = state.lineWidth === 0 ? 1 : state.lineWidth * scale;
    const pad = width / 2 * Math.max(Math.SQRT2, state.lineJoin === 0 ? state.miterLimit : 1);
    if (!Number.isFinite(pad)) return null;
    box[0] -= pad; box[1] -= pad; box[2] += pad; box[3] += pad;
  }
  return boundsValid(box) ? box : null;
}

function illustrationPlacements(operators, OPS, viewport, nativeLines) {
  if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height)
    || viewport.width <= 0 || viewport.height <= 0 || !axisAligned(viewport.transform)
    || !Array.isArray(nativeLines) || !Array.isArray(operators?.fnArray)
    || operators.fnArray.length !== operators.argsArray?.length) return null;
  const lines = nativeLines.filter(line => String(line.text || '').trim());
  if (!lines.length || lines.some(line => !boundsValid(line.bbox))) return null;
  const captions = lines.filter(line => CAPTION.test(String(line.text).trim()));
  const characters = Array.from(lines.filter(line => !captions.includes(line)).map(line => line.text).join('')).filter(c => !/\s/u.test(c));
  if (characters.length < 120 || characters.filter(c => /[\p{C}\uFFFD]/u.test(c)).length / characters.length > .05) return null;
  const pageBox = [0, 0, viewport.width, viewport.height];
  if (lines.some(line => !contains(pageBox, line.bbox))) return null;
  const safeNames = ['dependency', 'setDash',
    'setRenderingIntent', 'setFlatness', 'beginText', 'endText', 'setCharSpacing', 'setWordSpacing', 'setHScale',
    'setLeading', 'setFont', 'setTextRise', 'moveText', 'setLeadingMoveText', 'setTextMatrix', 'nextLine',
    'setStrokeColorSpace', 'setFillColorSpace', 'setStrokeColor', 'setFillColor', 'setStrokeGray', 'setFillGray',
    'setStrokeRGBColor', 'setFillRGBColor', 'setStrokeCMYKColor', 'setFillCMYKColor'];
  const harmless = new Set(safeNames.map(name => OPS[name]).filter(Number.isInteger));
  const textPaint = new Set(['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText']
    .map(name => OPS[name]).filter(Number.isInteger));
  let state = { matrix: Array.from(viewport.transform), clip: pageBox,
    lineWidth: 1, lineCap: 0, lineJoin: 0, miterLimit: 10 };
  const stack = [], marked = [], images = [], vectorPaints = [];
  let pendingClip = false, painted = false, totalPixels = 0;
  for (let index = 0; index < operators.fnArray.length; index++) {
    const operation = operators.fnArray[index], args = operators.argsArray[index] || [];
    if (pendingClip && operation !== OPS.constructPath) return null;
    if (operation === OPS.save) {
      if (stack.length >= 64) return null;
      stack.push({ ...state, matrix: state.matrix.slice(), clip: state.clip?.slice() || null });
    } else if (operation === OPS.restore) {
      if (!stack.length) return null;
      state = stack.pop();
    } else if (operation === OPS.transform) {
      const next = numbers(args, 6);
      if (!next) return null;
      state.matrix = multiply(state.matrix, next);
      if (!axisAligned(state.matrix)) return null;
    } else if (operation === OPS.setLineWidth) {
      if (!Number.isFinite(args[0]) || args[0] < 0) return null;
      state.lineWidth = args[0];
    } else if (operation === OPS.setLineCap || operation === OPS.setLineJoin) {
      if (![0, 1, 2].includes(args[0])) return null;
      state[operation === OPS.setLineCap ? 'lineCap' : 'lineJoin'] = args[0];
    } else if (operation === OPS.setMiterLimit) {
      if (!Number.isFinite(args[0]) || args[0] < 1) return null;
      state.miterLimit = args[0];
    } else if (operation === OPS.clip || operation === OPS.eoClip) {
      pendingClip = true;
    } else if (operation === OPS.constructPath) {
      const rectangle = rectangularPath(args);
      if (!axisAligned(state.matrix)) return null;
      const box = rectangle && transformBounds(state.matrix, rectangle);
      if (pendingClip) {
        if (!rectangle || args[0] !== OPS.endPath) return null;
        state.clip = state.clip && intersection(state.clip, box);
        if (!state.clip) return null;
        pendingClip = false;
      } else if (rectangle && !painted && [OPS.fill, OPS.eoFill].includes(args[0])
        && contains(box, pageBox) && contains(pageBox, box)) {
        // A page background drawn before all content cannot cover an image.
      } else {
        const paintedBox = vectorPaintBounds(args, OPS, state);
        if (!paintedBox) return null;
        vectorPaints.push(paintedBox);
        painted = true;
      }
    } else if (operation === OPS.setGState) {
      if (!neutralGraphicsState(args)) return null;
    } else if (operation === OPS.setTextRenderingMode) {
      // Filling/stroking native glyphs is visible; clipping or invisible text
      // cannot establish reliable prose or a visible figure caption.
      if (![0, 1, 2].includes(args[0])) return null;
    } else if (operation === OPS.beginMarkedContent || operation === OPS.beginMarkedContentProps) {
      const tag = typeof args[0] === 'string' ? args[0] : args[0]?.name;
      if (!['Span', 'P', 'Artifact'].includes(tag) || marked.length >= 64) return null;
      if (operation === OPS.beginMarkedContentProps && (!Number.isInteger(args[1]) || args[1] < 0)) return null;
      marked.push(tag);
    } else if (operation === OPS.endMarkedContent) {
      if (!marked.length) return null;
      marked.pop();
    } else if (operation === OPS.paintImageXObject) {
      const [id, width, height] = args;
      if (typeof id !== 'string' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width*height > MAX_IMAGE_PIXELS
        || (totalPixels += width*height) > MAX_PAGE_PIXELS || images.length >= MAX_IMAGES) return null;
      const box = transformBounds(state.matrix, [0, 0, 1, 1]);
      if (!boundsValid(box) || !contains(pageBox, box) || !contains(state.clip, box)
        || lines.some(line => overlap(line.bbox, box)) || images.some(image => overlap(image.bbox, box))) return null;
      images.push({ id, width, height, bbox: box });
      painted = true;
    } else if (textPaint.has(operation)) {
      // PDF.js extracts text even when the active clip hides its glyphs. A
      // cropped caption cannot establish that a scan is a labelled figure.
      // Non-page clipping is supported only while painting visible images.
      if (!contains(state.clip, pageBox)) return null;
      painted = true;
    }
    else if (!harmless.has(operation)) return null;
  }
  if (stack.length || marked.length || pendingClip || !images.length) return null;
  // Check all strokes/fills after collecting the full page. This also catches
  // vector painting before an image and prevents a later overlay being ignored.
  if (vectorPaints.some(box => images.some(image => overlap(box, image.bbox)))) return null;
  const coverage = images.reduce((sum, image) => sum+(image.bbox[2]-image.bbox[0])*(image.bbox[3]-image.bbox[1]), 0)
    / (viewport.width*viewport.height);
  if (!(coverage > 0 && coverage < .5)) return null;
  const usedCaptions = new Set();
  for (const image of images) {
    const box = image.bbox;
    const nearby = captions.filter(caption => {
      const c = caption.bbox, center = (c[0]+c[2])/2;
      const gap = c[1] >= box[3]-EPSILON ? c[1]-box[3] : box[1] >= c[3]-EPSILON ? box[1]-c[3] : Infinity;
      return !usedCaptions.has(caption) && center >= box[0] && center <= box[2]
        && gap >= -EPSILON && gap <= Math.min(36, Math.max(24, 2*(c[3]-c[1])))
        && c[2]-c[0] <= (box[2]-box[0])*1.25;
    });
    if (nearby.length !== 1) return null;
    usedCaptions.add(nearby[0]);
  }
  return images;
}

function rgbPixels(image, ImageKind, placement) {
  if (!image?.data || image.width !== placement.width || image.height !== placement.height) return null;
  const width = image.width, height = image.height, data = image.data;
  if (image.kind === ImageKind.RGB_24BPP && data.length === width*height*3) return Buffer.from(data);
  const rgb = Buffer.alloc(width*height*3);
  if (image.kind === ImageKind.RGBA_32BPP && data.length === width*height*4) {
    for (let source = 0, target = 0; source < data.length; source += 4, target += 3) {
      if (data[source+3] !== 255) return null;
      rgb[target] = data[source]; rgb[target+1] = data[source+1]; rgb[target+2] = data[source+2];
    }
  } else if (image.kind === ImageKind.GRAYSCALE_1BPP && data.length === Math.ceil(width/8)*height) {
    const stride = Math.ceil(width/8);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const color = data[y*stride+(x>>3)] & (128>>(x&7)) ? 255 : 0, target = (y*width+x)*3;
      rgb[target] = rgb[target+1] = rgb[target+2] = color;
    }
  } else return null;
  return rgb;
}

async function readImage(objects, id, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (value, error) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
    const cancel = () => { try { throwIfCanceled(signal); } catch (error) { finish(null, error); } };
    timer = setTimeout(() => finish(null), 2000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try { objects.get(id, value => finish(value)); } catch { finish(null); }
  });
}

async function nativeIllustrationSignatures(inputPath, pages, { signal } = {}) {
  throwIfCanceled(signal);
  if (!Array.isArray(pages) || !pages.length) return null;
  if (pages.some(page => !Number.isInteger(page.pageNumber) || page.pageNumber < 1
    || page.ocr || page.blank || page.kind === 'scanned') || new Set(pages.map(page => page.pageNumber)).size !== pages.length) return null;
  let task;
  const cancel = () => { if (task) void task.destroy().catch(() => {}); };
  try {
    const lib = await loadPdfjs();
    throwIfCanceled(signal);
    task = lib.getDocument({ data: new Uint8Array(await fs.readFile(inputPath)), disableFontFace: true,
      useSystemFonts: true, isEvalSupported: false, maxImageSize: MAX_IMAGE_PIXELS,
      // Without stopAtErrors, PDF.js silently drops an oversized image. A
      // surviving smaller figure could then incorrectly certify the page.
      stopAtErrors: true });
    signal?.addEventListener('abort', cancel, { once: true });
    throwIfCanceled(signal);
    const pdf = await task.promise, result = [];
    for (const native of pages) {
      throwIfCanceled(signal);
      const page = await pdf.getPage(native.pageNumber);
      try {
        if (page.rotate) return null;
        const viewport = page.getViewport({ scale: 1, rotation: 0 });
        const placements = illustrationPlacements(await page.getOperatorList(), lib.OPS, viewport, native.lines);
        if (!placements) return null;
        const measuredCoverage = placements.reduce((sum, placement) => sum
          + (placement.bbox[2]-placement.bbox[0])*(placement.bbox[3]-placement.bbox[1]), 0)/(viewport.width*viewport.height);
        if (!Number.isFinite(native.imageCoverage) || Math.abs(measuredCoverage-native.imageCoverage) > 1e-9) return null;
        for (const placement of placements) {
          throwIfCanceled(signal);
          const pixels = rgbPixels(await readImage(page.objs, placement.id, signal), lib.ImageKind, placement);
          if (!pixels) return null;
          result.push({ pageNumber: native.pageNumber, width: placement.width, height: placement.height,
            pixelHash: crypto.createHash('sha256').update(pixels).digest('hex'),
            displayWidth: placement.bbox[2]-placement.bbox[0], displayHeight: placement.bbox[3]-placement.bbox[1] });
        }
      } finally { page.cleanup(); }
    }
    throwIfCanceled(signal);
    return result;
  } catch (error) {
    throwIfCanceled(signal);
    if (error?.code === 'CONVERSION_CANCELED') throw error;
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (task) await task.destroy().catch(() => {});
  }
}

module.exports = { nativeIllustrationSignatures, illustrationPlacements };
