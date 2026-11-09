'use strict';

// Text coverage cannot account for glyph outlines or other vector artwork.
// Only established decorations are exempted. For other paths, compare the
// actual page with the same page minus those paints, so transparent, clipped,
// white-on-white and subsequently covered paths do not cause a false rejection.
const fs = require('node:fs/promises');
const { loadPdfjs, getPdfjsDocumentOptions } = require('./pdfjs');
const { assertImageMetadata, ResourceLimitError } = require('./resource-policy');
const { throwIfCanceled } = require('./conversion-cancellation');
const { structureError } = require('./pdf-structure-contract');

const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const contains = (a, b) => b?.length === 4 && b.every(Number.isFinite)
  && a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

function decoration(args, OPS, matrix, lineWidth, lines) {
  // PDF.js 6 DrawOPS. Inspect actual segments instead of trusting the bounding
  // box (a letter outline may have exactly the same bounds as a rectangle).
  const data = args?.[1]?.[0];
  if (args?.[1]?.length !== 1 || !ArrayBuffer.isView(data) || data.length > 100_000) return false;
  const points = [], edges = [];
  let start, previous, closed = false;
  for (let i = 0; i < data.length;) {
    const op = data[i++];
    if (op === 4) {
      if (!start || !previous) return false;
      edges.push([previous, start]); previous = start; closed = true; continue;
    }
    if (![0, 1].includes(op) || i + 1 >= data.length) return false;
    const x = data[i++], y = data[i++];
    const point = [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]];
    if (!point.every(Number.isFinite)) return false;
    if (op === 0) {
      if (start) {
        if (!edges.length && point[0] === start[0] && point[1] === start[1]) continue;
        return false;
      }
      start = point;
    }
    else { if (!previous) return false; edges.push([previous, point]); }
    previous = point; points.push(point);
  }
  if (!edges.length || !edges.every(([a,b]) => Math.abs(a[0]-b[0]) < .01 || Math.abs(a[1]-b[1]) < .01)) return false;
  const box = [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])),
    Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))];
  const rectangle = closed && points.length === 4 && new Set(points.map(p=>p.join(','))).size === 4
    && points.every(p => [box[0],box[2]].includes(p[0]) && [box[1],box[3]].includes(p[1]));
  const thinStroke = lineWidth * Math.max(Math.hypot(matrix[0],matrix[1]), Math.hypot(matrix[2],matrix[3])) <= 2;
  if ([OPS.stroke, OPS.closeStroke].includes(args[0])) return thinStroke && (edges.length === 1 || rectangle);
  if (![OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(args[0]) || !rectangle) return false;
  // Filled horizontal rules include fraction bars, whose semantic repair is
  // already enforced by pdf-native-math. Ordinary cell shading contains text.
  return box[3]-box[1] <= 2 && box[2]-box[0] > 4*(box[3]-box[1])
    || lines.some(line => (line.items || [line]).some(item => contains(box, item.bbox)));
}

function vectorPaintCandidates(operators, OPS, viewport, lines = []) {
  const candidates = new Set(), stack = [];
  const initial = () => ({ matrix: [...viewport.transform], lineWidth: 1, decorationsAllowed: true });
  let state = initial();
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i] || [];
    if (op === OPS.save) stack.push({ ...state });
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) state = stack.pop() || initial();
    else if (op === OPS.transform) state.matrix = multiply(state.matrix, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      if (args[0]) state = { ...state, matrix: multiply(state.matrix, args[0]) };
    } else if (op === OPS.beginGroup) {
      stack.push({ ...state });
      // Group isolation, masks and their coordinate systems are renderer-owned.
      // Never infer a text-shading exemption inside an unproven group.
      state = { ...state, decorationsAllowed: false };
    }
    else if (op === OPS.setLineWidth) state.lineWidth = args[0];
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0] || []) if (key === 'LW') state.lineWidth = value;
    }
    else if (op === OPS.constructPath) {
      if (args[0] !== OPS.endPath && (!state.decorationsAllowed || !decoration(args, OPS, state.matrix, state.lineWidth, lines))) candidates.add(i);
    } else if (op === OPS.shadingFill) candidates.add(i);
  }
  return candidates;
}

function unverified(pageNumbers) {
  const error = structureError('PDF_DOCX_CONTENT_UNVERIFIED',
    `第 ${pageNumbers.join('、')} 页含有尚不能确认已完整保留的图形内容，已停止生成 Word。请使用含可选中文字的 PDF，或先进行 OCR 后重试。`,
    `Graphical content on pages ${pageNumbers.join(', ')} could not be verified in Word; export was stopped. Use a PDF with selectable text, or run OCR first.`);
  error.pageNumbers = pageNumbers;
  return error;
}

async function assertPdfVectorContent(inputPath, pages, options = {}) {
  const suspect = pages.filter(page => page.unverifiedVectorContent).map(page => page.pageNumber);
  if (!suspect.length) return;
  throwIfCanceled(options.signal);
  const pdfjs = await loadPdfjs();
  // Older PDF.js does not implement operationsFilter. It cannot establish this
  // proof; do not treat two identical unfiltered renders as success on Win7.
  if (Number(pdfjs.version.split('.')[0]) < 6) throw unverified(suspect);
  const task = pdfjs.getDocument(getPdfjsDocumentOptions({ data: new Uint8Array(await fs.readFile(inputPath)),
    disableFontFace: true, useSystemFonts: true }));
  try {
    const pdf = await task.promise;
    for (const number of suspect) {
      throwIfCanceled(options.signal);
      const page = await pdf.getPage(number);
      try {
        const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
        const operators = await page.getOperatorList();
        const candidates = vectorPaintCandidates(operators, pdfjs.OPS, viewport, pages.find(p=>p.pageNumber === number)?.lines);
        if (!candidates.size) continue;
        // Omitting a path that also consumes a pending clipping path changes
        // later paints. Reject that ambiguous case instead of making a proof.
        if ([...candidates].some(i => [pdfjs.OPS.clip, pdfjs.OPS.eoClip].includes(operators.fnArray[i-1]))) throw unverified([number]);
        const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
        assertImageMetadata({ width, height: height * 2, pages: 2 });
        const render = async filter => {
          throwIfCanceled(options.signal);
          const canvas = pdf.canvasFactory.create(width, height);
          let renderTask, cancel;
          try {
            renderTask = page.render({ canvasContext: canvas.context, viewport, background: '#ffffff', operationsFilter: filter });
            cancel = () => renderTask.cancel();
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
            await renderTask.promise;
            throwIfCanceled(options.signal);
            return canvas.context.getImageData(0, 0, width, height).data;
          } finally {
            if (cancel) options.signal?.removeEventListener('abort', cancel);
            pdf.canvasFactory.destroy(canvas);
          }
        };
        const full = await render(), without = await render(index => !candidates.has(index));
        for (let i = 0; i < full.length; i += 4) {
          if (Math.max(Math.abs(full[i]-without[i]), Math.abs(full[i+1]-without[i+1]), Math.abs(full[i+2]-without[i+2])) > 8) {
            throw unverified([number]);
          }
        }
      } finally { page.cleanup(); }
    }
  } catch (error) {
    throwIfCanceled(options.signal);
    if (error instanceof ResourceLimitError || error?.code === 'PDF_DOCX_CONTENT_UNVERIFIED') throw error;
    // Missing renderer/resources cannot turn unknown content into success.
    throw unverified(suspect);
  } finally { await task.destroy(); }
}

module.exports = { vectorPaintCandidates, assertPdfVectorContent };
