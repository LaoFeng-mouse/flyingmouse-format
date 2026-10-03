const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { missingPdfText, convertPdfToDocx, fillMissingPdfPageText, writeDocxZip, xmlDocxParagraph, validateNativePdfDocx, repairNativePdfDocxXml } = require('../pdf');

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-pdf-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function inputPdf(filename, image) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText('Editable source text', { font: await pdf.embedFont(StandardFonts.Helvetica), x: 30, y: 800, size: 12 });
  if (image) page.drawImage(await pdf.embedPng(image.bytes), { x: 100, y: 700, width: image.size, height: image.size });
  await fs.writeFile(filename, await pdf.save());
}

async function nativeDocx(filename, text) {
  await writeDocxZip(filename, [
    { path: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { path: '_rels/.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { path: 'word/document.xml', content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlDocxParagraph(text)}</w:body></w:document>` }
  ]);
}

test('native coverage accepts multiline neighboring cells without requiring interleaved row concatenation', () => {
  const pages = [{ pageNumber: 1, rows: [['HouseholdCurrent'], ['income Year']], lines: [
    { items: [{text:'Household',x:0,end:50,height:10}, {text:'Current',x:70,end:115,height:10}] },
    { items: [{text:'income',x:0,end:40,height:10}, {text:'Year',x:70,end:95,height:10}] }
  ] }];
  assert.deepEqual(missingPdfText(pages, 'Household income Current Year'), []);
  assert.ok(missingPdfText(pages, 'Household income Current').some(item => item.text.includes('Year')));
});

test('coverage still detects missing letters in an adjacent per-glyph text run', () => {
  const text = 'HORIZONTAL';
  const pages = [{pageNumber:1,rows:[[text]],lines:[{items:[...text].map((text,i)=>({text,x:i*10,end:(i+1)*10,height:10}))}]}];
  assert.equal(missingPdfText(pages, 'HORIZONTAL').length, 0);
  assert.ok(missingPdfText(pages, 'HORZONTAL').length > 0);
});

test('coverage retains widely spaced single-character Chinese title segments', () => {
  const text = '学生认定';
  const pages = [{pageNumber:1,rows:[[text]],lines:[{items:[...text].map((text,i)=>({text,x:i*24,end:i*24+10,height:10}))}]}];
  assert.equal(missingPdfText(pages, '学生认定').length, 0);
  assert.deepEqual(missingPdfText(pages, 'Other body text').map(item=>item.text), [...text]);
  assert.deepEqual(missingPdfText(pages, '学生定').map(item=>item.text), ['认']);
});

const footerPage = (pageNumber=1, number='37') => ({pageNumber,height:600,rows:[['Body '+number],['—'+number+'—']],lines:[
  {y:100,text:'Body '+number,items:[{text:'Body '+number,x:30,end:90,height:10}]},
  {y:560,text:'—'+number+'—',items:[{text:'—'+number+'—',x:30,end:60,height:10}]}
]});
const wordXml = body => '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>';

test('a body number cannot conceal the same omitted geometric page footer', () => {
  assert.ok(missingPdfText([footerPage()], 'Body 37 — —').some(item=>item.text==='—37—'));
  assert.equal(missingPdfText([footerPage()], 'Body 37 — 37 —').length,0);
  assert.equal(missingPdfText([footerPage(1),footerPage(2)], 'Body 37 Body 37 —37—').filter(item=>item.text==='—37—').length,1);
});

test('native layout repair restores only a uniquely matched geometric footer and preserves paragraph formatting', () => {
  const xml=wordXml(xmlDocxParagraph('Body 37')+'<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>—</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>—</w:t></w:r></w:p>');
  const repaired=repairNativePdfDocxXml(xml,[footerPage()]);
  assert.match(repaired,/<w:t[^>]*>—37—<\/w:t>/);assert.match(repaired,/<w:jc w:val="left"\/>/);assert.match(repaired,/<w:sz w:val="24"\/>/);assert.match(repaired,/Body 37/);
  assert.equal(repairNativePdfDocxXml(repaired,[footerPage()]),repaired);
});

test('ambiguous or table-contained separator paragraphs are not guessed to be footers', () => {
  const ambiguous=wordXml(xmlDocxParagraph('Body 37')+xmlDocxParagraph('——')+xmlDocxParagraph('——'));
  assert.equal(repairNativePdfDocxXml(ambiguous,[footerPage()]),ambiguous);
  const table=wordXml(xmlDocxParagraph('Body 37')+'<w:tbl><w:tr><w:tc>'+xmlDocxParagraph('——')+'</w:tc></w:tr></w:tbl>');
  assert.equal(repairNativePdfDocxXml(table,[footerPage()]),table);
  const bodyPage={...footerPage(),lines:footerPage().lines.map(line=>({...line,y:100}))};
  const body=wordXml(xmlDocxParagraph('Body 37')+xmlDocxParagraph('——'));
  assert.equal(repairNativePdfDocxXml(body,[bodyPage]),body);
  const multiple=wordXml(xmlDocxParagraph('——')+xmlDocxParagraph('——'));
  assert.equal(repairNativePdfDocxXml(multiple,[footerPage(1),footerPage(2)]),multiple);
  const earlier=wordXml(xmlDocxParagraph('——')+xmlDocxParagraph('Final body text 37'));
  assert.equal(repairNativePdfDocxXml(earlier,[footerPage()]),earlier);
});

test('later hyperlink content and nested drawing paragraphs cannot be mistaken for the final body footer', () => {
 const later=wordXml(xmlDocxParagraph('Body 37')+xmlDocxParagraph('——')+'<w:p><w:hyperlink><w:r><w:t>Later body link</w:t></w:r></w:hyperlink></w:p>');
 assert.equal(repairNativePdfDocxXml(later,[footerPage()]),later);
 const nested=wordXml(xmlDocxParagraph('Body 37')+'<w:p><w:r><w:drawing><w:txbxContent>'+xmlDocxParagraph('——')+'</w:txbxContent></w:drawing></w:r></w:p>');
 assert.equal(repairNativePdfDocxXml(nested,[footerPage()]),nested);
});

test('footer restoration escapes source XML characters', () => {
  const page=footerPage();page.lines[1].text='&37&';
  const repaired=repairNativePdfDocxXml(wordXml(xmlDocxParagraph('Body 37')+xmlDocxParagraph('&&')),[page]);
  assert.match(repaired,/&amp;37&amp;/);assert.doesNotMatch(repaired,/>\s*&37&/);
});

function tableXml(widths, rowWidths=widths, merged=false) {
 const row=values=>'<w:tr><w:trPr><w:trHeight w:val="200" w:hRule="exact"/></w:trPr>'+values.map((width,index)=>'<w:tc><w:tcPr><w:tcW w:w="'+width+'" w:type="dxa"/>'+(merged&&index===0?'<w:gridSpan w:val="2"/>':'')+'</w:tcPr>'+xmlDocxParagraph('Cell')+'</w:tc>').join('')+'</w:tr>';
 return wordXml('<w:tbl><w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>'+widths.map(()=>'<w:gridCol w:w="1000"/>').join('')+'</w:tblGrid>'+row(widths)+row(rowWidths)+'</w:tbl>');
}

test('native table repair reconciles a contradictory fixed grid to unanimous cell widths and prevents clipping', () => {
 const repaired=repairNativePdfDocxXml(tableXml([600,1400]),[]);
 assert.match(repaired,/<w:tblGrid><w:gridCol w:w="600"\/><w:gridCol w:w="1400"\/><\/w:tblGrid>/);
 assert.equal((repaired.match(/w:hRule="atLeast"/g)||[]).length,2);assert.doesNotMatch(repaired,/w:hRule="exact"/);
 assert.equal(repairNativePdfDocxXml(repaired,[]),repaired);
});

test('ambiguous, merged or different-total column widths keep their original grid', () => {
 for(const xml of [tableXml([600,1400],[700,1300]),tableXml([600,1400],undefined,true),tableXml([600,1600])]) {
  const repaired=repairNativePdfDocxXml(xml,[]);
  assert.match(repaired,/<w:tblGrid><w:gridCol w:w="1000"\/><w:gridCol w:w="1000"\/><\/w:tblGrid>/);
 }
});

test('only automatic table widths tolerate a small grid rounding discrepancy', () => {
 const auto=xml=>xml.replace('<w:tblPr>','<w:tblPr><w:tblW w:type="auto" w:w="0"/>');
 assert.match(repairNativePdfDocxXml(auto(tableXml([600,1390])),[]),/<w:gridCol w:w="600"\/><w:gridCol w:w="1390"\/>/);
 for(const xml of [tableXml([600,1390]),auto(tableXml([600,1500]))]) {
  assert.match(repairNativePdfDocxXml(xml,[]),/<w:gridCol w:w="1000"\/><w:gridCol w:w="1000"\/>/);
 }
});

test('nested tables do not borrow either table grid for width repair', () => {
 const inner='<w:tbl><w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="20"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="20" w:type="dxa"/></w:tcPr>'+xmlDocxParagraph('Inner')+'</w:tc></w:tr></w:tbl>';
 const outer=tableXml([600,1400]).replace('</w:tc>',inner+'</w:tc>');
 const repaired=repairNativePdfDocxXml(outer,[]);
 assert.match(repaired,/<w:gridCol w:w="1000"\/><w:gridCol w:w="1000"\/>/);
 assert.match(repaired,/<w:gridCol w:w="20"\/>/);
});

test('empty native cells do not inherit document paragraph gaps when row height becomes a minimum', () => {
 const xml=wordXml('<w:p/>'+tableXml([600,1400]).replace(/^.*?<w:body>/,'').replace(/<\/w:body>.*$/,'').replace(xmlDocxParagraph('Cell'),'<w:p/>'));
 const repaired=repairNativePdfDocxXml(xml,[]);
 assert.match(repaired,/<w:body><w:p\/>/,'Empty body paragraphs retain their layout');
 assert.match(repaired,/<w:tcPr>[\s\S]*?<\/w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/><\/w:pPr><\/w:p><\/w:tc>/);
 assert.doesNotMatch(repaired,/<w:sz/,'Empty form fields must retain a normal editable font size');
});

test('native failure logs only fixed stages, approved codes and numeric exit status', async t => {
 const root=await scratch(t), input=path.join(root,'input.pdf'),output=path.join(root,'output.docx');await inputPdf(input);
 const logger=require('../logger'), messages=[],original=logger.warn;
 logger.warn=(...args)=>messages.push(args);t.after(()=>{logger.warn=original;});
 await assert.rejects(convertPdfToDocx(input,output,[{pageNumber:1,rows:[['Editable source text']]}],{
  docenginePath:'synthetic-engine',nativeTempRoot:root,
  run:async()=>{throw Object.assign(new Error('SECRET filename and engine stderr'),{code:'SECRET_RAW_CODE',exitCode:17,stderr:'SECRET'});},
  convertStructuredPdf:async()=>{throw new Error('synthetic failure');}
 }));
 const log=messages.find(message=>String(message[0]).startsWith('PDF native attempt failed: '));
 assert.deepEqual(log,['PDF native attempt failed: {"stage":"run","code":"NATIVE_FAILURE","exitCode":17}']);
});

test('native PDF engine receives bounded staged input and output with deep TEMP and a long Chinese destination', async t => {
  const root=await scratch(t), deep=path.join(root,'deep-'.repeat(35)), fallback=path.join(root,'short');
  await fs.mkdir(deep,{recursive:true});
  const input=path.join(deep,'这是需要保留的完整中文原件文件名'.repeat(4)+'.pdf');
  const output=path.join(deep,'这是需要保留的完整中文转换结果名称'.repeat(4)+'.docx');
  await inputPdf(input);
  const original=await fs.readFile(input);
  let called=false, observed;
  const result=await convertPdfToDocx(input,output,[{pageNumber:1,rows:[['Editable source text']]}],{
    docenginePath:'synthetic-engine',nativeTempRoot:deep,nativeFallbackRoot:fallback,
    run:async (_engine,args)=>{
      called=true;observed=args.slice();
      assert.ok(args[1].length<200);assert.ok(args[2].length<200);
      assert.deepEqual(await fs.readFile(args[1]),original);
      await nativeDocx(args[2],'Editable source text');
    },
    convertStructuredPdf:async()=>assert.fail('A valid native result must not fall through to OCR')
  });
  assert.equal(called,true);assert.deepEqual(result.warnings,[]);
  assert.equal((await validateNativePdfDocx(output)).editableText,'Editable source text');
  assert.deepEqual(await fs.readFile(input),original);
  assert.equal(await fs.stat(observed[1]).then(()=>true,()=>false),false);
  assert.equal(await fs.stat(observed[2]).then(()=>true,()=>false),false);
  assert.deepEqual(await fs.readdir(fallback),[]);
});

test('native staging failure cleans its workspace and preserves a pre-existing destination', async t => {
  const root=await scratch(t), input=path.join(root,'input.pdf'), output=path.join(root,'keep.docx');
  await inputPdf(input);await fs.writeFile(output,'KEEP ORIGINAL');
  let staged;
  await assert.rejects(convertPdfToDocx(input,output,[{pageNumber:1,rows:[['Editable source text']]}],{
    docenginePath:'synthetic-engine',nativeTempRoot:root,
    run:async (_engine,args)=>{staged=args[1];await fs.writeFile(args[2],'partial');throw new Error('synthetic engine failure');},
    convertStructuredPdf:async()=>{throw new Error('synthetic structured failure');}
  }));
  assert.equal(await fs.readFile(output,'utf8'),'KEEP ORIGINAL');
  assert.equal(await fs.stat(staged).then(()=>true,()=>false),false);
});

test('a tiny uniform decorative image does not send otherwise searchable text through page OCR', async t => {
  const root=await scratch(t),input=path.join(root,'decoration.pdf');
  const bytes=await sharp({create:{width:9,height:7,channels:3,background:'#000000'}}).png().toBuffer();
  await inputPdf(input,{bytes,size:6});
  const pages=await extractPdfRowsByPage(input);
  assert.ok(pages[0].imageCoverage>0);
  assert.deepEqual(await fillMissingPdfPageText(input,pages,{ocrAvailable:()=>false}),pages);
});

test('nonuniform small images retain the conservative OCR requirement', async t => {
  const root=await scratch(t),input=path.join(root,'image-text.pdf');
  const pixels=Buffer.alloc(9*7*3,255);pixels.fill(0,0,27);
  const bytes=await sharp(pixels,{raw:{width:9,height:7,channels:3}}).png().toBuffer();
  await inputPdf(input,{bytes,size:6});
  const pages=await extractPdfRowsByPage(input);
  await assert.rejects(fillMissingPdfPageText(input,pages,{ocrAvailable:()=>false}),{code:'PDF_OCR_REQUIRED'});
});

// Exercise the production PDF geometry, decoded image pixels, DOCX relationships
// and drawing checks together. Only the external native-engine process is replaced.
const { Document, Packer, Paragraph, ImageRun } = require('docx');
const { openZipEntriesFromBuffer } = require('../zip-util');
const illustratedBody = [
  'Steel bridge members transfer the deck load through connected beams and columns.',
  'The engineering text remains directly editable while the figure retains its source pixels.',
  'Connections and supports must be inspected together with the illustrated structural arrangement.'
];

async function illustratedPdfFixture(filename, { scan = false, repeat = false } = {}) {
  const pixels = Buffer.alloc(100 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const offset = (y * 100 + x) * 3;
    pixels[offset] = (x * 3 + y) % 256;
    pixels[offset + 1] = (x + y * 5) % 256;
    pixels[offset + 2] = (x * 7 + y * 3) % 256;
  }
  const image = await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = scan ? ['Digitally added scan heading'] : [...illustratedBody, 'Fig. 1 Bridge'];
  for (const [index, line] of (scan ? text : illustratedBody).entries()) {
    page.drawText(line, { font, x: 30, y: 760 - index * 16, size: 10 });
  }
  const embedded = await pdf.embedPng(image);
  page.drawImage(embedded, { x: 100, y: scan ? 150 : 400, width: scan ? 350 : 75, height: scan ? 350 : 75 });
  if (!scan) page.drawText('Fig. 1 Bridge', { font, x: 100, y: 385, size: 10 });
  if (repeat) {
    page.drawImage(embedded, { x: 300, y: 400, width: 75, height: 75 });
    page.drawText('Fig. 2 Support', { font, x: 300, y: 385, size: 10 });
    text.push('Fig. 2 Support');
  }
  await fs.writeFile(filename, await pdf.save());
  return { image, text, scan };
}

async function readIllustrationDocxEntries(buffer) {
  const archive = await openZipEntriesFromBuffer(buffer);
  return new Promise((resolve, reject) => {
    const entries = [];
    archive.on('error', reject);
    archive.on('end', () => resolve(entries));
    archive.on('entry', entry => {
      if (entry.fileName.endsWith('/')) return archive.readEntry();
      archive.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          entries.push({ path: entry.fileName, content: Buffer.concat(chunks) });
          archive.readEntry();
        });
      });
    });
    archive.readEntry();
  });
}

async function illustrationNativeDocx(filename, fixture, variant = 'complete') {
  const image = variant === 'replaced'
    ? await sharp(fixture.image).negate().png().toBuffer()
    : fixture.image;
  const children = fixture.text.map(text => new Paragraph(text));
  if (variant !== 'omitted') {
    const displayPixels = fixture.scan ? 350 * 4 / 3 : variant === 'undersized' ? 25 : 100;
    children.push(new Paragraph({ children: [new ImageRun({
      type: 'png', data: image, transformation: { width: displayPixels, height: displayPixels }
    })] }));
  }
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  if (!['unreferenced', 'cropped', 'hidden', 'moved-from', 'unselected-fallback', 'hidden-style', 'exact-line'].includes(variant)) {
    await fs.writeFile(filename, buffer);
    return;
  }
  const entries = await readIllustrationDocxEntries(buffer);
  const document = entries.find(entry => entry.path === 'word/document.xml');
  const original = document.content.toString('utf8');
  let edited = original;
  if (variant === 'unreferenced') edited = original.replace(/<w:drawing\b[^>]*>[\s\S]*?<\/w:drawing>/, '');
  if (variant === 'cropped') edited = original.replace('<a:stretch>', '<a:srcRect l="10000"/><a:stretch>');
  if (variant === 'hidden') edited = original.replace('<w:drawing>', '<w:rPr><w:vanish/></w:rPr><w:drawing>');
  if (variant === 'moved-from') edited = original.replace(/(<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>)/,
    '<w:moveFrom w:id="42" w:author="Regression fixture">$1</w:moveFrom>');
  if (variant === 'unselected-fallback') edited = original.replace(/(<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>)/,
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
      + '<mc:Choice Requires="w"><w:r><w:t>Figure unavailable</w:t></w:r></mc:Choice>'
      + '<mc:Fallback>$1</mc:Fallback></mc:AlternateContent>');
  if (variant === 'hidden-style') {
    edited = original.replace('<w:r><w:drawing>', '<w:r><w:rPr><w:rStyle w:val="HiddenFigure"/></w:rPr><w:drawing>');
    const styles = entries.find(entry => entry.path === 'word/styles.xml');
    const originalStyles = styles.content.toString('utf8');
    const hiddenStyles = originalStyles.replace('</w:styles>',
      '<w:style w:type="character" w:styleId="HiddenFigure"><w:name w:val="HiddenFigure"/>'
        + '<w:rPr><w:vanish/></w:rPr></w:style></w:styles>');
    assert.notEqual(hiddenStyles, originalStyles, 'The style fixture must hide its referenced character style');
    styles.content = Buffer.from(hiddenStyles);
  }
  if (variant === 'exact-line') edited = original.replace('<w:p><w:r><w:drawing>',
    '<w:p><w:pPr><w:spacing w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:drawing>');
  assert.notEqual(edited, original, `The ${variant} fixture must alter the visible drawing`);
  document.content = Buffer.from(edited);
  await writeDocxZip(filename, entries);
}

async function convertIllustrationFixture(root, input, output, fixture, variant = 'complete') {
  const pages = await extractPdfRowsByPage(input);
  assert.ok((pages[0].ocrImageCoverage ?? pages[0].imageCoverage) > 0,
    'This fixture must exercise the page-image OCR guard');
  return convertPdfToDocx(input, output, pages, {
    docenginePath: 'synthetic-native-engine', nativeTempRoot: root,
    run: async (_engine, args) => illustrationNativeDocx(args[2], fixture, variant),
    ocrAvailable: () => false,
    convertStructuredPdf: async () => assert.fail('Coverage failures must retain the existing page OCR route')
  });
}

test('native illustrations preserve captioned source pixels and editable text without OCR', async t => {
  const root = await scratch(t), input = path.join(root, 'captioned.pdf'), output = path.join(root, 'complete.docx');
  const fixture = await illustratedPdfFixture(input);
  const result = await convertIllustrationFixture(root, input, output, fixture);
  assert.ok(result.warnings.some(warning => warning.code === 'PDF_NATIVE_ILLUSTRATIONS_PRESERVED'));
  const validation = await validateNativePdfDocx(output);
  for (const text of fixture.text) assert.ok(validation.editableText.includes(text));
  const entries = await readIllustrationDocxEntries(await fs.readFile(output));
  const media = entries.find(entry => entry.path.startsWith('word/media/') && entry.path.endsWith('.png'));
  assert.ok(media, 'The delivered package must contain the preserved figure');
  assert.deepEqual(await sharp(media.content).removeAlpha().raw().toBuffer(),
    await sharp(fixture.image).removeAlpha().raw().toBuffer());
});

for (const variant of ['omitted', 'replaced', 'unreferenced', 'cropped', 'hidden', 'undersized',
  'moved-from', 'unselected-fallback', 'hidden-style', 'exact-line']) {
  test(`native illustrations require OCR when the DOCX figure is ${variant}`, async t => {
    const root = await scratch(t), input = path.join(root, 'captioned.pdf'), output = path.join(root, 'keep.docx');
    const fixture = await illustratedPdfFixture(input);
    await fs.writeFile(output, 'KEEP ORIGINAL');
    await assert.rejects(convertIllustrationFixture(root, input, output, fixture, variant), { code: 'PDF_OCR_REQUIRED' });
    assert.equal(await fs.readFile(output, 'utf8'), 'KEEP ORIGINAL');
  });
}

test('native illustrations cannot exempt a raster scan with only a digital heading and no caption', async t => {
  const root = await scratch(t), input = path.join(root, 'scan.pdf'), output = path.join(root, 'scan.docx');
  const fixture = await illustratedPdfFixture(input, { scan: true });
  await assert.rejects(convertIllustrationFixture(root, input, output, fixture), { code: 'PDF_OCR_REQUIRED' });
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
});

test('native illustrations require every repeated source drawing, not merely its shared media bytes', async t => {
  const root = await scratch(t), input = path.join(root, 'repeated.pdf'), output = path.join(root, 'repeated.docx');
  const fixture = await illustratedPdfFixture(input, { repeat: true });
  await assert.rejects(convertIllustrationFixture(root, input, output, fixture), { code: 'PDF_OCR_REQUIRED' });
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
});
