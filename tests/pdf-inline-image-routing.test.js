const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Document, Paragraph, Packer } = require('docx');
const { convertPdfToDocx, validateNativePdfDocx } = require('../pdf');

const pages = [{ pageNumber: 1, rows: [['Native words before and after the label']], imageCoverage: .01 }];
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fmf-inline-route-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, output: path.join(directory, 'result.docx') };
}
async function writeDocument(outputPath, text) {
  await fs.writeFile(outputPath, await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph(text)] }]
  })));
}

test('native-image recovery is validated and published before whole-page OCR', async t => {
  const { output } = await setup(t);
  const expected = { warnings: [{ code: 'PDF_INLINE_IMAGES_PRESERVED' }] };
  const result = await convertPdfToDocx('unused.pdf', output, pages, {
    docenginePath: null,
    ocrAvailable: () => { throw new Error('Whole-page OCR must not run after validated recovery'); },
    convertInlineImagePdfToDocx: async ({ outputPath, pages: source }) => {
      assert.notEqual(outputPath, output, 'new output remains unpublished during validation');
      await writeDocument(outputPath, source[0].rows[0][0]);
      return expected;
    }
  });
  assert.deepEqual(result, expected);
  assert.equal((await validateNativePdfDocx(output)).hasEditableContent, true);
});

test('inline-image recovery cannot publish omitted native text or replace an existing file', async t => {
  const { directory, output } = await setup(t);
  await fs.writeFile(output, 'existing result');
  await assert.rejects(convertPdfToDocx('unused.pdf', output, pages, {
    docenginePath: null,
    convertInlineImagePdfToDocx: async ({ outputPath }) => {
      await writeDocument(outputPath, 'Native words before');
      return { warnings: [] };
    }
  }), { code: 'PDF_DOCX_TEXT_COVERAGE_FAILED' });
  assert.equal(await fs.readFile(output, 'utf8'), 'existing result');
  assert.deepEqual(await fs.readdir(directory), ['result.docx']);
});

test('unsupported inline content retains the OCR requirement and its actionable failure', async t => {
  const { directory, output } = await setup(t);
  await assert.rejects(convertPdfToDocx('unused.pdf', output, pages, {
    docenginePath: null, ocrAvailable: () => false,
    convertInlineImagePdfToDocx: async () => null
  }), { code: 'PDF_OCR_REQUIRED' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('cancellation after inline reconstruction never replaces an existing output', async t => {
  const { directory, output } = await setup(t), controller = new AbortController();
  await fs.writeFile(output, 'existing result');
  await assert.rejects(convertPdfToDocx('unused.pdf', output, pages, {
    docenginePath: null, signal: controller.signal,
    convertInlineImagePdfToDocx: async ({ outputPath }) => {
      await writeDocument(outputPath, pages[0].rows[0][0]);
      controller.abort();
      return { warnings: [] };
    }
  }), { code: 'CONVERSION_CANCELED' });
  assert.equal(await fs.readFile(output, 'utf8'), 'existing result');
  assert.deepEqual(await fs.readdir(directory), ['result.docx']);
});
