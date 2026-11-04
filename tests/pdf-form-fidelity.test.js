'use strict';

// Public seam: positioned native form model -> saved, editable OOXML workbook.
// The optional root permits read-only RED checks against the frozen R3 writer.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const yauzl = require('yauzl');
const sourceRoot = process.env.FLYINGMOUSE_FIDELITY_SOURCE_ROOT || path.resolve(__dirname, '..');
const { writePdfTableWorkbook } = require(path.join(sourceRoot, 'pdf-table'));
const savedXmlBySheet = new WeakMap();

const title = '材料样品入库核验登记表';
const attachment = '记录丙：';
const leftSign = '保管员签署：';
const rightSign = '复核员签署：';
const note = '核验后保留电子记录。';
const longId = '001234567890123456';
const style = (fontFamily, fontSizePt, bold = false, italic = false) =>
  ({ fontName: fontFamily, fontFamily, fontSizePt, bold, italic });

function fixture({ landscape = false, pointScale = 0.5, left = 72, firstTop = 54, tableTop = 150,
  pageWidthPt: explicitWidth, pageHeightPt: explicitHeight } = {}) {
  // All expected physical dimensions are independent, hand-selected PDF points.
  // A 2x PDF.js viewport must not turn an 11-point font into 5.5 or 22 points.
  const pageWidthPt = explicitWidth ?? (landscape ? 841.89 : 595.28);
  const pageHeightPt = explicitHeight ?? (landscape ? 595.28 : 841.89);
  const pt = value => value / pointScale;
  const widthsPt = [48, 120, 108, 156];
  const edgesPt = [left, left + 48, left + 168, left + 276, left + 432];
  const ysPt = [tableTop, tableTop + 28, tableTop + 52, tableTop + 76];
  const rows = [
    ['序号', '证件号', '材料名称', '家庭收入（元）'],
    ['1', longId, '天然纤维', 1250.5],
    ['2', '000000000000000007', '再生材料', 0]
  ];
  const cellStyles = rows.map((row, r) => row.map((text, c) => {
    const font = r === 0 ? style('FangSong', 11)
      : c === 3 ? style('Arial', 10.5) : style('SimSun', 10.5, false, c === 2);
    const bbox = { x: pt(edgesPt[c] + 5), y: pt(ysPt[r] + 6),
      width: pt(Math.min(widthsPt[c] - 10, String(text).length * font.fontSizePt * 0.55)), height: pt(font.fontSizePt) };
    return { style: font, horizontal: c === 3 && r > 0 ? 'right' : 'center', bbox,
      runs: [{ text: String(text), ...bbox, style: { ...font } }] };
  }));
  function block(text, x, y, width, height, font) {
    const box = { x: pt(x), y: pt(y), width: pt(width), height: pt(height) };
    return { text, ...box, style: font, runs: [{ text, ...box, style: { ...font } }] };
  }
  const beforeBlocks = [
    block(attachment, left, firstTop, 72, 14, style('FangSong', 14)),
    block(title, left + 108, tableTop - 50, 216, 18, style('SimSun', 18, false, true))
  ];
  const afterBlocks = [
    block(leftSign, left + 18, tableTop + 96, 110, 12, style('KaiTi', 12)),
    block(rightSign, left + 294, tableTop + 96, 120, 12, style('KaiTi', 12)),
    block(note, left, tableTop + 136, 216, 11, style('FangSong', 11)),
    block('—23—', left, pageHeightPt - 55, 42, 10, style('Times New Roman', 10))
  ];
  const pageWidth = pt(pageWidthPt), pageHeight = pt(pageHeightPt);
  const item = { name: 'P001-T01', source: 'text', kind: 'grid', pages: [1], rows,
    merges: [], cellConfidence: [], cellStyles, pageWidth, pageHeight, pagePointScale: pointScale,
    columnAnchors: edgesPt.map(pt), rowAnchors: ysPt.map(pt),
    bounds: { left: pt(left), top: pt(tableTop), right: pt(left + 432), bottom: pt(tableTop + 76) },
    pageForm: { pageWidth, pageHeight, pagePointScale: pointScale, beforeBlocks, afterBlocks } };
  return { model: { summary: [], warnings: [], sheets: [item,
    { name: 'P001-Raw', rows: [...beforeBlocks, ...afterBlocks].map(b => [b.text]), pages: [1] }] }, item,
    expected: { pageWidthPt, pageHeightPt, left, firstTop, tableTop, widthsPt, right: left + 432 } };
}

function cellText(cell) {
  if (cell.value && typeof cell.value === 'object' && Array.isArray(cell.value.richText))
    return cell.value.richText.map(run => run.text).join('');
  return String(cell.value ?? '');
}

function effectiveFonts(cell) {
  const runs = cell.value?.richText;
  const fonts = Array.isArray(runs) ? runs.filter(run => run.text).map(run => ({ ...cell.font, ...run.font })) : [cell.font];
  const saved = savedXmlBySheet.get(cell.worksheet);
  assert.ok(saved, 'Read font sizes from the written package, not the lossy integer reader');
  const cellXml = saved.sheet.match(new RegExp(`<c\\b[^>]*\\br="${cell.address}"[^>]*>([\\s\\S]*?)<\\/c>`))?.[0];
  assert.ok(cellXml, `${cell.address} must exist in the saved worksheet`);
  const styleId = Number(cellXml.match(/\bs="(\d+)"/)?.[1] || 0);
  const cellXfs = saved.styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1];
  const xf = [...(cellXfs || '').matchAll(/<xf\b[^>]*>/g)][styleId]?.[0];
  assert.ok(xf, 'The saved cell style exists');
  const fontId = Number(xf.match(/\bfontId="(\d+)"/)?.[1] || 0);
  const fontsXml = saved.styles.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1];
  const fontXml = [...(fontsXml || '').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)][fontId]?.[1];
  const size = Number(fontXml?.match(/<sz\b[^>]*\bval="([0-9.]+)"/)?.[1]);
  assert.ok(Number.isFinite(size), 'The source cell font has a numeric OOXML point size');
  if (!Array.isArray(runs)) return [{ ...fonts[0], size }];
  const sharedIndex = Number(cellXml.match(/<v>(\d+)<\/v>/)?.[1]);
  const sharedXml = [...saved.shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)][sharedIndex]?.[1];
  const runXmls = [...(sharedXml || '').matchAll(/<r\b[^>]*>([\s\S]*?)<\/r>/g)];
  assert.equal(runXmls.length, fonts.length, 'Rich font runs remain represented in the saved shared string');
  return fonts.map((font, index) => {
    const explicitSize = runXmls[index][1].match(/<sz\b[^>]*\bval="([0-9.]+)"/)?.[1];
    return { ...font, size: explicitSize === undefined ? size : Number(explicitSize) };
  });
}

function oneCell(sheet, text) {
  const found = [];
  sheet.eachRow(row => row.eachCell(cell => {
    if ((!cell.isMerged || cell.master === cell) && cellText(cell) === String(text)) found.push(cell);
  }));
  assert.equal(found.length, 1, `Retain exactly one editable main-sheet cell for ${JSON.stringify(text)}`);
  return found[0];
}

function close(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: actual ${actual}, expected ${expected} +/- ${tolerance} PDF points`);
}

// ISO/IEC 29500 col/@width ALREADY includes padding; do not add five pixels again.
// Microsoft Learn, DocumentFormat.OpenXml.Spreadsheet.Column, width remarks:
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.column
// The primary source's Calibri example is XML 8.7109375 -> 61 pixels at MDW=7.
// This product uses explicit 仿宋 12: MDW=8 at 96 dpi and 12 at 144 dpi,
// as verified by the final native A4 comparison. The character width is 6pt;
// Courier New 10 had the same width but compressed the printed row geometry.
// No major/minor font scheme may silently replace this metrics anchor.
function columnPoints(sheet, column) {
  // A serialized sheet default is also an explicit OOXML width. Do not guess
  // an application's implicit default when neither value is present.
  const width = sheet.getColumn(column).width ?? sheet.properties.defaultColWidth;
  assert.ok(Number.isFinite(width) && width > 0, `Column ${column} has an explicit usable width or sheet default`);
  return Math.trunc(((256 * width + Math.trunc(128 / 8)) / 256) * 8) * 0.75;
}

function rowPoints(sheet, row) {
  return sheet.getRow(row).height ?? sheet.properties.defaultRowHeight ?? 15;
}

function cellLeft(sheet, cell) {
  let x = (sheet.pageSetup.margins?.left || 0) * 72;
  for (let c = 1; c < cell.col; c++) x += columnPoints(sheet, c);
  return x;
}

function rowTop(sheet, row) {
  let y = (sheet.pageSetup.margins?.top || 0) * 72;
  for (let r = 1; r < row; r++) y += rowPoints(sheet, r);
  return y;
}

async function xmlFromFile(file, entryName) {
  const bytes = await fs.readFile(file);
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let value;
    zip.on('error', reject);
    zip.on('end', () => value === undefined ? reject(new Error(`Missing ${entryName}`)) : resolve(value));
    zip.on('entry', entry => {
      if (entry.fileName !== entryName) return zip.readEntry();
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) { zip.close(); return reject(streamError); }
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { value = Buffer.concat(chunks).toString('utf8'); zip.readEntry(); });
      });
    });
    zip.readEntry();
  }));
}

async function saveAndRead(t, model) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-native-fidelity-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fm-native-fidelity-'));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'editable.xlsx');
  await writePdfTableWorkbook(model, file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('P001-T01');
  const xml = await xmlFromFile(file, 'xl/worksheets/sheet1.xml');
  const stylesXml = await xmlFromFile(file, 'xl/styles.xml');
  const shared = await xmlFromFile(file, 'xl/sharedStrings.xml');
  savedXmlBySheet.set(sheet, { sheet: xml, styles: stylesXml, shared });
  return { workbook, sheet, xml, stylesXml };
}

test('native physical column widths use explicit FangSong 12 Normal metrics independent of theme locale', async t => {
  const { stylesXml } = await saveAndRead(t, fixture().model);
  const normalTag = [...stylesXml.matchAll(/<cellStyle\b[^>]*\/?\s*>/g)]
    .map(match => match[0]).find(tag => /\bbuiltinId="0"/.test(tag));
  assert.ok(normalTag, 'The workbook exposes the Normal base style');
  const xfId = Number(normalTag.match(/\bxfId="(\d+)"/)?.[1]);
  const styleXfs = stylesXml.match(/<cellStyleXfs\b[^>]*>([\s\S]*?)<\/cellStyleXfs>/)?.[1];
  const baseXf = [...(styleXfs || '').matchAll(/<xf\b[^>]*>/g)][xfId]?.[0];
  assert.ok(baseXf, 'Normal resolves to a base formatting record');
  const fontId = Number(baseXf.match(/\bfontId="(\d+)"/)?.[1]);
  const fonts = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1];
  const font = [...(fonts || '').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)][fontId]?.[1];
  assert.ok(font, 'Normal resolves to a concrete font');
  assert.match(font, /<name\b[^>]*\bval="仿宋"/);
  assert.match(font, /<sz\b[^>]*\bval="12(?:\.0+)?"/);
  assert.doesNotMatch(font, /<scheme\b/, 'A minor/major theme scheme can silently change CJK-locale column metrics');
});

test('native form cells preserve source font family and physical point size at a doubled viewport', async t => {
  const { model } = fixture();
  const { sheet } = await saveAndRead(t, model);
  for (const [text, name, size, italic] of [['证件号', 'FangSong', 11, false],
    [longId, 'SimSun', 10.5, false], ['天然纤维', 'SimSun', 10.5, true], [1250.5, 'Arial', 10.5, false]]) {
    const cell = oneCell(sheet, text);
    for (const font of effectiveFonts(cell)) {
      assert.equal(font.name, name, `Source font for ${text}`);
      close(font.size, size, 0.1, `Source font size for ${text}`);
      assert.equal(Boolean(font.italic), italic);
    }
  }
});

test('native source headers stay unfilled and preserve explicit regular weight rather than a report theme', async t => {
  const { sheet } = await saveAndRead(t, fixture().model);
  for (const text of ['序号', '证件号', '材料名称', '家庭收入（元）']) {
    const cell = oneCell(sheet, text);
    for (const font of effectiveFonts(cell)) assert.equal(Boolean(font.bold), false, 'The source header explicitly has regular weight');
    assert.ok(!cell.fill || cell.fill.pattern === 'none' || (cell.fill.pattern === 'solid'
      && ['FFFFFFFF', 'FFFFFF'].includes(cell.fill.fgColor?.argb)), 'A white source header cannot gain a gray fill');
  }
});

test('native body alignment follows source centers and right-aligned amounts', async t => {
  const { sheet } = await saveAndRead(t, fixture().model);
  for (const text of ['1', longId, '天然纤维']) assert.equal(oneCell(sheet, text).alignment.horizontal, 'center');
  assert.equal(oneCell(sheet, 1250.5).alignment.horizontal, 'right');
});

test('native title signatures and notes preserve their own fonts without guessed bold or scaled sizes', async t => {
  const { sheet } = await saveAndRead(t, fixture().model);
  for (const [text, name, size, italic] of [[attachment, 'FangSong', 14, false],
    [title, 'SimSun', 18, true], [leftSign, 'KaiTi', 12, false], [rightSign, 'KaiTi', 12, false],
    [note, 'FangSong', 11, false], ['—23—', 'Times New Roman', 10, false]]) {
    const cell = oneCell(sheet, text);
    for (const font of effectiveFonts(cell)) {
      assert.equal(font.name, name);
      close(font.size, size, 0.1, `${text} point size`);
      assert.equal(Boolean(font.bold), false);
      assert.equal(Boolean(font.italic), italic);
    }
  }
});

for (const options of [{ landscape: false, pointScale: 0.5, left: 72, firstTop: 54, tableTop: 150 },
  { landscape: true, pointScale: 1.25, left: 42, firstTop: 31, tableTop: 127 }]) {
  const orientation = options.landscape ? 'landscape' : 'portrait';
  test(`native ${orientation} form uses physical PDF column widths without fixed page-width rescaling`, async t => {
    const { model, expected } = fixture(options);
    const { sheet } = await saveAndRead(t, model);
    const headers = ['序号', '证件号', '材料名称', '家庭收入（元）'].map(text => oneCell(sheet, text));
    let totalWidth = 0;
    headers.forEach((cell, index) => {
      const next = headers[index + 1]?.col ?? cell.col + 1;
      let width = 0;
      for (let c = cell.col; c < next; c++) width += columnPoints(sheet, c);
      close(width, expected.widthsPt[index], 1.5, `Source column ${index + 1} width`);
      totalWidth += width;
    });
    close(totalWidth, 432, 2, 'Total physical table width');
    assert.ok(sheet.columnCount <= 12, 'A four-field form must not turn into a huge microgrid');
    assert.equal(sheet.pageSetup.orientation, orientation);
    assert.equal(sheet.pageSetup.scale, 100, 'Source geometry must not be silently rescaled when printed');
    assert.equal(sheet.pageSetup.fitToPage, false, 'Fit-to-page must not override the physical dimensions');
    // RightMargin limits the printable area; it does not position the table.
    // Its safety reserve may be smaller than the blank source region without
    // changing either the actual table edge or the physical right whitespace.
    const actualRight = cellLeft(sheet, headers[0]) + totalWidth;
    close(expected.pageWidthPt - actualRight, expected.pageWidthPt - expected.right, 1,
      'Original physical whitespace beyond the table right edge');
    assert.ok(actualRight <= expected.pageWidthPt - sheet.pageSetup.margins.right * 72 + 0.75,
      'The printable area must include the complete table width');
  });

  test(`native ${orientation} form preserves source margins top whitespace and table row heights`, async t => {
    const { model, expected } = fixture(options);
    const { sheet } = await saveAndRead(t, model);
    const first = oneCell(sheet, attachment), header = oneCell(sheet, '序号');
    close(cellLeft(sheet, header), expected.left, 1.5, 'Original table left position including any small gutter');
    close(rowTop(sheet, first.row), expected.firstTop, 1, 'Original first text top whitespace');
    close(rowTop(sheet, header.row), expected.tableTop, 2, 'Original table top after positioned title and gaps');
    close(rowPoints(sheet, header.row), 28, 1, 'Source header row height');
    close(rowPoints(sheet, header.row + 1), 24, 1, 'Source first data row default height');
    close(rowPoints(sheet, header.row + 2), 24, 1, 'Source second data row default height');
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 0, 'Later filled rows can grow without forcing the form into a microscopic page');
  });
}

test('precision styling keeps editable automatic rows exact text identifiers and numeric-capable income cells', async t => {
  const { model } = fixture();
  const { workbook, sheet, xml } = await saveAndRead(t, model);
  const idHeader = oneCell(sheet, '证件号'), income = oneCell(sheet, '家庭收入（元）');
  assert.equal(workbook.worksheets[0].name, sheet.name);
  assert.equal(oneCell(sheet, longId).type, ExcelJS.ValueType.String);
  for (const r of [idHeader.row + 1, idHeader.row + 2]) {
    const tag = [...xml.matchAll(/<row\b[^>]*>/g)].find(match => new RegExp(`\\br="${r}"(?:\\s|>)`).test(match[0]))?.[0];
    assert.ok(tag, `Row ${r} must be serialized`);
    assert.doesNotMatch(tag, /\b(?:ht|customHeight)=/, 'An ordinary editable row must retain automatic growth');
    assert.equal(sheet.getCell(r, idHeader.col).numFmt, '@');
    assert.equal(sheet.getCell(r, idHeader.col).alignment.wrapText, true);
    assert.notEqual(sheet.getCell(r, income.col).numFmt, '@');
  }
  assert.equal(oneCell(sheet, 1250.5).type, ExcelJS.ValueType.Number);
  assert.equal(sheet.getCell(income.row + 2, income.col).value, 0);
  const left = oneCell(sheet, leftSign), right = oneCell(sheet, rightSign);
  assert.equal(left.row, right.row);
  assert.ok(right.col > left.col);
  assert.notEqual(left.master.address, right.master.address);
  assert.ok(left.row > income.row + 2);
});

test('native mixed-font context preserves editable rich-text runs and their point sizes', async t => {
  const { model, item } = fixture();
  const block = item.pageForm.beforeBlocks[1];
  const firstText = title.slice(0, 4), secondText = title.slice(4);
  block.style = undefined;
  block.runs = [
    { text: firstText, x: block.x, y: block.y, width: 120, height: block.height,
      style: style('FangSong', 18, false, true) },
    { text: secondText, x: block.x + 120, y: block.y, width: block.width - 120, height: block.height,
      style: style('Arial', 16, true, false) }
  ];
  const { sheet } = await saveAndRead(t, model);
  const cell = oneCell(sheet, title);
  assert.ok(Array.isArray(cell.value?.richText), 'Mixed PDF runs require editable rich text instead of one guessed font');
  assert.equal(cell.value.richText.map(run => run.text).join(''), title);
  const fonts = effectiveFonts(cell);
  assert.equal(fonts[0].name, 'FangSong');
  close(fonts[0].size, 18, 0.1, 'First mixed-run size');
  assert.equal(Boolean(fonts[0].italic), true);
  assert.equal(fonts[1].name, 'Arial');
  close(fonts[1].size, 16, 0.1, 'Second mixed-run size');
  assert.equal(Boolean(fonts[1].bold), true);
});

// Added after the paper/gap fixes were implemented. These are current behavioral
// regressions, not claimed RED evidence against an unavailable pre-fix snapshot.
for (const paper of [
  { name: 'Letter', code: 1, width: 612, height: 792 },
  { name: 'Legal', code: 5, width: 612, height: 1008 },
  { name: 'A3', code: 8, width: 841.89, height: 1190.55 }
]) for (const landscape of [false, true]) {
  test(`native ${paper.name} ${landscape ? 'landscape' : 'portrait'} source keeps its actual paper size`, async t => {
    const { model, expected } = fixture({ landscape,
      pageWidthPt: landscape ? paper.height : paper.width,
      pageHeightPt: landscape ? paper.width : paper.height });
    const { sheet, xml } = await saveAndRead(t, model);
    assert.equal(sheet.pageSetup.paperSize, paper.code, 'The writer must not silently substitute A4');
    assert.equal(sheet.pageSetup.orientation, landscape ? 'landscape' : 'portrait');
    assert.match(xml, new RegExp(`<pageSetup\\b[^>]*\\bpaperSize="${paper.code}"`));
    const header = oneCell(sheet, '序号');
    close(cellLeft(sheet, header), expected.left, 1.5, 'Source paper table left');
    close(rowTop(sheet, header.row), expected.tableTop, 2, 'Source paper table top');
    close(columnPoints(sheet, oneCell(sheet, '证件号').col), 120, 1.5, 'Source paper identity-column width');
  });
}

test('a blank region taller than one Excel row preserves the following table top on A3', async t => {
  const { model } = fixture({ pageWidthPt: 841.89, pageHeightPt: 1190.55,
    firstTop: 40, tableTop: 800, pointScale: 0.5 });
  const { sheet } = await saveAndRead(t, model);
  const attachmentCell = oneCell(sheet, attachment), heading = oneCell(sheet, title), header = oneCell(sheet, '序号');
  close(rowTop(sheet, attachmentCell.row), 40, 1, 'Top attachment stays at its original position');
  close(rowTop(sheet, heading.row), 750, 2, 'Title following more than 409pt of whitespace');
  close(rowTop(sheet, header.row), 800, 2, 'Table following more than 409pt of whitespace');
  let blankPoints = 0;
  for (let row = attachmentCell.row + 1; row < heading.row; row++) {
    const height = rowPoints(sheet, row);
    assert.ok(height > 0 && height <= 409, 'Each written spacer row respects Excel row-height limits');
    blankPoints += height;
  }
  assert.ok(blankPoints > 409, 'The source whitespace is preserved instead of being capped to one row');
  assert.ok(sheet.rowCount < 50, 'A large gap uses a few valid rows, not an enormous microgrid');
});

test('a long blank region below the form does not pull its source footer upward', async t => {
  const { model } = fixture();
  const { sheet } = await saveAndRead(t, model);
  const submission = oneCell(sheet, note), footer = oneCell(sheet, '—23—');
  close(rowTop(sheet, submission.row), 286, 2, 'Original submission-note top');
  close(rowTop(sheet, footer.row), 786.89, 2, 'Original footer top after a large blank region');
  let blankPoints = 0;
  for (let row = submission.row + 1; row < footer.row; row++) {
    const height = rowPoints(sheet, row);
    assert.ok(height > 0 && height <= 409);
    blankPoints += height;
  }
  assert.ok(blankPoints > 409, 'The footer gap must not be collapsed');
});

// The native GUI gate permits a bounded local width tradeoff so that an
// existing header line does not clip. This does not relax the physical
// tolerances of forms that need no such adjustment above.
test('header padding never borrows more than eight points cumulatively from one adjacent column', async t => {
  for (const pointScale of [0.5, 1.25]) {
    const { model, item, expected } = fixture({ pointScale });
    // Columns 1 and 3 each need six points. Column 2 is their only roomy
    // neighbor; without a cumulative limit it would lose twelve points.
    const glyphWidths = [45.75, 5, 105.75, 147.75];
    item.cellStyles[0].forEach((source, index) => {
      const bbox = { ...source.bbox, x: item.columnAnchors[index] + 1 / pointScale,
        width: glyphWidths[index] / pointScale };
      source.bbox = bbox;
      source.runs = [{ ...source.runs[0], ...bbox }];
    });
    const { sheet } = await saveAndRead(t, model);
    const headers = item.rows[0].map(text => oneCell(sheet, text));
    const widths = headers.map(cell => columnPoints(sheet, cell.col));
    assert.ok(widths[0] > expected.widthsPt[0] + 4, 'Exercise actual borrowing, not an untouched form');
    for (let column = 0; column < widths.length; column++) {
      assert.ok(Math.abs(widths[column] - expected.widthsPt[column]) <= 8 + 0.75,
        `Column ${column + 1} respects the eight-point cumulative limit plus one display pixel`);
    }
    assert.ok(expected.widthsPt[1] - widths[1] <= 8 + 0.75,
      'A shared donor must not lose six points to each of two neighbors');
    close(widths.reduce((sum, width) => sum + width, 0), 432, 2, 'Borrowing keeps the original outer table width');
    close(cellLeft(sheet, headers[0]), expected.left, 1.5, 'Borrowing keeps the original left edge');
    assert.equal(cellText(oneCell(sheet, longId)), longId, 'The layout tradeoff does not change editable identifiers');
  }
});

test('large source layout gaps preserve the original space font instead of forcing a small Times New Roman space', async t => {
  for (const pointScale of [0.5, 1.25]) {
    const { model, item } = fixture({ pointScale });
    const block = item.pageForm.beforeBlocks[1], font = style('SimSun', 12);
    block.text = 'A B';
    block.width = 32 / pointScale;
    block.height = 12 / pointScale;
    block.style = font;
    block.runs = [
      { text: 'A', x: block.x, y: block.y, width: 6 / pointScale,
        height: 12 / pointScale, style: { ...font } },
      { text: ' B', x: block.x + 26 / pointScale, y: block.y, width: 6 / pointScale,
        height: 12 / pointScale, style: { ...font } }
    ];
    const { sheet } = await saveAndRead(t, model);
    const cell = oneCell(sheet, 'A B');
    assert.equal(cellText(cell), 'A B', 'The exact editable text survives the conservative gap fallback');
    for (const writtenFont of effectiveFonts(cell)) {
      assert.equal(writtenFont.name, 'SimSun', 'A large unsupported gap must not switch its space to a smaller-metric face');
      close(writtenFont.size, 12, 0.1, 'Unsupported gap fallback keeps the source font size');
    }
    // This deliberately does not claim that the 20-point gap is geometrically
    // reconstructed. That needs a different representation and a visual gate.
  }
});
