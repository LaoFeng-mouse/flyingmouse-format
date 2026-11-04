const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { fillMissingPdfPageText } = require('../pdf');
const { recognizeImageResultWithWorker } = require('../ocr');

async function fixture(t, nativeText = 'Amount: 1O0.00', glyphs = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-ocr-native-merge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'source.pdf'), image = path.join(directory, 'render.png');
  const document = await PDFDocument.create(), page = document.addPage([595, 842]);
  const font = await document.embedFont(StandardFonts.Courier);
  if (glyphs) {
    const secondFont = await document.embedFont(StandardFonts.CourierBold);
    Array.from(nativeText).forEach((character, index) => page.drawText(character, { x: 40+index*7.2, y: 760, font: index%2 ? font : secondFont, size: 12 }));
  } else page.drawText(nativeText, { x: 40, y: 760, font, size: 12 });
  await sharp({ create: { width: 595, height: 842, channels: 3, background: 'white' } }).png().toFile(image);
  await fs.writeFile(input, await document.save());
  const pages = await extractPdfRowsByPage(input);
  pages[0].imageCoverage = pages[0].ocrImageCoverage = .1;
  const nativeBox = pages[0].lines[0].bbox;
  const recognize = result => fillMissingPdfPageText(input, pages, {
    ocrAvailable: () => true, createOcrWorker: async () => ({ terminate: async () => {} }),
    renderPdfTablePage: async () => ({ outputPath: image, metadata: { width: 595, height: 842 } }),
    recognizeImageResultWithWorker: async () => result
  });
  return { image, nativeBox, nativeLine: pages[0].lines[0], recognize };
}

const line = (text, bbox) => ({ text, bbox, words: [{ text, bbox }] });
const recognized = lines => ({ text: lines.map(line => line.text).join('\n'), warnings: [], orientation: 0, deskewAngle: 0,
  geometry: { width: 595, height: 842, lines } });

test('spatial merge preserves original O/0 distinctions and a separate scanned amount', async t => {
  const { nativeBox, nativeLine, recognize } = await fixture(t);
  const nativeOcr = { text: 'Amount: 100.00', bbox: nativeBox,
    words: nativeLine.items.map(item => ({ text: item.text.replace('O', '0'), bbox: item.bbox })) };
  const result = await recognize(recognized([nativeOcr, line('Amount: 100.00', [40, 250, 155, 263])]));
  assert.deepEqual(result[0].rows, [['Amount: 1O0.00'], ['Amount: 100.00']]);
});

test('equal amounts in distinct native and scanned locations are both preserved', async t => {
  const { nativeBox, nativeLine, recognize } = await fixture(t, 'Amount: 100.00');
  const nativeOcr = { text: nativeLine.text, bbox: nativeBox,
    words: nativeLine.items.map(item => ({ text: item.text, bbox: item.bbox })) };
  const result = await recognize(recognized([nativeOcr, line('Amount: 100.00', [40, 250, 155, 263])]));
  assert.deepEqual(result[0].rows, [['Amount: 100.00'], ['Amount: 100.00']]);
});

test('a complete OCR word can be covered by adjacent native glyph items', async t => {
  const { nativeBox, nativeLine, recognize } = await fixture(t, 'lO00123456789', true);
  assert.ok(nativeLine.items.length > 4, 'actual PDF.js extraction retains separate glyph items');
  const result = await recognize(recognized([line('1000123456789', nativeBox)]));
  assert.deepEqual(result[0].rows, [['lO00123456789']]);
});

test('a gap between native glyph groups cannot conceal scanned content', async t => {
  const { nativeBox, nativeLine, recognize } = await fixture(t, 'AAA      BBB', true);
  assert.ok(nativeLine.items.length > 4);
  await assert.rejects(recognize(recognized([line('AAASCANBBB', nativeBox)])), { code: 'PDF_OCR_NATIVE_MERGE_UNVERIFIED' });
});

test('an OCR word spanning both native and scanned regions is rejected without guessing', async t => {
  const { nativeBox, recognize } = await fixture(t);
  const box = [...nativeBox]; box[2] += 120;
  await assert.rejects(recognize(recognized([line('Amount: 100.00 SCANNED', box)])), { code: 'PDF_OCR_NATIVE_MERGE_UNVERIFIED' });
});

test('ambiguous OCR without geometry cannot append a contradictory second amount', async t => {
  const { recognize } = await fixture(t);
  await assert.rejects(recognize({ text: 'Amount: 100.00', warnings: [] }), { code: 'PDF_OCR_NATIVE_MERGE_UNVERIFIED' });
});

test('rotated or deskewed word coordinates are not treated as original page coordinates', async t => {
  const { nativeBox, recognize } = await fixture(t);
  for (const adjustment of [{ orientation: 180 }, { deskewAngle: .001 }]) {
    await assert.rejects(recognize({ ...recognized([line('Amount: 100.00', nativeBox)]), ...adjustment }),
      { code: 'PDF_OCR_NATIVE_MERGE_UNVERIFIED' });
  }
});

test('exact text matching stays usable when geometry is unavailable and restores punctuation', async t => {
  const { recognize } = await fixture(t);
  const result = await recognize({ text: 'Amount: 1O000\nScanned total 200.00', warnings: [] });
  assert.deepEqual(result[0].rows, [['Amount: 1O0.00'], ['Scanned total 200.00']]);
});

test('OCR geometry is opt-in, uses prepared image dimensions and preserves every word', async t => {
  const { image } = await fixture(t);
  const worker = { recognize: async () => ({ data: { text: 'Total 100.00', confidence: 95, rotateRadians: 0,
    blocks: [{ paragraphs: [{ lines: [{ text: 'Total 100.00', bbox: { x0: 20, y0: 20, x1: 230, y1: 50 },
      words: [{ text: 'Total', confidence: 95, bbox: { x0: 20, y0: 20, x1: 90, y1: 50 } },
        { text: '100.00', confidence: 95, bbox: { x0: 110, y0: 20, x1: 230, y1: 50 } }] }] }] }] } }) };
  assert.equal((await recognizeImageResultWithWorker(worker, image)).geometry, undefined);
  const result = await recognizeImageResultWithWorker(worker, image, { includeGeometry: true });
  assert.equal(result.geometry.width, 2480);
  assert.equal(result.geometry.lines[0].words[1].text, '100.00');
});
