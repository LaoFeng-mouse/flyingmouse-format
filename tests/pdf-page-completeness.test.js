const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { classifyPdf } = require('../pdf-classifier');
const { convertPdf } = require('../pdf');
const { withConversionProgress } = require('../conversion-progress');

async function fixture(t, scan) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-complete-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  if (scan) {
    const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  }
  page.drawText('ARCHIVE COPY FM-2026-0912', { font: await pdf.embedFont(StandardFonts.Helvetica), size: 12, x: 30, y: 810 });
  if (!scan) pdf.addPage([595, 842]);
  const input = path.join(dir, 'input.pdf');
  await fs.writeFile(input, await pdf.save());
  return { dir, input };
}

test('OCR progress counts completed pages and does not advance past a failed page', async () => {
  const { fillMissingPdfPageText } = require('../pdf');
  const events = [];
  let calls = 0, terminated = false;
  const pages = [{pageNumber:1, rows:[['native']]}, {pageNumber:2,rows:[]}, {pageNumber:3,rows:[]}];
  await assert.rejects(withConversionProgress({report:event=>events.push(event)}, () => fillMissingPdfPageText('unused.pdf', pages, {
    ocrAvailable:()=>true, createOcrWorker:async()=>({terminate:async()=>{terminated=true;}}),
    renderPdfTablePage:async()=>({outputPath:'scan.png'}),
    recognizeImageResultWithWorker:async()=>{
      calls++;
      assert.equal(events.at(-1).completed,calls-1);
      if(calls===2)throw new Error('scan page failed');
      return {text:'kept scan 1186.00',warnings:[]};
    }
  })), /scan page failed/);
  assert.deepEqual(events.map(event=>[event.completed,event.total]),[[0,2],[1,2]]);
  assert.equal(terminated,true);
});

test('PDF merge and native Poppler rendering report actual completed work', async t => {
  const {mergePdfFiles,renderPdfPages}=require('../pdf');
  const {PDFTOPPM_PATH}=require('../config');
  const {commandExists}=require('../utils');
  const {dir,input}=await fixture(t,false);
  const mergeEvents=[];
  const merged=path.join(dir,'merged.pdf');
  await withConversionProgress({report:event=>mergeEvents.push(event)},()=>mergePdfFiles([{inputPath:input},{inputPath:input}],merged));
  assert.deepEqual(mergeEvents.filter(event=>event.stage==='merging'&&event.unit==='files').map(event=>[event.completed,event.total,event.unit]),[[0,2,'files'],[1,2,'files'],[2,2,'files']]);
  assert.equal((await PDFDocument.load(await fs.readFile(merged))).getPageCount(),4);
  if(!(await commandExists(PDFTOPPM_PATH,['-v'])))return t.diagnostic('Poppler unavailable; native page progress check not run');
  const renderEvents=[];
  const rendered=await withConversionProgress({report:event=>renderEvents.push(event)},()=>renderPdfPages(merged,'png',36));
  try{
    assert.equal(rendered.files.length,4);
    assert.deepEqual(renderEvents.filter(event=>event.stage==='converting').map(event=>event.completed),[0,1,2,3,4]);
    for(const file of rendered.files)assert.ok((await fs.stat(file)).size>0);
  }finally{await fs.rm(rendered.tempDir,{recursive:true,force:true});}
});

for (const engine of ['qpdf', 'pdf-lib']) test(`${engine} split keeps ZIP writing in an unknown conversion stage`, { timeout: 15000 }, async t => {
  const { QPDF_PATH } = require('../config');
  if (engine === 'qpdf' && !(await require('../utils').commandExists(QPDF_PATH, ['--version']))) return t.skip('Native qpdf is unavailable');
  let { splitPdfToZip } = require('../pdf');
  if (engine === 'pdf-lib') {
    // Force only native availability off; load the same PDF module and retain
    // real PDF parsing, page copying, ZIP compression and filesystem writes.
    const modulePath = require.resolve('../pdf'), cached = require.cache[modulePath];
    const availability = t.mock.method(require('../utils'), 'commandExists', async () => false);
    try { delete require.cache[modulePath]; ({ splitPdfToZip } = require('../pdf')); }
    finally { require.cache[modulePath] = cached; availability.mock.restore(); }
  }
  const { dir, input } = await fixture(t, false);
  const output = path.join(dir, 'split.zip');
  const sourceBytes = await fs.readFile(input);
  const fileStreams = require('node:fs');
  const createWriteStream = fileStreams.createWriteStream;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(fileStreams, 'createWriteStream', (file, ...args) => {
    const stream = createWriteStream(file, ...args);
    if (path.resolve(String(file)) === output) {
      let held = false;
      for (const method of ['_write', '_writev']) {
        const write = stream[method];
        stream[method] = function(...args) {
          if (held) return write.apply(this, args);
          held = true; enter();
          barrier.then(() => write.apply(this, args));
        };
      }
    }
    return stream;
  });
  const events = [];
  const registry = require('../conversion-progress').createProgressRegistry({ sweepIntervalMs: 0 });
  const id = require('node:crypto').randomUUID(), scope = registry.create(id);
  t.after(() => registry.dispose());
  let settled = false;
  const conversion = withConversionProgress({ report: event => { events.push(event); return scope.report(event); } }, () => splitPdfToZip(input, output));
  conversion.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([entered, conversion.then(() => assert.fail('ZIP write barrier was not reached'))]);
    assert.equal(settled, false, 'ZIP conversion must remain pending at its first real write');
    const { status, stage, completed, total, unit } = registry.get(id);
    t.diagnostic('Progress during blocked ZIP write: ' + JSON.stringify({ status, stage, completed, total, unit }));
    assert.deepEqual({ status, stage, completed, total, unit }, { status: 'running', stage: 'converting', completed: null, total: null, unit: null });
    assert.ok(!events.some(event => event.stage === 'validating'), 'ZIP writing must not report output validation');
  } finally {
    release();
    await conversion;
  }
  const zip = await require('../zip-util').openZipEntriesFromBuffer(await fs.readFile(output));
  const entries = await new Promise((resolve, reject) => {
    const entries = [];
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('error', reject);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
    }));
    zip.readEntry();
  });
  assert.deepEqual(entries.map(entry => entry.name), ['page-001.pdf', 'page-002.pdf']);
  for (const entry of entries) assert.equal((await PDFDocument.load(entry.bytes)).getPageCount(), 1);
  assert.deepEqual(await fs.readFile(input), sourceBytes, 'Splitting must not alter the original PDF');
});

test('PDF merge clears completed file counts while saving its output', { timeout: 15000 }, async t => {
  const { mergePdfFiles } = require('../pdf');
  const { dir, input } = await fixture(t, false);
  const output = path.join(dir, 'merge-writing.pdf');
  const writeFile = fs.writeFile;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.resolve(String(file)) === output) { enter(); await barrier; }
    return writeFile(file, ...args);
  });
  const registry = require('../conversion-progress').createProgressRegistry({ sweepIntervalMs: 0 });
  const id = require('node:crypto').randomUUID(), scope = registry.create(id), events = [];
  t.after(() => registry.dispose());
  let settled = false;
  const conversion = withConversionProgress({ report: event => { events.push(event); return scope.report(event); } }, () =>
    mergePdfFiles([{ inputPath: input }, { inputPath: input }], output));
  conversion.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([entered, conversion.then(() => assert.fail('PDF write barrier was not reached'))]);
    assert.equal(settled, false);
    assert.deepEqual(events.filter(event => event.unit === 'files').map(event => event.completed), [0, 1, 2]);
    const { status, stage, completed, total, unit } = registry.get(id);
    t.diagnostic('Progress during blocked PDF write: ' + JSON.stringify({ status, stage, completed, total, unit }));
    assert.deepEqual({ status, stage, completed, total, unit }, { status: 'running', stage: 'merging', completed: null, total: null, unit: null });
  } finally { release(); await conversion; }
  assert.equal((await PDFDocument.load(await fs.readFile(output))).getPageCount(), 4);
});

for (const target of ['txt', 'html', 'md']) {
  test(`native header over scan retains the body and native spelling in ${target}`, async t => {
    const { dir, input } = await fixture(t, true);
    const calls = [];
    const output = path.join(dir, `output.${target}`);
    const result = await convertPdf(input, output, target, {
      ocrAvailable: () => true,
      createOcrWorker: async () => ({ terminate: async () => {} }),
      renderPdfTablePage: async (_input, page) => { calls.push(page); return { outputPath: 'scan.png' }; },
      recognizeImageResultWithWorker: async () => ({ text: 'ARCHIVE COPY FM-2026-0912\n采购明细单\n合计 1186.00', confidence: 90, warnings: [{ code: 'OCR_REVIEW_RECOMMENDED' }] })
    });
    const text = await fs.readFile(output, 'utf8');
    assert.match(text, /采购明细单/);
    assert.match(text, /1186\.00/);
    assert.equal((text.match(/ARCHIVE COPY/g) || []).length, 1);
    assert.deepEqual(calls, [1]);
    assert.ok(result.warnings.some(w => w.code === 'OCR_REVIEW_RECOMMENDED'));
  });
}

test('a genuinely empty trailing page needs no OCR and keeps native routing', async t => {
  const { dir, input } = await fixture(t, false);
  const pages = await extractPdfRowsByPage(input);
  assert.equal(pages[1].blank, true);
  assert.equal((await classifyPdf(input)).kind, 'native');
  const output = path.join(dir, 'out.txt');
  await convertPdf(input, output, 'txt', { ocrAvailable: () => false });
  assert.match(await fs.readFile(output, 'utf8'), /ARCHIVE COPY/);
});

test('a native paragraph does not hide a smaller scanned body below it', async t => {
  const { dir } = await fixture(t, false);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  page.drawImage(png, { x: 0, y: 0, width: 595, height: 421 });
  for (let index = 0; index < 7; index++) page.drawText(`Account metadata line ${index}: this record contains a scanned invoice below.`, { font, size: 10, x: 30, y: 810 - index * 18 });
  const input = path.join(dir, 'partial.pdf');
  await fs.writeFile(input, await pdf.save());
  const extracted = await extractPdfRowsByPage(input);
  assert.ok(extracted[0].rows.flat().join('').length > 160);
  assert.equal(extracted[0].imageCoverage, 0.5);
  const output = path.join(dir, 'partial.txt');
  let calls = 0;
  await convertPdf(input, output, 'txt', {
    ocrAvailable: () => true,
    createOcrWorker: async () => ({ terminate: async () => {} }),
    renderPdfTablePage: async () => ({ outputPath: 'scan.png' }),
    recognizeImageResultWithWorker: async (_worker, _image, options) => {
      calls++;
      assert.equal(options.includeGeometry, true);
      // A whole-page OCR response that omits the digital paragraphs must
      // establish that its remaining text is in the separate scanned area.
      // Without boxes, an altered OCR copy of those paragraphs is ambiguous.
      const lines = [{ text: '采购明细单', bbox: [30, 500, 130, 515] },
        { text: '合计1186.00', bbox: [30, 530, 150, 545] }];
      return { text: lines.map(line => line.text).join('\n'), confidence: 90, warnings: [],
        orientation: 0, deskewAngle: 0,
        geometry: { width: 595, height: 842, lines: lines.map(line => ({ ...line, words: [{ ...line }] })) } };
    }
  });
  assert.equal(calls, 1);
  const text = await fs.readFile(output, 'utf8');
  assert.match(text, /采购明细单/);
  assert.match(text, /1186\.00/);
  for (let index = 0; index < 7; index++) {
    assert.equal(text.split(`Account metadata line ${index}:`).length-1, 1);
  }
  assert.ok(text.indexOf('Account metadata line 6:') < text.indexOf('采购明细单'));
});

test('native monetary punctuation survives when OCR merges the text into a longer line', async () => {
  const { fillMissingPdfPageText } = require('../pdf');
  const result = await fillMissingPdfPageText('unused.pdf', [{ pageNumber: 1, imageCoverage: 1, rows: [['Total 1186.00']] }], {
    ocrAvailable: () => true,
    createOcrWorker: async () => ({ terminate: async () => {} }),
    renderPdfTablePage: async () => ({ outputPath: 'unused.png' }),
    recognizeImageResultWithWorker: async () => ({ text: 'Invoice Total 118600', confidence: 90, warnings: [] })
  });
  assert.match(result[0].rows.flat().join('\n'), /1186\.00/);
});

async function observeOutputWrite(t, output, convert) {
  const streams = require('node:fs');
  const createWriteStream = streams.createWriteStream;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(streams, 'createWriteStream', (file, ...args) => {
    const stream = createWriteStream(file, ...args);
    if (path.resolve(String(file)) === output) {
      let held = false;
      for (const method of ['_write', '_writev']) {
        const write = stream[method];
        stream[method] = function(...args) {
          if (held) return write.apply(this, args);
          held = true; enter();
          barrier.then(() => write.apply(this, args));
        };
      }
    }
    return stream;
  });
  const registry = require('../conversion-progress').createProgressRegistry({ sweepIntervalMs: 0 });
  const id = require('node:crypto').randomUUID(), scope = registry.create(id), events = [];
  t.after(() => registry.dispose());
  let settled = false;
  const conversion = withConversionProgress({ report: event => { events.push(event); return scope.report(event); } }, convert);
  conversion.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([entered, conversion.then(() => assert.fail('Output write barrier was not reached'))]);
    assert.equal(settled, false);
    const { status, stage, completed, total, unit } = registry.get(id);
    t.diagnostic('Progress during blocked output write: ' + JSON.stringify({ status, stage, completed, total, unit }));
    assert.deepEqual({ status, stage, completed, total, unit }, { status: 'running', stage: 'converting', completed: null, total: null, unit: null });
  } finally { release(); await conversion; }
  return events;
}

test('PDF table extraction clears completed pages before real ExcelJS output', { timeout: 15000 }, async t => {
  const { dir } = await fixture(t, false);
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const rows = [['Product', 'Quantity'], ['Widget', '1.5'], ['Bracket', '2.5']];
  for (const [index, row] of rows.entries()) {
    page.drawText(row[0], { x: 20, y: 160 - index * 25, size: 12 });
    page.drawText(row[1], { x: 180, y: 160 - index * 25, size: 12 });
  }
  const input = path.join(dir, 'table.pdf'), output = path.join(dir, 'table.xlsx');
  await fs.writeFile(input, await document.save());
  const events = await observeOutputWrite(t, output, () => convertPdf(input, output, 'xlsx', {
    classifyPdf: async () => ({ kind: 'native', pages: [{ pageNumber: 1, kind: 'native' }] }),
    extractTablesViaDocengine: async () => [], renderPage: async () => null,
    ocrPage: async () => assert.fail('native table must not require OCR')
  }));
  assert.ok(events.some(event => event.completed === 1 && event.total === 1 && event.unit === 'pages'));
  await require('jszip').loadAsync(await fs.readFile(output), { checkCRC32: true });
  const workbook = new (require('exceljs').Workbook)();
  await workbook.xlsx.readFile(output);
  const values = workbook.worksheets.filter(sheet => sheet.name !== '识别说明')
    .flatMap(sheet => sheet.getSheetValues().slice(1).flat()).filter(value => value !== undefined).map(String);
  for (const value of rows.flat()) assert.ok(values.includes(value), `missing editable cell ${value}`);
});

for (const source of ['pdf', 'presentation']) test(`${source} image ZIP writing clears the render validation stage`, { timeout: 15000 }, async t => {
  const { dir, input } = await fixture(t, false);
  const output = path.join(dir, `${source}-images.zip`);
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#c04020' } }).png().toBuffer();
  const utils = require('../utils'), config = require('../config');
  const available = t.mock.method(utils, 'commandExists', async command => command === config.PDFTOPPM_PATH);
  // Only Office/Poppler boundaries are substituted. The PDF count/parser,
  // progress observer, filesystem streams and ZIP contents remain real.
  const render = t.mock.method(utils, 'run', async (command, args, options) => {
    assert.equal(command, config.PDFTOPPM_PATH);
    assert.ok(args.includes('-progress'));
    const prefix = args.at(-1);
    for (let page = 1; page <= 2; page++) {
      const file = `${prefix}-${page}.png`;
      await fs.writeFile(file, png);
      options.onStderr(Buffer.from(`${page} 2 ${file}\n`));
    }
    return { stdout: '', stderr: '' };
  });
  if (source === 'presentation') t.mock.method(require('../office-convert'), 'convertWithLibreOffice', async (_input, pdfPath) => fs.copyFile(input, pdfPath));
  const modulePath = require.resolve('../pdf'), cached = require.cache[modulePath];
  let pdf;
  try { delete require.cache[modulePath]; pdf = require('../pdf'); }
  finally { require.cache[modulePath] = cached; available.mock.restore(); render.mock.restore(); }
  await observeOutputWrite(t, output, () => source === 'pdf'
    ? pdf.convertPdfPagesToImagesZip(input, output, 'png')
    : pdf.convertPresentationToImages('input.pptx', output, '课件.pptx', 'png'));
  const zip = await require('jszip').loadAsync(await fs.readFile(output), { checkCRC32: true });
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  assert.deepEqual(names, source === 'pdf' ? ['page-001.png', 'page-002.png'] : ['课件-第1页.png', '课件-第2页.png']);
  for (const name of names) assert.deepEqual(await zip.file(name).async('nodebuffer'), png);
});
