const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { PDFDocument, PDFName, PDFNumber, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { nativeIllustrationSignatures, illustrationPlacements } = require('../pdf-native-illustrations');

// Regression basis: 2026-09-28 native PDF text was complete, but its one
// captioned diagram triggered OCR_LOW_CONFIDENCE. Exact pixels are necessary,
// and a caption is a narrow eligibility rule, not general scan classification.
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-native-illustration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const raw = Buffer.alloc(80 * 60 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
  let png = await sharp(raw, { raw: { width: 80, height: 60, channels: 3 } }).png().toBuffer();
  if (options.alpha) png = await sharp(png).ensureAlpha(.5).png().toBuffer();
  const body = options.short ? ['Native header only'] : [
    'This is original editable prose with at least one hundred and twenty characters.',
    'These lines are native text surrounding a separately labelled illustration.',
    'The figure below is an illustration; a scanned paragraph without a caption must use OCR.'
  ];
  body.forEach((line, index) => page.drawText(line, { x: 40, y: 750 - index * 18, size: 10, font }));
  if (options.headerRule) page.drawLine({ start: { x: 40, y: 680 }, end: { x: 520, y: 680 }, thickness: 1, color: rgb(0, 0, 0) });
  if (options.tableFrame) page.drawRectangle({ x: 40, y: 555, width: 450, height: 80, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  if (options.beforeOverlay) page.drawLine({ start: { x: 80, y: 450 }, end: { x: 280, y: 450 }, thickness: 2, color: rgb(0, 0, 0) });
  if (options.clip) page.pushOperators(pushGraphicsState(), rectangle(0, 0, options.clip === 'page' ? 600 : 150, 800), clip(), endPath());
  page.drawImage(await pdf.embedPng(png), { x: options.offPage ? -5 : 100, y: 400,
    width: options.large ? 500 : 160, height: options.large ? 600 : 120,
    rotate: degrees(options.rotated ? 10 : 0) });
  if (options.clip) page.pushOperators(popGraphicsState());
  if (options.overlay) page.drawRectangle({ x: 110, y: 430, width: 50, height: 30, color: rgb(1, 1, 1) });
  if (options.heavyRule) page.drawLine({ start: { x: 80, y: 540 }, end: { x: 280, y: 540 }, thickness: 50, color: rgb(0, 0, 0) });
  if (options.imageRule) page.drawLine({ start: { x: 80, y: 450 }, end: { x: 280, y: 450 }, thickness: 2, color: rgb(0, 0, 0) });
  if (options.overlap) page.drawText('Text overlapping the figure', { x: 110, y: 440, size: 10, font });
  if (options.hiddenCaption) page.pushOperators(pushGraphicsState(), rectangle(100, 450, 160, 50), clip(), endPath());
  if (!options.noCaption) page.drawText(options.table ? 'Table 1. Scanned body' : 'Fig. 1. Original diagram', {
    x: options.farCaption ? 390 : 110, y: options.farCaption ? 300 : 380, size: 10, font });
  if (options.hiddenCaption) page.pushOperators(popGraphicsState());
  if (options.secondUncaptioned) page.drawImage(await pdf.embedPng(png), { x: 330, y: 400, width: 160, height: 120 });
  const input = path.join(directory, 'input.pdf');
  await fs.writeFile(input, await pdf.save());
  return { input, pages: await extractPdfRowsByPage(input), pixelHash: crypto.createHash('sha256').update(raw).digest('hex') };
}

test('captioned native illustration returns exact RGB digest and displayed size', async t => {
  const { input, pages, pixelHash } = await fixture(t);
  assert.deepEqual(await nativeIllustrationSignatures(input, pages), [{ pageNumber: 1, width: 80, height: 60,
    pixelHash, displayWidth: 160, displayHeight: 120 }]);
});

test('page-sized rectangular clipping preserves a fully visible illustration', async t => {
  const { input, pages } = await fixture(t, { clip: 'page' });
  assert.equal((await nativeIllustrationSignatures(input, pages))?.length, 1);
});

test('ordinary heading rules and table outlines outside illustrations keep the native path', async t => {
  for (const options of [{ headerRule: true }, { tableFrame: true }, { headerRule: true, tableFrame: true }]) {
    const { input, pages, pixelHash } = await fixture(t, options);
    const signatures = await nativeIllustrationSignatures(input, pages);
    assert.equal(signatures?.length, 1, JSON.stringify(options));
    assert.equal(signatures[0].pixelHash, pixelHash);
  }
});

test('vector painting over an illustration, including thick strokes and earlier painting, keeps OCR', async t => {
  for (const options of [{ overlay: true }, { imageRule: true }, { heavyRule: true }, { beforeOverlay: true }]) {
    const { input, pages } = await fixture(t, options);
    assert.equal(await nativeIllustrationSignatures(input, pages), null, JSON.stringify(options));
  }
});

test('unlabelled scans, header-only scans, tables and unrelated captions keep OCR', async t => {
  for (const options of [{ noCaption: true }, { short: true }, { table: true }, { farCaption: true }, { secondUncaptioned: true }]) {
    const { input, pages } = await fixture(t, options);
    assert.equal(await nativeIllustrationSignatures(input, pages), null, JSON.stringify(options));
  }
});

test('cropped, covered, transparent, rotated and overlapping images keep OCR', async t => {
  for (const options of [{ clip: 'crop' }, { overlay: true }, { alpha: true }, { rotated: true },
    { overlap: true }, { offPage: true }, { large: true }, { hiddenCaption: true }]) {
    const { input, pages } = await fixture(t, options);
    assert.equal(await nativeIllustrationSignatures(input, pages), null, JSON.stringify(options));
  }
});

test('caption clipping cannot use extracted but invisible text as eligibility evidence', async t => {
  const { input, pages } = await fixture(t, { hiddenCaption: true });
  assert.ok(pages[0].lines.some(line => /Fig\. 1/.test(line.text)), 'PDF.js still extracts text outside the active clip');
  assert.equal(await nativeIllustrationSignatures(input, pages), null);
});

test('coverage at one half and insufficient reliable native prose keep OCR', async () => {
  const { OPS } = await require('../pdfjs').loadPdfjs();
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const lines = [{ text: 'A'.repeat(140), bbox: [20, 20, 500, 35] }, { text: 'Fig. 1', bbox: [110, 710, 180, 722] }];
  const op = { fnArray: [OPS.transform, OPS.paintImageXObject], argsArray: [[400, 0, 0, 600, 100, 100], ['image', 80, 60]] };
  assert.equal(illustrationPlacements(op, OPS, viewport, lines), null);
  op.argsArray[0] = [160, 0, 0, 120, 100, 100];
  lines[0].text = 'A'.repeat(119);
  assert.equal(illustrationPlacements(op, OPS, viewport, lines), null);
  lines[0].text = 'A'.repeat(120)+'\uFFFD'.repeat(20);
  assert.equal(illustrationPlacements(op, OPS, viewport, lines), null);
});

test('cancellation remains cancellation rather than a failed eligibility check', async t => {
  const { input, pages } = await fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(nativeIllustrationSignatures(input, pages, { signal: controller.signal }), { code: 'CONVERSION_CANCELED' });
});

test('an oversized image declaration fails closed rather than disappearing from PDF.js operators', async t => {
  const { input, pages } = await fixture(t);
  const pdf = await PDFDocument.load(await fs.readFile(input));
  const oversized = await pdf.embedPng(await sharp({ create: { width: 2, height: 2, channels: 3, background: 'black' } }).png().toBuffer());
  // An oversized image atop a valid small figure leaves union coverage and
  // native text unchanged. Silently dropping it would certify only the small
  // figure, including when the separate coverage consistency check is active.
  pdf.getPage(0).drawImage(oversized, { x: 100, y: 400, width: 160, height: 120 });
  await pdf.flush();
  const stream = pdf.context.lookup(oversized.ref);
  stream.dict.set(PDFName.of('Width'), PDFNumber.of(8000));
  stream.dict.set(PDFName.of('Height'), PDFNumber.of(8000));
  await fs.writeFile(input, await pdf.save());
  assert.equal(await nativeIllustrationSignatures(input, pages), null);
});

test('a changed operator image set cannot certify the previously extracted page', async t => {
  const { input, pages } = await fixture(t);
  pages[0].imageCoverage += .01;
  assert.equal(await nativeIllustrationSignatures(input, pages), null);
});

test('operator proof allows neutral states and metadata but rejects unknown visibility and malformed paths', async () => {
  const { OPS } = await require('../pdfjs').loadPdfjs();
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const make = (extra = [], extraArgs = []) => ({ fnArray: [...extra, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    argsArray: [...extraArgs, [], [160, 0, 0, 120, 100, 400], ['image', 80, 60], []] });
  const lines = [{ text: 'A'.repeat(140), bbox: [30, 30, 500, 45] }, { text: 'Figure 1. Diagram', bbox: [110, 410, 240, 422] }];
  const rect = [OPS.endPath, [Float32Array.from([0, 0, 0, 1, 600, 0, 1, 600, 800, 1, 0, 800, 4])], Float32Array.from([0, 0, 600, 800])];
  assert.equal(illustrationPlacements(make([OPS.eoClip, OPS.constructPath], [[], rect]), OPS, viewport, lines)?.length, 1);
  const marked = make([OPS.beginMarkedContentProps, OPS.setGState, OPS.endMarkedContent], [['Span', 1], [[['ca', 1], ['BM', 'source-over']]], []]);
  assert.equal(illustrationPlacements(marked, OPS, viewport, lines)?.length, 1);
  for (const [operator, args] of [[OPS.beginMarkedContentProps, ['OC', {}]], [OPS.setGState, [[['ca', .5]]]],
    [OPS.setTextRenderingMode, [3]], [OPS.paintFormXObjectBegin, []], [99999, []], [OPS.clip, []],
    [OPS.constructPath, [OPS.endPath, [[0, 0, 0, 1, 500, 0, 1, 400, 800, 1, 0, 800, 4]], [0, 0, 500, 800]]]]) {
    assert.equal(illustrationPlacements(make([operator], [args]), OPS, viewport, lines), null, String(operator));
  }
});

test('operator proof rejects pixel budgets and an unbalanced graphics stack', async () => {
  const { OPS } = await require('../pdfjs').loadPdfjs();
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const lines = [{ text: 'A'.repeat(140), bbox: [30, 30, 500, 45] }, { text: 'Fig. 1', bbox: [110, 410, 150, 422] }];
  const operators = { fnArray: [OPS.transform, OPS.paintImageXObject], argsArray: [[160, 0, 0, 120, 100, 400], ['image', 10000, 10000]] };
  assert.equal(illustrationPlacements(operators, OPS, viewport, lines), null);
  operators.argsArray[1] = ['image', 80, 60]; operators.fnArray.unshift(OPS.save); operators.argsArray.unshift([]);
  assert.equal(illustrationPlacements(operators, OPS, viewport, lines), null);
});

test('vector overlap proof accounts for CTM scale, miter limit, and restored line state', async () => {
  const { OPS } = await require('../pdfjs').loadPdfjs();
  const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const lines = [{ text: 'A'.repeat(140), bbox: [30, 30, 500, 45] }, { text: 'Fig. 1', bbox: [110, 410, 150, 422] }];
  const make = (width, miter = 10) => ({
    fnArray: [OPS.save, OPS.transform, OPS.setLineWidth, OPS.setMiterLimit, OPS.constructPath,
      OPS.restore, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    argsArray: [[], [4, 0, 0, 4, 0, 0], [width], [miter],
      [OPS.stroke, [[0, 20, 137, 1, 70, 137]], [20, 137, 70, 137]],
      [], [], [160, 0, 0, 120, 100, 400], ['image', 80, 60], []]
  });
  assert.equal(illustrationPlacements(make(1), OPS, viewport, lines)?.length, 1);
  assert.equal(illustrationPlacements(make(20), OPS, viewport, lines), null, 'CTM must scale the painted stroke, not just its centerline');
  assert.equal(illustrationPlacements(make(1, 20), OPS, viewport, lines), null, 'A miter can extend beyond the line centerline');
  const restored = make(1);
  restored.fnArray.splice(2, 1, OPS.save, OPS.setLineWidth, OPS.restore);
  restored.argsArray.splice(2, 1, [], [200], []);
  assert.equal(illustrationPlacements(restored, OPS, viewport, lines)?.length, 1, 'Restoring graphics state also restores line width');
  const unknownCurve = make(1);
  unknownCurve.argsArray[4] = [OPS.stroke, [[0, 20, 137, 2, 20, 130, 60, 180, 70, 137]], [20, 130, 70, 180]];
  assert.equal(illustrationPlacements(unknownCurve, OPS, viewport, lines), null, 'Unknown curve geometry must remain conservative');
});
