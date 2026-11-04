const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { Readable, PassThrough } = require('node:stream');
const { test } = require('node:test');
const os = require('node:os');
const dependencyRoot = path.resolve(__dirname, '..');
const evidenceBase = process.env.FLYINGMOUSE_RUNTIME_DIR || os.tmpdir();
fs.mkdirSync(evidenceBase, { recursive: true });
const outputRoot = fs.mkdtempSync(path.join(evidenceBase, 'dependency-compatibility-'));
const req = createRequire(path.join(dependencyRoot, 'package.json'));
const ExcelJS = req('exceljs');
const JSZip = req('jszip');
const archiver = req('archiver');
const unzipper = req('unzipper');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sorted = values => [...values].map(value => value.replace(/\\/g, '/')).sort();
async function zipBytes(zip) {
  const output = new PassThrough(), parts = [];
  output.on('data', part => parts.push(part));
  const done = new Promise((resolve, reject) => { output.on('end', resolve); output.on('error', reject); zip.on('error', reject); });
  zip.pipe(output);
  return { finish: async () => { await zip.finalize(); await done; return Buffer.concat(parts); } };
}
async function readStreamWorkbook(file) {
  const result = [];
  for await (const sheet of new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'cache', styles: 'cache' })) {
    const rows = [];
    for await (const row of sheet) rows.push({ number: row.number, values: row.values.slice(1), font: row.getCell(1).font });
    result.push({ name: sheet.name, rows });
  }
  return result;
}
function documentWorkbook() {
  const book = new ExcelJS.Workbook(); book.creator = '牢蜂'; book.created = new Date('2026-11-03T00:00:00Z');
  const sheet = book.addWorksheet('中文 表格', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, printArea: 'A1:D5' }, views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.mergeCells('A1:D1'); sheet.getCell('A1').value = '飞鼠 Excel 回归';
  sheet.addRow(['0012', 1250.5, new Date('2026-10-30T00:00:00Z'), { formula: 'B2*2', result: 2501 }]);
  sheet.getCell('A2').font = { name: '仿宋', size: 12, bold: true, color: { argb: 'FF224466' } };
  sheet.getCell('A2').alignment = { wrapText: true, vertical: 'middle' };
  sheet.getCell('A2').border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  sheet.getCell('B2').numFmt = '0.00'; sheet.getCell('B2').note = '核对金额';
  sheet.getCell('A3').value = { text: '文件说明', hyperlink: 'https://example.com/' };
  sheet.getCell('A4').value = { richText: [{ text: '粗体', font: { bold: true } }, { text: '普通' }] };
  sheet.getColumn(1).width = 22.4; sheet.getRow(2).height = 31;
  sheet.autoFilter = 'A2:D2'; sheet.getCell('C3').dataValidation = { type: 'list', formulae: ['"甲,乙"'] };
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z04AAAAASUVORK5CYII=', 'base64');
  sheet.addImage(book.addImage({ buffer: pixel, extension: 'png' }), { tl: { col: 4, row: 1 }, ext: { width: 32, height: 32 } });
  sheet.getCell('A5').value = '12345678901234567890';
  book.addWorksheet('隐藏数据', { state: 'hidden' }).getCell('A1').value = '保留';
  return book;
}

test('dependency upgrades preserve real ExcelJS and ZIP operations', { timeout: 90000 }, async t => {
  t.diagnostic(`Artifacts: ${outputRoot}`);
  const check = (name, fn) => t.test(name, { timeout: 30000 }, fn);
  await fsp.mkdir(outputRoot, { recursive: true });
  const tree = path.join(outputRoot, 'tree');
  const files = ['alpha.txt', 'bravo.csv', 'same-1.txt', 'same-a.txt', '.hidden.txt', 'UPPER.TXT', 'nested/alpha.txt', 'nested/bravo.txt', 'nested/skip.txt', 'nested/.dot.txt', 'nested/deeper/item.txt', '中文/数据.txt'];
  for (const file of files) { await fsp.mkdir(path.dirname(path.join(tree, file)), { recursive: true }); await fsp.writeFile(path.join(tree, file), `content:${file}\n`); }
  await check('complete ExcelJS public API remains available', async () => {
    for (const name of ['Workbook', 'ModelContainer', 'ValueType', 'FormulaType', 'RelationshipType', 'DocumentType', 'ReadingOrder', 'ErrorValue']) assert.ok(ExcelJS[name], name);
    assert.equal(typeof ExcelJS.stream.xlsx.WorkbookWriter, 'function');
    assert.equal(typeof ExcelJS.stream.xlsx.WorkbookReader, 'function');
    return Object.keys(ExcelJS);
  });
  await check('document workbook file/buffer read-write preserves types, styles, merged cells, notes, images and print settings', async () => {
    const book = documentWorkbook();
    const filename = path.join(outputRoot, '普通-完整样式.xlsx'); await book.xlsx.writeFile(filename);
    const buffer = Buffer.from(await book.xlsx.writeBuffer()); await fsp.writeFile(path.join(outputRoot, '普通-buffer.xlsx'), buffer);
    for (const mode of ['file', 'buffer']) {
      const result = new ExcelJS.Workbook(); if (mode === 'file') await result.xlsx.readFile(filename); else await result.xlsx.load(buffer);
      const actual = result.getWorksheet('中文 表格');
      assert.equal(actual.getCell('A5').value, '12345678901234567890');
      assert.equal(actual.getCell('C2').value.toISOString(), '2026-10-30T00:00:00.000Z');
      assert.equal(actual.getCell('D2').value.result, 2501);
      assert.equal(result.creator, '牢蜂'); assert.equal(actual.getCell('A2').value, '0012'); assert.equal(actual.getCell('A2').type, ExcelJS.ValueType.String);
      assert.equal(actual.getCell('B2').value, 1250.5); assert.equal(actual.getCell('D2').value.formula, 'B2*2');
      assert.equal(actual.getCell('D1').master.address, 'A1'); assert.equal(actual.getCell('A2').font.name, '仿宋');
      assert.equal(actual.getCell('A2').font.bold, true); assert.equal(actual.getCell('B2').numFmt, '0.00');
      assert.equal(actual.getCell('A2').border.bottom.style, 'thin'); assert.equal(actual.getRow(2).height, 31);
      assert.equal(actual.getCell('B2').note, '核对金额'); assert.equal(actual.getImages().length, 1);
      assert.equal(actual.pageSetup.orientation, 'landscape'); assert.equal(actual.pageSetup.printArea, 'A1:D5');
      assert.equal(result.getWorksheet('隐藏数据').state, 'hidden');
    }
    return { filename, sha256: hash(filename), bufferBytes: buffer.length };
  });
  await check('stream writer and both reader APIs retain 3000 rows, shared strings, styles and Unicode', async () => {
    const filename = path.join(outputRoot, '流式-3000行.xlsx');
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: true, useSharedStrings: true });
    const sheet = writer.addWorksheet('流式表');
    sheet.columns = [{ width: 20 }, { width: 14 }, { width: 32 }];
    for (let i = 1; i <= 3000; i++) { const row = sheet.addRow([`编号${String(i).padStart(5, '0')}`, i + 0.25, '重复中文']); if (i === 1) row.getCell(1).font = { bold: true, name: '仿宋' }; row.commit(); }
    sheet.commit(); await writer.commit();
    const regular = new ExcelJS.Workbook(); await regular.xlsx.readFile(filename);
    assert.equal(regular.worksheets[0].rowCount, 3000); assert.equal(regular.worksheets[0].getCell('A3000').value, '编号03000');
    const streamed = await readStreamWorkbook(filename);
    assert.equal(streamed.length, 1); assert.equal(streamed[0].rows.length, 3000);
    assert.deepEqual(streamed[0].rows[2999].values, ['编号03000', 3000.25, '重复中文']); assert.equal(streamed[0].rows[0].font.bold, true);
    let rowCount = 0;
    const events = new ExcelJS.stream.xlsx.WorkbookReader(filename, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
    events.on('worksheet', worksheet => worksheet.on('row', () => rowCount++));
    await new Promise((resolve, reject) => { events.on('finished', resolve); events.on('error', reject); events.read(); });
    assert.equal(rowCount, 3000);
    return { filename, sha256: hash(filename), rows: 3000, asyncIterator: true, eventReader: true };
  });
  await check('stream reader handles document ZIP ordering and corrupt archives explicitly', async () => {
    const filename = path.join(outputRoot, '普通-流读独立样本.xlsx');
    await documentWorkbook().xlsx.writeFile(filename);
    const sheets = await readStreamWorkbook(filename);
    assert.equal(sheets.length, 2); assert.equal(sheets[0].rows[1].values[0], '0012');
    // A streaming ZIP parser may accept complete local entries without the
    // central-directory trailer. The product's document reader must reject it.
    const missingTrailer = path.join(outputRoot, '缺少ZIP尾部.xlsx');
    await fsp.writeFile(missingTrailer, (await fsp.readFile(filename)).subarray(0, -22));
    await assert.rejects(() => new ExcelJS.Workbook().xlsx.readFile(missingTrailer));
    const corrupt = path.join(outputRoot, '故意截断.xlsx'); await fsp.writeFile(corrupt, (await fsp.readFile(filename)).subarray(0, 100));
    await assert.rejects(async () => { for await (const sheet of new ExcelJS.stream.xlsx.WorkbookReader(corrupt)) for await (const row of sheet) void row; });
    return { documentOrderWorks: true, truncatedArchiveRejected: true };
  });
  await check('CSV read and write preserve quoted multiline Unicode fields', async () => {
    const book = new ExcelJS.Workbook(); const sheet = await book.csv.read(Readable.from(['名称,编号,说明\n鼠鼠,0012,"第一行\n第二行,含逗号"\n']), { map: value => value });
    assert.equal(sheet.getCell('B2').value, '0012'); assert.equal(sheet.getCell('C2').value, '第一行\n第二行,含逗号');
    const output = await book.csv.writeBuffer(); const checkBook = new ExcelJS.Workbook(); await checkBook.csv.read(Readable.from([output]), { map: value => value });
    assert.equal(checkBook.worksheets[0].getCell('C2').value, sheet.getCell('C2').value);
    await fsp.writeFile(path.join(outputRoot, 'CSV引号和换行.csv'), output); return { bytes: output.length };
  });
  await check('stream and document readers reject truncated worksheet XML and damaged compressed entries', async () => {
    const bytes = Buffer.from(await documentWorkbook().xlsx.writeBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', xml.slice(0, Math.floor(xml.length / 2)));
    const badXml = path.join(outputRoot, '截断单元格XML.xlsx');
    await fsp.writeFile(badXml, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const damaged = Buffer.from(bytes);
    let changed = false;
    for (let offset = 0; offset + 30 < damaged.length && damaged.readUInt32LE(offset) === 0x04034b50;) {
      const size = damaged.readUInt32LE(offset + 18), nameLength = damaged.readUInt16LE(offset + 26);
      const data = offset + 30 + nameLength + damaged.readUInt16LE(offset + 28);
      if (damaged.subarray(offset + 30, offset + 30 + nameLength).toString() === 'xl/worksheets/sheet1.xml') {
        assert.equal(damaged.readUInt16LE(offset + 8), 8);
        damaged[data] = 0xff; damaged[data + 1] = 0xff;
        changed = true; break;
      }
      offset = data + size;
    }
    assert.ok(changed, 'Real compressed worksheet was located');
    const badDeflate = path.join(outputRoot, '损坏压缩数据.xlsx');
    await fsp.writeFile(badDeflate, damaged);
    for (const [file, expected] of [[badXml, /unexpected end|unclosed tag/], [badDeflate, /invalid block type/]]) {
      await assert.rejects(() => readStreamWorkbook(file), expected);
      const events = new ExcelJS.stream.xlsx.WorkbookReader(file);
      await assert.rejects(() => new Promise((resolve, reject) => {
        events.on('error', reject); events.on('finished', resolve); events.read();
      }), expected);
      await assert.rejects(() => new ExcelJS.Workbook().xlsx.readFile(file));
    }
  });
  await check('glob sync and async preserve wildcard, brace, extglob, dotfile, ignore, nocase and Unicode matching', async () => {
    const glob = req('glob');
    const patterns = [
      ['*.txt', {}, ['alpha.txt', 'same-1.txt', 'same-a.txt']],
      ['*.{txt,csv}', {}, ['alpha.txt', 'bravo.csv', 'same-1.txt', 'same-a.txt']],
      ['**/@(alpha|bravo).txt', {}, ['alpha.txt', 'nested/alpha.txt', 'nested/bravo.txt']],
      ['nested/!(skip).txt', {}, ['nested/alpha.txt', 'nested/bravo.txt']],
      ['same-?.txt', {}, ['same-1.txt', 'same-a.txt']],
      ['**/*.txt', { ignore: ['nested/**'], dot: true }, ['alpha.txt', 'same-1.txt', 'same-a.txt', '.hidden.txt', '中文/数据.txt']],
      ['*.TXT', { nocase: true }, ['alpha.txt', 'same-1.txt', 'same-a.txt', 'UPPER.TXT']],
      ['中文/*.txt', {}, ['中文/数据.txt']],
      ['nested/**/[ab]*.txt', {}, ['nested/alpha.txt', 'nested/bravo.txt']]
    ];
    for (const [pattern, options, expected] of patterns) {
      const opts = { cwd: tree, nodir: true, nocase: false, ...options };
      assert.deepEqual(sorted(glob.sync(pattern, opts)), sorted(expected), `sync ${pattern}`);
      const actual = typeof glob === 'function'
        ? await new Promise((resolve, reject) => glob(pattern, opts, (error, values) => error ? reject(error) : resolve(values)))
        : await glob.glob(pattern, opts);
      assert.deepEqual(sorted(actual), sorted(expected), `async ${pattern}`);
    }
    return { patterns: patterns.length, syncAndAsync: true };
  });
  await check('readdir-glob preserves recursive patterns, ignores and hidden files', async () => {
    const glob = req('readdir-glob');
    const actual = await new Promise((resolve, reject) => glob(tree, { pattern: '**/*.txt', dot: true, nodir: true, ignore: ['**/skip.txt'] }, (error, values) => error ? reject(error) : resolve(values)));
    assert.deepEqual(sorted(actual), sorted(files.filter(file => file.endsWith('.txt') && !file.endsWith('skip.txt'))));
    return { matches: actual.length };
  });
  await check('archiver append, file, directory and glob retain exact ZIP members and bytes', async () => {
    const zip = archiver('zip', { zlib: { level: 6 } }); const bytes = await zipBytes(zip);
    zip.append('literal中文', { name: 'literal.txt' });
    zip.file(path.join(tree, 'alpha.txt'), { name: 'single/alpha.txt' });
    zip.directory(path.join(tree, '中文'), 'folder');
    zip.glob('**/*.txt', { cwd: tree, dot: true, ignore: ['**/skip.txt'] }, { prefix: 'matched' });
    const buffer = await bytes.finish(); const filename = path.join(outputRoot, '归档-通配符.zip'); await fsp.writeFile(filename, buffer);
    const loaded = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const expected = ['literal.txt', 'single/alpha.txt', 'folder/数据.txt', ...files.filter(file => file.endsWith('.txt') && !file.endsWith('skip.txt')).map(file => `matched/${file}`)];
    assert.deepEqual(sorted(Object.values(loaded.files).filter(entry => !entry.dir).map(entry => entry.name)), sorted(expected));
    assert.equal(await loaded.file('matched/中文/数据.txt').async('string'), 'content:中文/数据.txt\n');
    assert.equal(await loaded.file('literal.txt').async('string'), 'literal中文');
    const opened = await unzipper.Open.file(filename);
    assert.equal(opened.files.filter(entry => entry.type === 'File').length, expected.length);
    return { filename, sha256: hash(filename), files: expected.length };
  });
});
