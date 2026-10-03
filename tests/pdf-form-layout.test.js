'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const yauzl = require('yauzl');
const { detectTablesOnPage, buildWorkbookModel } = require('../pdf-table-extractor');
const { writePdfTableWorkbook } = require('../pdf-table');

const attachment = '附件9：';
const title = '示例学院家庭情况登记表';
const leftSignature = '负责人（签字）：';
const rightSignature = '审核人（签字）：';
const note = '请核对全部信息后以电子表格形式报送。';
const footer = '—37—';
const identity = '001234567890123456789';
const word = (text, x, y, width = 80, height = 16) => ({ text, x, y, width, height, confidence: 1 });

function formInput({ pageNumber = 1, source = 'text', merged = false, multiline = false } = {}) {
  const xs = [50, 180, 420, 700, 950], ys = [150, 195, 235, 275];
  const words = [word(attachment, 50, 30, 100, 16), word(title, 200, 70, 580, 24),
    word(merged ? '综合信息' : '序号', 60, 163, merged ? 250 : 60),
    ...(!merged ? [word('身份证号', 190, 163, 170)] : []),
    ...(multiline ? [word('家庭人均', 440, 153, 100), word('年收入（元）', 440, 175, 130)] : [word('家庭收入', 440, 163, 100)]),
    word('说明', 720, 163, 70),
    word('001', 60, 205, 60), word(identity, 190, 205, 200), word('0012.00', 440, 205, 100), word('可编辑', 720, 205, 100),
    word('002', 60, 245, 60), word('000000000000000000002', 190, 245, 200), word('0.00', 440, 245, 100), word('=1+1', 720, 245, 100),
    word(leftSignature, 80, 340, 230, 18), word(rightSignature, 620, 340, 250, 18),
    word(note, 50, 410, 800, 16), word(footer, 460, 550, 80, 16)];
  return { pageNumber, source, width: 1000, height: 600, words, lines: [
    ...ys.map(y => ({ x1: xs[0], y1: y, x2: xs.at(-1), y2: y })),
    ...xs.map((x, index) => ({ x1: x, y1: merged && index === 1 ? ys[1] : ys[0], x2: x, y2: ys.at(-1) }))
  ] };
}

function pageAndModel(options) {
  const page = detectTablesOnPage(formInput(options));
  assert.equal(page.tables.length, 1, 'The fixture itself must contain one reliable ruled table');
  return { page, model: buildWorkbookModel([page]) };
}

async function readMainSheetXml(output) {
  const bytes = await fs.readFile(output);
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let xml;
    zip.on('error', reject);
    zip.on('end', () => xml == null ? reject(new Error('Missing first worksheet XML')) : resolve(xml));
    zip.on('entry', entry => {
      if (entry.fileName !== 'xl/worksheets/sheet1.xml') return zip.readEntry();
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) { zip.close();return reject(streamError); }
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { xml = Buffer.concat(chunks).toString('utf8');zip.readEntry(); });
      });
    });
    zip.readEntry();
  }));
}

function rowXml(xml, number) {
  const tag = [...xml.matchAll(/<row\b[^>]*>/g)].find(match => new RegExp(`\\br="${number}"(?:\\s|>)`).test(match[0]));
  assert.ok(tag, `Worksheet must serialize row ${number}`);
  return tag[0];
}

async function workbookFor(t, model, { includeMainSheetXml = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-pdf-form-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const output = path.join(root, 'form.xlsx');
  await writePdfTableWorkbook(model, output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  if (includeMainSheetXml) return { workbook, mainSheetXml: await readMainSheetXml(output) };
  return workbook;
}

function actualCells(sheet) {
  const cells = [];
  sheet.eachRow(row => row.eachCell(cell => {
    if (!cell.isMerged || cell.master === cell) cells.push(cell);
  }));
  return cells;
}

function oneCell(sheet, text) {
  const cells = actualCells(sheet).filter(cell => cell.value === text);
  assert.equal(cells.length, 1, `The main form must retain exactly one editable cell containing ${JSON.stringify(text)}`);
  return cells[0];
}

function mainSheet(workbook, model) {
  const item = model.sheets.find(sheet => !sheet.name.endsWith('-Raw'));
  assert.ok(item);
  return workbook.getWorksheet(item.name);
}

test('native non-table blocks retain two independent signatures at the same Y and different X', () => {
  const { page } = pageAndModel();
  assert.ok(Array.isArray(page.rawBlocks), 'Raw rows alone have already discarded horizontal layout');
  const left = page.rawBlocks.find(block => block.text === leftSignature);
  const right = page.rawBlocks.find(block => block.text === rightSignature);
  assert.ok(left && right, 'Both signatures must survive as separate positioned blocks');
  assert.equal(left.y, right.y);assert.ok(left.x + left.width < right.x);
  for (const block of page.rawBlocks) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(block[key]), key);
});

test('single native ruled form keeps complete context and table row geometry in the model', () => {
  const { page, model } = pageAndModel();
  const table = model.sheets.find(sheet => sheet.kind === 'grid');
  assert.deepEqual(table.rowAnchors, [150, 195, 235, 275]);
  assert.ok(table.pageForm, 'One safe complete page form must not be reduced to a table plus disconnected Raw text');
  assert.equal(table.pageForm.pageWidth, 1000);assert.equal(table.pageForm.pageHeight, 600);
  assert.deepEqual(table.pageForm.beforeBlocks.map(block => block.text), [attachment, title]);
  for (const text of [leftSignature, rightSignature, note, footer]) assert.ok(table.pageForm.afterBlocks.some(block => block.text === text));
  assert.deepEqual(table.rows, page.tables[0].rows, 'Context must not be inserted into semantic table rows');
  assert.deepEqual(table.merges, page.tables[0].merges);
});

test('native multi-line cell text retains its line break rather than becoming one squeezed line', () => {
  const { page } = pageAndModel({ multiline: true });
  assert.equal(page.tables[0].rows[0][2], '家庭人均\n年收入（元）');
});

test('the initially displayed sheet is the complete editable form with context above and below the table', async t => {
  const { model } = pageAndModel();
  const workbook = await workbookFor(t, model), main = mainSheet(workbook, model);
  assert.equal(workbook.worksheets[0].name, main.name, 'A user opening the first sheet must see the form');
  assert.equal(workbook.worksheets[workbook.views[0].activeTab].name, main.name);
  const tag = oneCell(main, attachment), heading = oneCell(main, title), header = oneCell(main, '序号');
  const lastData = oneCell(main, '002'), left = oneCell(main, leftSignature), right = oneCell(main, rightSignature);
  const instruction = oneCell(main, note), pageNumber = oneCell(main, footer);
  assert.ok(tag.row < heading.row && heading.row < header.row);
  assert.ok(header.row < lastData.row && lastData.row < left.row && lastData.row < right.row);
  assert.ok(left.row < instruction.row && right.row < instruction.row && instruction.row < pageNumber.row);
  assert.equal(main.pageSetup.orientation, 'landscape');assert.equal(main.pageSetup.fitToPage, true);
  assert.equal(main.pageSetup.fitToWidth, 1);
  assert.equal(main.pageSetup.fitToHeight, 0, 'Future filled rows must be allowed to grow without shrinking the whole form to one page');
  assert.ok(workbook.getWorksheet('P001-Raw'), 'Raw remains available as an extraction reference');
});

test('same-Y left and right signatures remain separate editable areas on the same main-sheet row', async t => {
  const { model } = pageAndModel();
  const main = mainSheet(await workbookFor(t, model), model);
  const left = oneCell(main, leftSignature), right = oneCell(main, rightSignature);
  assert.equal(left.row, right.row);assert.ok(left.col < right.col);
  assert.notEqual(left.master.address, right.master.address);
  assert.ok(main.getRow(left.row).height >= 18, 'Signature text needs visible row height');
});

test('small baseline differences do not turn visually aligned signatures into different rows', async t => {
  const input = formInput();input.words.find(entry => entry.text === rightSignature).y += 4;
  const model = buildWorkbookModel([detectTablesOnPage(input)]);
  const main = mainSheet(await workbookFor(t, model), model);
  const left = oneCell(main, leftSignature), right = oneCell(main, rightSignature);
  assert.equal(left.row, right.row);assert.ok(left.col < right.col);
  assert.notEqual(left.master.address, right.master.address);
});

test('complete-form layout preserves long numeric strings, literal formula-like text and existing table merges', async t => {
  const { model } = pageAndModel({ merged: true });
  const item = model.sheets.find(sheet => sheet.kind === 'grid');
  assert.ok(item.pageForm, 'This must exercise preserved merges inside the complete-form layout');
  const before = { rows: JSON.parse(JSON.stringify(item.rows)), merges: JSON.parse(JSON.stringify(item.merges)) };
  assert.deepEqual(before.merges, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]);
  const main = mainSheet(await workbookFor(t, model), model);
  for (const text of [identity, '001', '0012.00', '0.00', '=1+1']) assert.equal(oneCell(main, text).type, ExcelJS.ValueType.String);
  const header = oneCell(main, '综合信息');
  assert.equal(main.getCell(header.row, header.col + 1).master.address, header.address);
  const rightHeader = oneCell(main, '家庭收入');assert.ok(rightHeader.col > header.col + 1);
  assert.deepEqual(item.rows, before.rows);assert.deepEqual(item.merges, before.merges);
});

test('a long lower note keeps its content, wrapping and spacing before the original page footer', async t => {
  const input = formInput(), longNote = '这是一段需要完整保留并允许换行的表后说明。'.repeat(5);
  input.words.find(entry => entry.text === note).text = longNote;
  const page = detectTablesOnPage(input), model = buildWorkbookModel([page]);
  const main = mainSheet(await workbookFor(t, model), model);
  const block = oneCell(main, longNote), pageNumber = oneCell(main, footer), signature = oneCell(main, leftSignature);
  assert.ok(signature.row < block.row && block.row < pageNumber.row);
  assert.equal(block.alignment.wrapText, true);assert.ok(block.font.size >= 9);
  assert.ok(main.getRow(block.row).height >= block.font.size * 2 + 4,
    'The note itself needs at least two visible lines; a blank spacer below cannot prevent cell clipping');
  let space = 0;for (let row = block.row; row < pageNumber.row; row++) space += main.getRow(row).height || main.properties.defaultRowHeight;
  assert.ok(space >= 30, 'Long text must have vertical space rather than being clipped into the footer');
});

test('two tables on one page retain separate extraction sheets instead of inventing one form layout', () => {
  const input = formInput();input.height = 900;
  input.words.find(entry => entry.text === leftSignature).y = 590;
  input.words.find(entry => entry.text === rightSignature).y = 590;
  input.words.find(entry => entry.text === note).y = 680;
  input.words.find(entry => entry.text === footer).y = 840;
  for (const y of [400, 445, 490]) input.lines.push({ x1: 50, y1: y, x2: 950, y2: y });
  for (const x of [50, 420, 950]) input.lines.push({ x1: x, y1: 400, x2: x, y2: 490 });
  input.words.push(word('第二表项目', 60, 410, 150), word('第二表数值', 450, 410, 150), word('保留', 60, 455), word('0007', 450, 455));
  const page = detectTablesOnPage(input);assert.equal(page.tables.length, 2);
  const model = buildWorkbookModel([page]);assert.ok(model.sheets.every(sheet => !sheet.pageForm));
  assert.equal(model.sheets.filter(sheet => !sheet.name.endsWith('-Raw')).length, 2);
});

test('multiple pages keep their original extraction boundaries rather than applying single-page form offsets', () => {
  const pages = [1, 2].map(pageNumber => detectTablesOnPage(formInput({ pageNumber })));
  const model = buildWorkbookModel(pages);
  assert.ok(model.sheets.every(sheet => !sheet.pageForm));
  assert.equal(model.sheets.filter(sheet => !sheet.name.endsWith('-Raw')).length, 2);
  for (const pageNumber of [1, 2]) assert.ok(model.sheets.some(sheet => sheet.name === `P00${pageNumber}-Raw`));
});

test('OCR and unknown row geometry remain conservative instead of claiming a reconstructed native form', () => {
  const ocr = detectTablesOnPage(formInput({ source: 'ocr' }));
  assert.ok(buildWorkbookModel([ocr]).sheets.every(sheet => !sheet.pageForm));
  for (const mutate of [page => { delete page.tables[0].rowAnchors; }, page => { page.tables[0].rowAnchors = [150, 250, 200, 275]; }, page => { page.width = 0; }]) {
    const page = detectTablesOnPage(formInput());mutate(page);
    assert.ok(buildWorkbookModel([page]).sheets.every(sheet => !sheet.pageForm));
  }
});

test('side annotations overlapping table height are retained without being moved into a fabricated header or footer', () => {
  const input = formInput();input.words.push(word('侧边注记', 1, 215, 35, 14));
  const page = detectTablesOnPage(input), model = buildWorkbookModel([page]);
  assert.ok(model.sheets.every(sheet => !sheet.pageForm));
  assert.ok(model.sheets.filter(sheet => sheet.name.endsWith('-Raw')).some(sheet => sheet.rows.flat().join(' ').includes('侧边注记')));
});

test('two separate surrounding blocks that cannot fit distinct table columns use the conservative extraction', async t => {
  const input = formInput();
  const left = input.words.find(entry => entry.text === leftSignature), right = input.words.find(entry => entry.text === rightSignature);
  Object.assign(left, { text: '甲签', x: 55, width: 30, height: 12 });
  Object.assign(right, { text: '乙签', x: 145, width: 30, height: 12 });
  const page = detectTablesOnPage(input), model = buildWorkbookModel([page]);
  assert.ok(Array.isArray(page.rawBlocks));
  assert.equal(page.rawBlocks.filter(block => ['甲签', '乙签'].includes(block.text)).length, 2,
    'These are distinct source blocks, both above the first table column');
  const workbook = await workbookFor(t, model), raw = workbook.getWorksheet('P001-Raw');
  const text = actualCells(raw).map(cell => cell.value).join(' ');
  assert.ok(text.includes('甲签') && text.includes('乙签'));
  const main = mainSheet(workbook, model);
  assert.equal(main.getCell('A1').value, '序号', 'Fallback must not leave partial title rows before the original table');
  assert.equal(main.pageSetup.fitToHeight, 0);
  assert.equal(oneCell(main, identity).type, ExcelJS.ValueType.String);
  const warnings = actualCells(workbook.getWorksheet('识别说明')).map(cell => String(cell.value)).join(' ');
  assert.match(warnings, /complex text placement retained in Raw sheet/,
    'The workbook must explain that ambiguous surrounding text could not be placed on the form');
});

test('inconsistent or unbounded page/table geometry never claims a reliable complete form', () => {
  for (const mutate of [
    page => { page.width = Infinity; },
    page => { page.tables[0].bounds.left = -50; },
    page => { page.tables[0].bounds.right += 40; },
    page => { page.tables[0].rowAnchors = [170, 195, 235, 275]; }
  ]) {
    const page = detectTablesOnPage(formInput());mutate(page);
    assert.ok(buildWorkbookModel([page]).sheets.every(sheet => !sheet.pageForm),
      'Page bounds, grid bounds and edge anchors must describe the same finite region');
  }
});

test('ordinary editable form data rows do not serialize fixed heights that clip wrapped values after typing', async t => {
  const { model } = pageAndModel();
  const item = model.sheets.find(sheet => sheet.pageForm);
  const longId = '001234567890123456', longCollege = '示例先进纺织科学与应用工程学院材料工程专业';
  item.rows[1][1] = longId;item.rows[1][3] = longCollege;
  item.rows[2][1] = '';
  const { workbook, mainSheetXml } = await workbookFor(t, model, { includeMainSheetXml: true });
  const main = mainSheet(workbook, model), header = oneCell(main, '序号');
  assert.equal(workbook.worksheets[0].name, main.name);
  for (const text of [longId, longCollege, '0012.00']) assert.equal(oneCell(main, text).type, ExcelJS.ValueType.String);
  for (const rowNumber of [header.row + 1, header.row + 2]) {
    assert.doesNotMatch(rowXml(mainSheetXml, rowNumber), /\b(?:ht|customHeight)=/,
      'An editable ordinary row must let Excel grow it when a user enters wrapped text');
    assert.equal(main.getRow(rowNumber).height, undefined);
    for (let column = 1; column <= 4; column++) assert.equal(main.getCell(rowNumber, column).alignment.wrapText, true);
  }
  assert.ok(main.properties.defaultRowHeight >= 25 && main.properties.defaultRowHeight <= 40,
    'The original 40-unit data rows must retain a sensible default height even though individual rows are automatic');
  assert.equal(main.pageSetup.fitToWidth, 1);assert.equal(main.pageSetup.fitToHeight, 0);
});

test('identifier columns protect future typed leading zeros and long digits while monetary columns remain numeric-capable', async t => {
  const { model } = pageAndModel();
  const item = model.sheets.find(sheet => sheet.pageForm);
  item.rows = [
    ['学号', '身份证号', '编号', '家庭收入（元）'],
    ['000000120001', '001234567890123456', '000012', '0012.00'],
    ['', '', '', '0.00']
  ];
  const main = mainSheet(await workbookFor(t, model), model), header = oneCell(main, '学号');
  for (let row = header.row + 1; row <= header.row + 2; row++) {
    for (let column = 1; column <= 3; column++) assert.equal(main.getCell(row, column).numFmt, '@',
      'Both populated and empty identifier cells need text format before the user types');
    assert.notEqual(main.getCell(row, 4).numFmt, '@', 'An income amount must not inherit the identifier text format');
  }
  for (const text of item.rows[1]) assert.equal(oneCell(main, text).type, ExcelJS.ValueType.String);
});

test('automatic ordinary rows leave headers merged data rows and long surrounding paragraphs explicitly sized', async t => {
  const { model } = pageAndModel({ merged: true });
  const item = model.sheets.find(sheet => sheet.pageForm);
  item.rows[2][0] = '';
  item.rows[1][2] = '跨列说明';item.rows[1][3] = '';
  item.merges.push({ startRow: 1, endRow: 2, startCol: 0, endCol: 0 },
    { startRow: 1, endRow: 1, startCol: 2, endCol: 3 });
  const longNote = '填写后的长说明仍应完整显示，不可依赖自动调整合并单元格。'.repeat(5);
  item.pageForm.afterBlocks.find(block => block.text === note).text = longNote;
  const { workbook, mainSheetXml } = await workbookFor(t, model, { includeMainSheetXml: true });
  const main = mainSheet(workbook, model), header = oneCell(main, '综合信息');
  const paragraph = oneCell(main, longNote), heading = oneCell(main, title), signature = oneCell(main, leftSignature);
  for (const row of [header.row, header.row + 1, header.row + 2, heading.row, signature.row, paragraph.row]) {
    assert.match(rowXml(mainSheetXml, row), /\bht="[0-9.]+"/);
    assert.match(rowXml(mainSheetXml, row), /\bcustomHeight="1"/);
    assert.ok(main.getRow(row).height >= 14);
  }
  assert.equal(main.getCell(header.row + 2, 1).master.address, main.getCell(header.row + 1, 1).address);
  assert.equal(main.getCell(header.row + 1, 4).master.address, main.getCell(header.row + 1, 3).address);
  assert.ok(main.getRow(paragraph.row).height >= paragraph.font.size * 2 + 4);
  assert.equal(main.getCell(header.row + 1, 3).value, '跨列说明');
});
