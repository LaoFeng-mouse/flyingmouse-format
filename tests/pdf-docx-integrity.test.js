'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = require('pdf-lib');
const { missingPdfText, convertPdfToDocx, validateNativePdfDocx, writeDocxZip, xmlDocxParagraph } = require('../pdf');
const { extractPdfRowsByPage } = require('../pdf-table');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-docx-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function sourcePdf(root, texts, draw) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, text] of texts.entries()) {
    const page = doc.addPage([595, 842]);
    await draw?.(page, index, doc);
    page.drawText(text, { x: 40, y: 780, size: 12, font });
  }
  const input = path.join(root, 'input.pdf');
  await fs.writeFile(input, await doc.save());
  return input;
}

async function packageXml(output, body, styles = '', prefix = 'w', stylesPath = 'word/styles.xml') {
  const parts = [
    { path: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { path: '_rels/.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { path: 'word/document.xml', content: `<${prefix}:document xmlns:${prefix}="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>` }
  ];
  if (styles) {
    parts[0].content = parts[0].content.replace('</Types>', '<Override PartName="/' + stylesPath + '" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
    parts.push({ path: stylesPath, content: '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + styles + '</w:styles>' });
    parts.push({ path: 'word/_rels/document.xml.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="/' + stylesPath + '"/></Relationships>' });
  }
  await writeDocxZip(output, parts);
}

for (const [label, expected, actual] of [
  ['decimal', 'Total 1186.00', 'Total 118600'],
  ['negative sign', 'Balance -12.50', 'Balance 12.50'],
  ['percent', 'Rate 15%', 'Rate 15'],
  ['identifier punctuation', 'ID AB-12', 'ID AB12']
]) test(`native ${label} loss recovers source text before publication`, async t => {
  const root = await workspace(t), input = await sourcePdf(root, [expected]);
  const output = path.join(root, 'out.docx');
  const result = await convertPdfToDocx(input, output, null, {
    docenginePath: 'fixture', run: async (_, args) => packageXml(args[2], xmlDocxParagraph(actual))
  });
  assert.equal((await validateNativePdfDocx(output)).editableText, expected);
  assert.ok(result.warnings.some(warning => warning.code === 'PDF_DOCX_LAYOUT_FALLBACK'));
});

test('one output occurrence cannot satisfy duplicate source pages', async t => {
  const root = await workspace(t), text = 'Repeated body content';
  const input = await sourcePdf(root, [text, text]), output = path.join(root, 'out.docx');
  await convertPdfToDocx(input, output, null, {
    docenginePath: 'fixture', run: async (_, args) => packageXml(args[2], xmlDocxParagraph(text))
  });
  assert.equal((await validateNativePdfDocx(output)).editableText.split(text).length - 1, 2);
});

test('coverage permits whitespace/run splits and reordered table cells without reusing text', () => {
  const pages = [{ pageNumber: 1, rows: [['AB-12', '1186.00'], ['AB-12', '42%']] }];
  assert.deepEqual(missingPdfText(pages, 'AB-12 AB-12 1186 . 00 42 %'), []);
  assert.ok(missingPdfText(pages, 'AB-12 1186.00 42%').length);
  assert.ok(missingPdfText([{ pageNumber: 1, rows: [['a'], ['ab']] }], 'ab').length);
  assert.deepEqual(missingPdfText([{ pageNumber: 1, rows: [['aba'], ['ab']] }], 'ababa'), []);
});

for (const [label, body, styles, prefix] of [
  ['zero-width-only', '<w:p><w:r><w:t>\u200b\u200c\u200d\u2060\u00ad</w:t></w:r></w:p>'],
  ['direct hidden', '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden body</w:t></w:r></w:p>'],
  ['alternate prefix hidden', '<x:p><x:r><x:rPr><x:vanish x:val="true"/></x:rPr><x:t>Hidden body</x:t></x:r></x:p>', '', 'x'],
  ['character style hidden', '<w:p><w:r><w:rPr><w:rStyle w:val="Child"/></w:rPr><w:t>Hidden body</w:t></w:r></w:p>', '<w:style w:type="character" w:styleId="Base"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="character" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>'],
  ['default paragraph style hidden', '<w:p><w:r><w:t>Hidden body</w:t></w:r></w:p>', '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style>'],
  ['document default hidden', '<w:p><w:r><w:t>Hidden body</w:t></w:r></w:p>', '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>'],
  ['unknown style', '<w:p><w:r><w:rPr><w:rStyle w:val="Missing"/></w:rPr><w:t>Unknown visibility</w:t></w:r></w:p>'],
  ['cyclic style', '<w:p><w:r><w:rPr><w:rStyle w:val="Cycle"/></w:rPr><w:t>Unknown visibility</w:t></w:r></w:p>', '<w:style w:type="character" w:styleId="Cycle"><w:basedOn w:val="Cycle"/></w:style>'],
  ['deleted text', '<w:p><w:del><w:r><w:t>Deleted body</w:t></w:r></w:del></w:p>'],
  ['detached text', '<w:t>Outside a run</w:t>']
]) test(`${label} cannot establish visible editable content`, async t => {
  const output = path.join(await workspace(t), 'out.docx');
  await packageXml(output, body, styles, prefix);
  await assert.rejects(validateNativePdfDocx(output), { code: 'PDF_DOCX_NO_EDITABLE_CONTENT' });
});

test('hidden document defaults are resolved through the actual styles relationship', async t => {
  const output = path.join(await workspace(t), 'out.docx');
  await packageXml(output, xmlDocxParagraph('Hidden body'),
    '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>', 'w', 'custom/style-definitions.xml');
  await assert.rejects(validateNativePdfDocx(output), { code: 'PDF_DOCX_NO_EDITABLE_CONTENT' });
});

for (const value of ['0', 'false', 'off']) test(`direct vanish=${value} overrides inherited hidden formatting`, async t => {
  const output = path.join(await workspace(t), 'out.docx');
  await packageXml(output, `<w:p><w:r><w:rPr><w:rStyle w:val="Hidden"/><w:vanish w:val="${value}"/></w:rPr><w:t>A</w:t></w:r></w:p>`,
    '<w:style w:type="character" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>');
  assert.equal((await validateNativePdfDocx(output)).editableText, 'A');
});

test('style toggles and visible language joiners are retained', async t => {
  const output = path.join(await workspace(t), 'out.docx');
  const text = 'ا\u200cب A\u200dB 中 42%';
  await packageXml(output, '<w:p><w:r><w:rPr><w:rStyle w:val="Visible"/></w:rPr><w:t>' + text + '</w:t></w:r></w:p>',
    '<w:style w:type="character" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Visible"><w:basedOn w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>');
  assert.equal((await validateNativePdfDocx(output)).editableText, text);
});

test('hidden source-matching text cannot satisfy coverage for a visible footer', async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['BODY 42']);
  const output = path.join(root, 'out.docx');
  await convertPdfToDocx(input, output, null, {
    docenginePath: 'fixture', run: async (_, args) => packageXml(args[2],
      '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>BODY 42</w:t></w:r></w:p>' + xmlDocxParagraph('Footer'))
  });
  assert.equal((await validateNativePdfDocx(output)).editableText, 'BODY 42');
});

test('final text fallback rechecks known content and preserves the destination on failure', async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['Body 1186.00']);
  const pages = await extractPdfRowsByPage(input), output = path.join(root, 'out.docx');
  pages[0].rows = [['Footer only']]; // Fault at the extraction/writer boundary.
  await fs.writeFile(output, 'KEEP');
  await assert.rejects(convertPdfToDocx(input, output, pages, { docenginePath: null }), { code: 'PDF_DOCX_TEXT_COVERAGE_FAILED' });
  assert.equal(await fs.readFile(output, 'utf8'), 'KEEP');
  assert.equal((await fs.readdir(root)).some(name => /\.attempt-|\.backup-/.test(name)), false);
});

function vectorBody(page, color = rgb(0, 0, 0), opacity = 1) {
  // One glyph represented by a filled outline, another by adjoining filled cells.
  page.drawSvgPath('M0 0 L30 0 L30 8 L8 8 L8 20 L25 20 L25 28 L8 28 L8 40 L30 40 L30 48 L0 48 Z',
    { x: 80, y: 650, color, opacity });
  for (let row = 0; row < 6; row++) page.drawRectangle({ x: 130, y: 650 - row * 8,
    width: 8, height: 8, color, opacity });
}

for (const native of [false, true]) test(`visible vector body cannot become footer-only success (${native ? 'native' : 'fallback'})`, async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['Powered by TCPDF (www.tcpdf.org)'], page => vectorBody(page));
  const output = path.join(root, 'out.docx');
  await fs.writeFile(output, 'KEEP');
  await assert.rejects(convertPdfToDocx(input, output, null, {
    docenginePath: native ? 'fixture' : null,
    run: async (_, args) => packageXml(args[2], xmlDocxParagraph('Powered by TCPDF (www.tcpdf.org)'))
  }), { code: 'PDF_DOCX_CONTENT_UNVERIFIED' });
  assert.equal(await fs.readFile(output, 'utf8'), 'KEEP');
});

for (const decoration of ['rules', 'shading', 'white', 'transparent', 'occluded', 'clipped']) {
  test(`${decoration} does not falsely reject a complete short native document`, async t => {
    const root = await workspace(t), input = await sourcePdf(root, ['A'], async (page, index, doc) => {
      if (decoration === 'rules') {
        page.drawRectangle({ x: 30, y: 700, width: 500, height: 100, borderColor: rgb(0, 0, 0), borderWidth: 1 });
        page.drawLine({ start: { x: 40, y: 775 }, end: { x: 80, y: 775 }, thickness: 1 });
      } else if (decoration === 'shading') {
        page.drawRectangle({ x: 30, y: 760, width: 100, height: 40, color: rgb(.8, .8, .8) });
      } else if (decoration === 'white') vectorBody(page, rgb(1, 1, 1));
      else if (decoration === 'transparent') vectorBody(page, rgb(0, 0, 0), 0);
      else if (decoration === 'clipped') {
        page.pushOperators(pushGraphicsState(), rectangle(0, 0, 10, 10), clip(), endPath());
        vectorBody(page);
        page.pushOperators(popGraphicsState());
      } else {
        vectorBody(page);
        page.drawRectangle({ x: 0, y: 0, width: 595, height: 750, color: rgb(1, 1, 1) });
      }
    });
    const output = path.join(root, 'out.docx');
    await convertPdfToDocx(input, output, null, { docenginePath: null });
    assert.equal((await validateNativePdfDocx(output)).editableText, 'A');
  });
}

for (const kind of ['cells', 'rotated', 'curve']) test(`${kind} graphical body cannot be certified by a one-character text layer`, async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['A'], page => {
    if (kind === 'cells') for (let y = 500; y < 560; y += 8) page.drawRectangle({ x: 130, y, width: 8, height: 8, color: rgb(0,0,0) });
    else if (kind === 'curve') page.drawCircle({ x: 130, y: 600, size: 12, color: rgb(0,0,0) });
    else { page.setRotation(degrees(90)); vectorBody(page); }
  });
  const output = path.join(root, 'new.docx');
  await assert.rejects(convertPdfToDocx(input, output, null, { docenginePath: null }), { code: 'PDF_DOCX_CONTENT_UNVERIFIED' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('vector verification respects image memory admission before rendering', async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['A'], page => { page.setSize(65535,65535); vectorBody(page); });
  await assert.rejects(convertPdfToDocx(input, path.join(root, 'out.docx'), null, { docenginePath: null }),
    error => error.errorCode === 'IMAGE_PIXELS_EXCEEDED' || error.errorCode === 'IMAGE_DIMENSION_EXCEEDED');
});

test('a Form XObject matrix cannot disguise a detached vector body as native text shading', async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['A'], async (page, index, doc) => {
    const source = await PDFDocument.create(), inner = source.addPage([595,842]);
    inner.drawRectangle({ x: 30, y: 760, width: 100, height: 40, color: rgb(0,0,0) });
    const embedded = await doc.embedPage(inner, undefined, [1,0,0,1,130,-180]);
    page.drawPage(embedded, { x: 0, y: 0 });
  });
  await assert.rejects(convertPdfToDocx(input, path.join(root, 'out.docx'), null, { docenginePath: null }),
    { code: 'PDF_DOCX_CONTENT_UNVERIFIED' });
});

for (const mode of ['renderer failure', 'cancellation']) test(`vector ${mode} never publishes and releases its canvas`, async t => {
  const root = await workspace(t), input = await sourcePdf(root, ['A'], page => vectorBody(page));
  const output = path.join(root, 'out.docx'); await fs.writeFile(output, 'KEEP');
  const { loadPdfjs, getPdfjsDocumentOptions } = require('../pdfjs');
  const pdfjs = await loadPdfjs(), task = pdfjs.getDocument(getPdfjsDocumentOptions({ data: new Uint8Array(await fs.readFile(input)) }));
  const pdf = await task.promise, prototype = Object.getPrototypeOf(pdf.canvasFactory);
  const original = prototype.create, destroy = prototype.destroy, controller = new AbortController();
  await task.destroy();
  let released = 0;
  t.mock.method(prototype, 'create', function (...args) {
    if (mode === 'renderer failure') throw new Error('Synthetic missing renderer');
    const canvas = original.apply(this, args); controller.abort(); return canvas;
  });
  t.mock.method(prototype, 'destroy', function (...args) { released++; return destroy.apply(this, args); });
  await assert.rejects(convertPdfToDocx(input, output, null, { docenginePath: null, signal: controller.signal }),
    { code: mode === 'cancellation' ? 'CONVERSION_CANCELED' : 'PDF_DOCX_CONTENT_UNVERIFIED' });
  assert.equal(await fs.readFile(output, 'utf8'), 'KEEP');
  if (mode === 'cancellation') assert.ok(released > 0);
});
