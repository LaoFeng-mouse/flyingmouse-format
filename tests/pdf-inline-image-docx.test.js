const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFNumber } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { validateNativePdfDocx, missingPdfText } = require('../pdf');
const { convertInlineImagePdfToDocx } = require('../pdf-inline-image-docx');
const { openZipEntriesFromBuffer } = require('../zip-util');
const { spawnSync } = require('node:child_process');
const { XMLParser } = require('fast-xml-parser');

async function packageEntries(filename) {
  const archive=await openZipEntriesFromBuffer(await fs.readFile(filename));
  return new Promise((resolve,reject)=>{
    const entries=[];archive.on('error',reject);archive.on('end',()=>resolve(entries));
    archive.on('entry',entry=>{
      if(entry.fileName.endsWith('/'))return archive.readEntry();
      archive.openReadStream(entry,(error,stream)=>{
        if(error)return reject(error);const chunks=[];
        stream.on('error',reject);stream.on('data',c=>chunks.push(c));stream.on('end',()=>{
          entries.push({name:entry.fileName,data:Buffer.concat(chunks)});archive.readEntry();
        });
      });
    });archive.readEntry();
  });
}

async function fixture(t, mode = 'inline') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmf-inline-docx-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(), page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(await sharp({ create: { width: 90, height: 30, channels: 3, background: '#c04020' } }).png().toBuffer());
  page.drawText('Editable beginning', { x: 40, y: 750, size: 12, font });
  page.drawText('and ending.', { x: 235, y: 750, size: 12, font });
  page.drawImage(image, { x: mode === 'hidden' ? 40 : 160, y: mode === 'big' ? 500 : 746,
    width: mode === 'hidden' ? 115 : mode === 'big' ? 400 : 65,
    height: mode === 'big' ? 200 : 18, ...(mode === 'rotate' ? { rotate: degrees(5) } : {}) });
  if (mode === 'repeat') {
    page.drawText('Second beginning', { x: 40, y: 710, size: 12, font });
    page.drawText('and ending.', { x: 235, y: 710, size: 12, font });
    page.drawImage(image, { x: 160, y: 706, width: 65, height: 18 });
  }
  if (mode === 'occluded') page.drawRectangle({ x: 160, y: 746, width: 65, height: 18, color: rgb(1, 1, 1) });
  const inputPath = path.join(root, 'input.pdf'), outputPath = path.join(root, 'result.docx');
  await fs.writeFile(inputPath, await pdf.save());
  return { inputPath, outputPath, pages: await extractPdfRowsByPage(inputPath) };
}

test('inline-image fallback declares whole-line rasterization and preserves its real image reference', async t => {
  const args = await fixture(t), result = await convertInlineImagePdfToDocx(args);
  assert.equal(result.imageCount, 1);
  assert.equal(result.warnings[0].code, 'PDF_INLINE_IMAGES_PRESERVED');
  const checked = await validateNativePdfDocx(args.outputPath,{includeInlineParagraphs:true,allowImageOnlyInline:true});
  assert.equal(result.rasterizedLineCount,1);
  assert.equal(checked.hasEditableContent,false);
  assert.deepEqual(checked.inlineParagraphs,result.expectedInlineParagraphs);
  assert.match(result.warnings[0].messages.zhCN,/整行.*不可直接改字/);
  // Word rejects an otherwise well-formed DOCX if a drawing's required name
  // is missing. LibreOffice can render that same invalid drawing, so parsing
  // or rendering the package alone does not exercise this contract.
  const documentEntry = (await packageEntries(args.outputPath)).find(e=>e.name==='word/document.xml');
  const document = new XMLParser({ignoreAttributes:false}).parse(documentEntry.data.toString());
  assert.equal(document['w:document']['@_xmlns:wp'],'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing');
  const drawings=[];
  const visit=node=>{
    if(!node || typeof node!=='object')return;
    for(const [key,value]of Object.entries(node)) {
      if(key==='wp:docPr')drawings.push(...(Array.isArray(value)?value:[value]));
      visit(value);
    }
  };
  visit(document);
  assert.equal(drawings.length,result.cropCount);
  for(const drawing of drawings) {
    assert.ok(typeof drawing['@_name']==='string' && drawing['@_name'].trim().length>0,
      'each actual inline drawing needs a non-empty name for Microsoft Word');
    assert.ok(drawing['@_title']);
    assert.ok(drawing['@_descr']);
  }
});

test('repeated image references retain both visible occurrences', async t => {
  const result = await convertInlineImagePdfToDocx(await fixture(t, 'repeat'));
  assert.equal(result.imageCount, 2);
});

for (const mode of ['big', 'rotate', 'hidden', 'occluded']) test(`inline fallback refuses ${mode} content without publishing`, async t => {
  const args = await fixture(t, mode);
  assert.equal(await convertInlineImagePdfToDocx(args), null);
  await assert.rejects(fs.stat(args.outputPath), { code: 'ENOENT' });
});

test('cancellation never publishes a partial inline DOCX', async t => {
  const args = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(convertInlineImagePdfToDocx({ ...args, options: { signal: controller.signal } }), { code: 'CONVERSION_CANCELED' });
  await assert.rejects(fs.stat(args.outputPath), { code: 'ENOENT' });
});

test('a partly covered native character stays only in the visible crop, never XML or alt text', async t => {
  const args=await fixture(t),pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const font=await pdf.embedFont(StandardFonts.Helvetica),text='Visible SECRET';
  page.drawText(text,{x:40,y:750,size:12,font});
  page.drawText('ending',{x:235,y:750,size:12,font});
  const png=await sharp({create:{width:90,height:30,channels:3,background:'#c04020'}}).png().toBuffer();
  page.drawImage(await pdf.embedPng(png),{x:40+font.widthOfTextAtSize(text,12)-6,y:746,width:65,height:18});
  await fs.writeFile(args.inputPath,await pdf.save());args.pages=await extractPdfRowsByPage(args.inputPath);
  const result=await convertInlineImagePdfToDocx(args),checked=await validateNativePdfDocx(args.outputPath,{includeInlineParagraphs:true,allowImageOnlyInline:true});
  const covered=result.rasterizedGlyphs.find(g=>g.text==='T');
  assert.ok(covered);
  assert.equal(args.pages[0].lines[0].items[0].text.slice(covered.sourceStart,covered.sourceEnd),'T');
  assert.ok(!checked.editableText.includes('SECRET'));
  assert.equal(checked.hasEditableContent,false);
  assert.deepEqual(checked.inlineParagraphs,result.expectedInlineParagraphs);
  assert.deepEqual(missingPdfText(result.textCoveragePages,checked.editableText),[]);
  const entries=await packageEntries(args.outputPath);
  for(const entry of entries.filter(e=>e.name.endsWith('.xml')))assert.ok(!entry.data.toString().includes('SECRET'),entry.name);
  assert.equal(entries.filter(e=>e.name.endsWith('.png')).length,1);
});

test('a glyph connecting two pictures is retained once in one visible crop', async t => {
  const args=await fixture(t),pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  for(const [text,x]of [['LEFT',40],['A',158],['RIGHT',260]])page.drawText(text,{x,y:750,size:12,font});
  const png=await sharp({create:{width:90,height:30,channels:3,background:'#c04020'}}).png().toBuffer();
  const im=await pdf.embedPng(png);for(const x of [100,164])page.drawImage(im,{x,y:746,width:60,height:18});
  await fs.writeFile(args.inputPath,await pdf.save());args.pages=await extractPdfRowsByPage(args.inputPath);
  const result=await convertInlineImagePdfToDocx(args),checked=await validateNativePdfDocx(args.outputPath,{includeInlineParagraphs:true,allowImageOnlyInline:true});
  assert.equal(result.imageCount,2);assert.equal(result.cropCount,1);
  assert.ok(result.rasterizedGlyphs.some(g=>g.text==='A'));assert.ok(!checked.editableText.includes('A'));
  assert.deepEqual(checked.inlineParagraphs,result.expectedInlineParagraphs);
  assert.deepEqual(missingPdfText(result.textCoveragePages,checked.editableText),[]);
  const entries=await packageEntries(args.outputPath);
  assert.equal(entries.filter(e=>e.name.endsWith('.png')).length,1);
  assert.equal((entries.find(e=>e.name==='word/document.xml').data.toString().match(/<w:drawing>/g)||[]).length,1);
});

for(const phase of ['loading','parsing'])test(`cancellation during ${phase} stops before output and destroys an active parser`,async t=>{
  const args=await fixture(t),root=path.resolve(__dirname,'..');
  const code=`
    const assert=require('node:assert/strict');const root=process.argv[1],inputPath=process.argv[2],outputPath=process.argv[3],phase=process.argv[4];
    const loader=require(root+'/pdfjs');const controller=new AbortController();
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let called=false,destroyed=false;
    const page={getViewport:()=>({transform:[1,0,0,-1,0,842],width:595,height:842}),getTextContent:async()=>({items:[]}),cleanup(){},
      getOperatorList:async()=>{enter();await gate;return {fnArray:[],argsArray:[]};}};
    const task={promise:Promise.resolve({numPages:1,getPage:async()=>page}),destroy:async()=>{destroyed=true;release();}};
    loader.loadPdfjs=async()=>{if(phase==='loading'){enter();await gate;}return {version:'6.2.108',OPS:{},getDocument:opts=>{
      called=true;assert.ok(opts.maxImageSize>0);assert.equal(opts.stopAtErrors,true);return task;}};};
    const {convertInlineImagePdfToDocx}=require(root+'/pdf-inline-image-docx');
    const pending=convertInlineImagePdfToDocx({inputPath,outputPath,pages:[{lines:[{}],imageCoverage:.1}],options:{signal:controller.signal}});
    const checked=assert.rejects(pending,{code:'CONVERSION_CANCELED'});
    (async()=>{await entered;controller.abort();if(phase==='loading')release();
      await Promise.race([checked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('cancel timeout')),1000))]);
      if(phase==='loading')assert.equal(called,false);else assert.equal(destroyed,true);
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result=spawnSync(process.execPath,['--preserve-symlinks','-e',code,root,args.inputPath,args.outputPath,phase],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  await assert.rejects(fs.stat(args.outputPath),{code:'ENOENT'});
});

test('unreliably small hidden glyphs never become editable text',async t=>{
  const args=await fixture(t),pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Visible body',{x:40,y:750,size:12,font});
  page.drawText('SECRET',{x:40,y:650,size:.1,font});
  const png=await sharp({create:{width:90,height:30,channels:3,background:'#ffffff'}}).png().toBuffer();
  page.drawImage(await pdf.embedPng(png),{x:39.95,y:650,width:.8,height:.6});
  await fs.writeFile(args.inputPath,await pdf.save());args.pages=await extractPdfRowsByPage(args.inputPath);
  assert.equal(await convertInlineImagePdfToDocx(args),null);
  await assert.rejects(fs.stat(args.outputPath),{code:'ENOENT'});
});

test('an oversized declared image is rejected before the PDF.js image decoder runs',async t=>{
  const args=await fixture(t),pdf=await PDFDocument.load(await fs.readFile(args.inputPath));
  const objects=pdf.getPages()[0].node.Resources().lookup(PDFName.of('XObject'));
  const image=pdf.context.lookup(objects.entries()[0][1]);image.dict.set(PDFName.of('Width'),PDFNumber.of(1000000000));
  await fs.writeFile(args.inputPath,await pdf.save());
  const root=path.resolve(__dirname,'..'),code=`
    const assert=require('node:assert/strict'),root=process.argv[1],loader=require(root+'/pdfjs');
    let entered=false;loader.loadPdfjs=async()=>({version:'6.2.108',getDocument(){entered=true;throw new Error('decoder must not run');}});
    require(root+'/pdf-inline-image-docx').convertInlineImagePdfToDocx({inputPath:process.argv[2],outputPath:process.argv[3],pages:[{lines:[{}],imageCoverage:.1}]})
      .then(()=>{throw new Error('expected resource rejection');},error=>{assert.equal(error.errorCode,'IMAGE_DIMENSION_EXCEEDED');assert.equal(entered,false);})
      .catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result=spawnSync(process.execPath,['--preserve-symlinks','-e',code,root,args.inputPath,args.outputPath],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  await assert.rejects(fs.stat(args.outputPath),{code:'ENOENT'});
});
