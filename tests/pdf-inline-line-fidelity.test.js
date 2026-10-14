const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, setLineWidth, moveTo, lineTo, stroke } = require('pdf-lib');
const { convertPdfToDocx, validateNativePdfDocx } = require('../pdf');
const { extractPdfRowsByPage } = require('../pdf-table');
const { PDFTOPPM_PATH, LIBREOFFICE_PATH } = require('../config');
const { convertWithLibreOffice } = require('../office-convert');
const { loadPdfjs, getPdfjsDocumentOptions } = require('../pdfjs');
const { run } = require('../utils');
const { openZipEntriesFromBuffer } = require('../zip-util');

async function packageEntries(filename) {
  const archive=await openZipEntriesFromBuffer(await fs.readFile(filename));
  return new Promise((resolve,reject)=>{
    const entries=new Map();archive.on('error',reject);archive.on('end',()=>resolve(entries));
    archive.on('entry',entry=>{
      if(entry.fileName.endsWith('/'))return archive.readEntry();
      archive.openReadStream(entry,(error,stream)=>{
        if(error)return reject(error);const chunks=[];
        stream.on('error',reject);stream.on('data',c=>chunks.push(c));stream.on('end',()=>{
          entries.set(entry.fileName,Buffer.concat(chunks));archive.readEntry();
        });
      });
    });archive.readEntry();
  });
}

test('whole-line image preserves real italic overhang pixels and native text order, spaces and punctuation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fmf-inline-line-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const font=await pdf.embedFont(StandardFonts.Helvetica),italic=await pdf.embedFont(StandardFonts.TimesRomanItalic);
  // The first two text items have a real visible word gap. Their literal
  // expected output is independent of the writer's projected contract.
  page.drawText('now',{x:40,y:790,size:12,font});
  page.drawText('here, US; Again!',{x:70,y:790,size:12,font});
  page.drawText('Lead',{x:40,y:750,size:12,font:italic});
  page.drawText('f',{x:158,y:750,size:24,font:italic});
  page.drawText('ending',{x:250,y:750,size:24,font:italic});
  const image=await pdf.embedPng(await sharp({create:{width:90,height:30,channels:3,background:'#c04020'}}).png().toBuffer());
  page.drawImage(image,{x:110,y:746,width:48.3,height:20});
  page.drawText('Again! Same, US.',{x:40,y:700,size:12,font});
  page.drawText('Again! Same, US.',{x:40,y:660,size:12,font});
  const inputPath=path.join(root,'input.pdf'),outputPath=path.join(root,'output.docx');
  await fs.writeFile(inputPath,await pdf.save());
  const result=await convertPdfToDocx(inputPath,outputPath,await extractPdfRowsByPage(inputPath),{docenginePath:null});
  const entries=await packageEntries(outputPath),media=[...entries].filter(([name])=>name.startsWith('word/media/')&&name.endsWith('.png'));
  assert.equal(media.length,1);
  const hash=crypto.createHash('sha256').update(media[0][1]).digest('hex');
  const actual=await validateNativePdfDocx(outputPath,{includeInlineParagraphs:true});
  const glyph=result.rasterizedGlyphs.find(g=>g.text==='f');
  assert.ok(glyph,'the overhanging glyph is retained in the line image');
  const crop=media[0][1],bbox=glyph.cropBbox;
  const decoded=await sharp(crop).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const region={left:Math.floor(bbox[0]*3+1e-7),top:Math.floor(bbox[1]*3+1e-7),width:decoded.info.width,height:decoded.info.height};
  const prefix=path.join(root,'independent-source');
  await run(PDFTOPPM_PATH,['-png','-cropbox','-r','216','-singlefile',inputPath,prefix],{timeout:60000});
  const original=await sharp(prefix+'.png').removeAlpha().raw().toBuffer({resolveWithObject:true});
  const expected=await sharp(prefix+'.png').extract(region).removeAlpha().raw().toBuffer();
  assert.deepEqual(decoded.data,expected,'actual DOCX media must equal source pixels, including background and underline space');
  let overhangPixels=0;
  // R7 clipped the Times Italic f at x=495px. Check actual dark pixels beyond
  // that bound, rather than merely checking a new crop width or XML setting.
  for(let y=220;y<240;y++)for(let x=495;x<510;x++){
    const offset=(y*original.info.width+x)*original.info.channels;
    if(Math.max(...original.data.subarray(offset,offset+3))>=100)continue;
    overhangPixels++;
    assert.ok(x>=region.left&&x<region.left+region.width&&y>=region.top&&y<region.top+region.height,'source overhang must be inside emitted media');
    const local=((y-region.top)*decoded.info.width+x-region.left)*decoded.info.channels;
    assert.deepEqual(decoded.data.subarray(local,local+3),original.data.subarray(offset,offset+3));
  }
  assert.ok(overhangPixels>=30,`fixture must contain the known missing ink, found ${overhangPixels}`);
  assert.deepEqual(actual.inlineParagraphs,[
    [{text:'now here, US; Again!'}],[{imageSha256:hash}],
    [{text:'Again! Same, US.'}],[{text:'Again! Same, US.'}]
  ]);
  assert.equal(result.hasEditableContent,true);
  assert.equal(result.rasterizedLineCount,1);
});

// Read positions from the rendered PDF drawing operators. Text extraction
// merges items and can conceal the overlap at a Word formatting-run boundary.
async function renderedGlyphs(filename) {
  const lib=await loadPdfjs();
  const task=lib.getDocument(getPdfjsDocumentOptions({data:new Uint8Array(await fs.readFile(filename)),isEvalSupported:false}));
  const pdf=await task.promise,result=[];
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  try {
    for(let number=1;number<=pdf.numPages;number++) {
      const page=await pdf.getPage(number),ops=await page.getOperatorList(),O=lib.OPS,stack=[];
      let state={matrix:page.getViewport({scale:1}).transform.slice(),text:[1,0,0,1,0,0],x:0,fontSize:0,hScale:1,charSpace:0,wordSpace:0,rise:0,leading:0};
      for(let i=0;i<ops.fnArray.length;i++) {
        const op=ops.fnArray[i],a=ops.argsArray[i]||[];
        if(op===O.save)stack.push({...state,matrix:state.matrix.slice(),text:state.text.slice()});
        else if(op===O.restore)state=stack.pop();
        else if(op===O.transform)state.matrix=multiply(state.matrix,a);
        else if(op===O.setTextMatrix){state.text=a.length===1?Array.from(a[0]):a.slice();state.x=0;}
        else if(op===O.setFont)state.fontSize=a[1];
        else if(op===O.setHScale)state.hScale=a[0]/100;
        else if(op===O.setCharSpacing)state.charSpace=a[0];
        else if(op===O.setWordSpacing)state.wordSpace=a[0];
        else if(op===O.setTextRise)state.rise=a[0];
        else if(op===O.setLeading)state.leading=a[0];
        else if(op===O.moveText||op===O.setLeadingMoveText){state.text[4]+=a[0]*state.text[0]+a[1]*state.text[2];state.text[5]+=a[0]*state.text[1]+a[1]*state.text[3];state.x=0;if(op===O.setLeadingMoveText)state.leading=-a[1];}
        else if(op===O.nextLine){state.text[4]-=state.leading*state.text[2];state.text[5]-=state.leading*state.text[3];state.x=0;}
        else if(op===O.showText) {
          const matrix=multiply(state.matrix,state.text);
          for(const glyph of a[0]) {
            if(typeof glyph==='number'){state.x-=glyph*state.fontSize*.001*state.hScale;continue;}
            result.push({text:glyph.unicode,page:number,x:matrix[0]*state.x+matrix[2]*state.rise+matrix[4],y:matrix[1]*state.x+matrix[3]*state.rise+matrix[5],em:Math.abs(matrix[0]*state.fontSize)});
            state.x+=(glyph.width*state.fontSize*.001+state.charSpace+(glyph.isSpace?state.wordSpace:0))*state.hScale;
          }
        }
      }
      page.cleanup();
    }
  } finally {await task.destroy();}
  return result;
}

test('real Office render keeps adjacent Chinese underline and color runs separated',async t=>{
  const exists=async filename=>Boolean(filename)&&await fs.access(filename).then(()=>true,()=>false);
  const candidates=['simsun.ttc','simhei.ttf','msyh.ttc'].map(name=>path.join(process.env.WINDIR||'C:/Windows','Fonts',name));
  let fontPath;
  for(const candidate of candidates)if(await exists(candidate)){fontPath=candidate;break;}
  if(!fontPath||!await exists(LIBREOFFICE_PATH)||!await exists(PDFTOPPM_PATH)) {
    assert.notEqual(process.env.FLYINGMOUSE_REQUIRE_REAL_OFFICE_CJK,'1','candidate verification requires real Office, Poppler and a Chinese font');
    return t.skip('real Office, Poppler or local Chinese font unavailable');
  }
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fmf-inline-cjk-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const fontkit=require('@pdf-lib/fontkit');
  pdf.registerFontkit({create:bytes=>{const font=fontkit.create(bytes);return font.fonts?font.fonts[0]:font;}});
  const font=await pdf.embedFont(await fs.readFile(fontPath),{subset:true});
  const before='中'.repeat(39)+'要',after='内容末',size=12.37;
  const boundary=40+font.widthOfTextAtSize(before,size);
  for(const [index,y] of [780,740].entries()) {
    page.drawText(before,{x:40,y,size,font});
    page.drawText(after,{x:boundary,y,size,font,color:index?rgb(.8,0,0):rgb(0,0,0)});
    if(!index)page.pushOperators(pushGraphicsState(),setLineWidth(.5),moveTo(boundary,y-1.4),lineTo(boundary+font.widthOfTextAtSize(after,size),y-1.4),stroke(),popGraphicsState());
  }
  // A distinct illustrated line selects the real native-inline conversion path;
  // the two native Chinese lines above must remain editable and inspectable.
  const latin=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Before',{x:40,y:660,size:12,font:latin});
  page.drawText('After',{x:230,y:660,size:12,font:latin});
  const image=await pdf.embedPng(await sharp({create:{width:90,height:30,channels:3,background:'#306090'}}).png().toBuffer());
  page.drawImage(image,{x:160,y:656,width:60,height:20});
  const input=path.join(root,'input.pdf'),docx=path.join(root,'output.docx'),rendered=path.join(root,'rendered.pdf');
  await fs.writeFile(input,await pdf.save());
  const converted=await convertPdfToDocx(input,docx,await extractPdfRowsByPage(input),{docenginePath:null});
  assert.ok(converted.rasterizedLineCount>0,'fixture must exercise the illustrated native route');
  const content=await validateNativePdfDocx(docx,{includeInlineParagraphs:true});
  assert.deepEqual(content.inlineParagraphs.slice(0,2),[[{text:before+after}],[{text:before+after}]]);
  await convertWithLibreOffice(docx,rendered,path.basename(docx),'pdf');
  const glyphs=(await renderedGlyphs(rendered)).filter(g=>/[中要内容末]/u.test(g.text));
  assert.equal(glyphs.length,86,'both 43-character native lines survive Office rendering');
  for(let row=0;row<2;row++) {
    const line=glyphs.slice(row*43,(row+1)*43);
    assert.equal(line.map(g=>g.text).join(''),before+after);
    assert.ok(line.every(g=>g.page===line[0].page&&Math.abs(g.y-line[0].y)<.1),'a source line must not split during Office rendering');
    for(let i=1;i<line.length;i++) {
      const advance=line[i].x-line[i-1].x;
      assert.ok(advance>=line[i-1].em*.8&&advance<=line[i-1].em*1.2,`row ${row+1} ${line[i-1].text}/${line[i].text}: rendered advance ${advance} pt, em ${line[i-1].em} pt`);
    }
  }
});
