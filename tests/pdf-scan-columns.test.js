const test = require('node:test');
const assert = require('node:assert/strict');
const { repairScanColumnLayout } = require('../pdf-scan-columns');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');

function fixture(rows = [['商品名称','数量','单价','金额'],['鼠标','12','39.50','474.00'],['键盘','8','89.00','712.00']], digitSpacing=3) {
  const width=digitSpacing>3?1400:1000,height=700,data=Buffer.alloc(width*height,255),lines=[];
  const starts=digitSpacing>3?[80,400,700,1050]:[80,340,500,710];
  for(let row=0;row<rows.length;row++) {
    const y=100+row*90,words=[];
    for(let column=0;column<rows[row].length;column++) {
      const text=rows[row][column];if(!text)continue;
      let x=starts[column];
      const start=x,symbols=[];
      for(const c of text) {
        const w=/[\u3400-\u9fff]/.test(c)?25:14;
        for(let py=y;py<y+28;py++)for(let px=x;px<x+w;px++)data[py*width+px]=0;
        symbols.push({text:c,bbox:{x0:x,y0:y,x1:x+w,y1:y+28},confidence:95});
        x+=w+(/[\d.]/.test(c)?digitSpacing:3);
      }
      words.push({text,bbox:{x0:start,y0:y,x1:symbols.at(-1).bbox.x1,y1:y+28},confidence:95,symbols});
    }
    lines.push({text:rows[row].join(' '),bbox:{x0:80,y0:y,x1:width-10,y1:y+28},words});
  }
  const blocks=rows.map((row,index)=>({type:'text',text:row.join(''),bbox:[40,50+index*90,850,80+index*90],confidence:0}));
  const manifest={schemaVersion:1,engine:{name:'fixture',version:'1'},pages:[{pageNumber:1,width,height,rotation:0,referenceImage:'unused.png',tables:[],tableLike:false,warnings:[],blocks}]};
  const reference={width,height,lines,pixels:data,rotation:0};
  const options={scanColumnDependencies:{inspectReference:async()=>reference,validateManifest:value=>value}};
  return {manifest,reference,options};
}

test('borderless scan restores editable cells from pixels and independently recognized numeric regions',async()=>{
  const {manifest,options}=fixture();Object.freeze(manifest.pages[0].blocks);
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables.length,1);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.map(c=>c.text),['商品名称','数量','单价','金额','鼠标','12','39.50','474.00','键盘','8','89.00','712.00']);
  assert.equal(manifest.pages[0].tables.length,0);
  assert.equal(result.manifest.pages[0].blocks[0].type,'table');
  assert.ok(result.warnings.length);
});

test('blank cells and leading zero amounts remain strings in their original column',async()=>{
  const {manifest,options}=fixture([['商品名称','数量','单价','金额'],['产品甲','001','00.50','000.50'],['产品乙','','02.00','004.00']]);
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.slice(8).map(c=>c.text),['产品乙','','02.00','004.00']);
  assert.equal(result.manifest.pages[0].tables[0].cells[5].text,'001');
});

test('existing tables, a numeric title, and ordinary numeric prose do not start OCR',async()=>{
  const {manifest}=fixture();let calls=0;const options={scanColumnDependencies:{inspectReference:async()=>{calls++;throw Error('must not run')}}};
  manifest.pages[0].tables=[{id:'existing'}];manifest.pages[0].blocks=[{type:'table',tableId:'existing',bbox:[20,20,800,400]}];await repairScanColumnLayout(manifest,'unused',options);
  manifest.pages[0].tables=[];manifest.pages[0].blocks=[{type:'heading',text:'2026年度报告',bbox:[20,20,250,55]}];await repairScanColumnLayout(manifest,'unused',options);
  manifest.pages[0].blocks=[{type:'text',text:'正常正文',bbox:[20,20,140,50]},{type:'text',text:'本次购买12件商品共花费474.00元。',bbox:[20,60,500,90]}];await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(calls,0);
});

test('an existing detected table does not hide a separate collapsed table on the same page',async()=>{
  const {manifest,options}=fixture();const existing={id:'scan-columns-1-1',cells:[]};
  manifest.pages[0].tables=[existing];manifest.pages[0].blocks.unshift({type:'table',tableId:existing.id,bbox:[20,5,800,40]});
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables.length,2);
  assert.equal(new Set(result.manifest.pages[0].tables.map(t=>t.id)).size,2);
  assert.deepEqual(result.manifest.pages[0].tables[0],existing);
});

test('a detected table whose cells still join physical columns is rechecked including blank cells',async()=>{
  const {manifest,options}=fixture([['商品名称','数量','单价','金额'],['鼠标','12','39.50','474.00'],['键盘','8','','712.00']]);
  const rows=[['商品名称','数量','单价 金额'],['鼠标','１２','３９.５０ ４７４.００'],['键盘','８','７１２.００']];
  const table={id:'detected',bbox:[50,50,900,350],rowCount:3,columnCount:3,confidence:.9,cells:rows.flatMap((row,r)=>row.map((text,c)=>({row:r,column:c,rowSpan:1,columnSpan:1,text,confidence:.9,bbox:[50+c*270,50+r*90,320+c*270,80+r*90]})))};
  manifest.pages[0].tables=[table];manifest.pages[0].blocks=[{type:'table',tableId:table.id,bbox:table.bbox,confidence:.9}];
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables.length,1);
  assert.equal(result.manifest.pages[0].tables[0].columnCount,4);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.slice(8).map(c=>c.text),['键盘','8','','712.00']);
  for(const cell of table.cells) cell.text=cell.text.replace(/\s/g,'');
  const withoutSpaces=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(withoutSpaces.manifest.pages[0].tables[0].columnCount,4);
});

test('ordinary grid values containing dates, identifiers and conventional digit grouping do not require OCR',async()=>{
  const {manifest,options}=fixture();let calls=0;
  options.scanColumnDependencies.inspectReference=async()=>{calls++;throw Error('must not run')};
  manifest.pages[0].blocks=[{type:'table',tableId:'existing',bbox:[20,20,800,400]}];
  manifest.pages[0].tables=[{id:'existing',cells:['2026.09.28','2026-09-28','001234567890','1,234,567.89','1.234.567,89','192.168.1.1'].map(text=>({text}))}];
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest,manifest);assert.equal(calls,0);
});

test('an abort before reference inspection never starts OCR',async()=>{
  const {manifest,options}=fixture();let calls=0;options.scanColumnDependencies.inspectReference=async()=>{calls++};
  options.signal=AbortSignal.abort();
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'CONVERSION_CANCELED'});
  assert.equal(calls,0);
});

test('a shifted model frame cannot associate the wrong independently read amounts',async()=>{
  const {manifest,reference,options}=fixture();
  [reference.lines[1],reference.lines[2]]=[reference.lines[2],reference.lines[1]];
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'PDF_SCAN_COLUMNS_UNVERIFIED'});
});

test('a suspected collapsed table cannot swallow missing OCR or contradictory numeric recognition',async()=>{
  const {manifest,options,reference}=fixture();
  options.scanColumnDependencies.inspectReference=async()=>{throw Object.assign(Error('missing'),{code:'OCR_ENGINE_UNAVAILABLE'})};
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'OCR_ENGINE_UNAVAILABLE'});
  reference.lines[1].words[3].text='479.00';options.scanColumnDependencies.inspectReference=async()=>reference;
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'PDF_SCAN_COLUMNS_UNVERIFIED'});
});

test('duplicate values use complete source sequence; shifted model coordinates are never crop coordinates',async()=>{
  const rows=[['商品名称','数量','单价','金额'],['鼠标','12','39.50','474.00'],['鼠标','12','39.50','474.00']];
  const {manifest,reference,options}=fixture(rows);
  manifest.pages[0].blocks.forEach(block=>block.bbox=block.bbox.map((n,index)=>n+(index%2?45:-30)));
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables[0].rowCount,3);
  assert.equal(result.manifest.pages[0].tables[0].cells.filter(c=>c.text==='474.00').length,2);
  reference.lines.push(...structuredClone(reference.lines));
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'PDF_SCAN_COLUMNS_UNVERIFIED'});
});

test('equal amounts do not permit swapping two independently readable item labels',async()=>{
  const {manifest,reference,options}=fixture([['商品名称','数量','单价','金额'],['鼠标','12','39.50','474.00'],['键盘','12','39.50','474.00']]);
  reference.lines[1].words[0].text='键盘';reference.lines[2].words[0].text='鼠标';
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'PDF_SCAN_COLUMNS_UNVERIFIED'});
});

test('fused OCR word spanning two visible numeric regions is unverified rather than guessed',async()=>{
  const {manifest,reference,options}=fixture();
  const words=reference.lines[1].words;words[2]={...words[2],text:words[2].text+words[3].text,bbox:{...words[2].bbox,x1:words[3].bbox.x1}};words.pop();
  await assert.rejects(repairScanColumnLayout(manifest,'unused',options),{code:'PDF_SCAN_COLUMNS_UNVERIFIED'});
});

test('complete character boxes can split a fused OCR word at proven image whitespace',async()=>{
  const {manifest,reference,options}=fixture();const words=reference.lines[1].words;
  words[2]={...words[2],text:words[2].text+words[3].text,symbols:[...words[2].symbols,...words[3].symbols],bbox:{...words[2].bbox,x1:words[3].bbox.x1}};words.pop();
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.slice(4,8).map(cell=>cell.text),['鼠标','12','39.50','474.00']);
});

test('wide digit advance does not confuse decimal bearing with an empty column',async()=>{
  const {manifest,options}=fixture(undefined,24);
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.slice(4,8).map(cell=>cell.text),['鼠标','12','39.50','474.00']);
});

test('two columns with one data row preserve an independently proven grid',async()=>{
  const {manifest,options}=fixture([['项目名称','金额'],['产品甲','001.00']]);
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables[0].rowCount,2);
  assert.equal(result.manifest.pages[0].tables[0].columnCount,2);
  const single=fixture([['项目名称','数量'],['产品甲','2']]);
  const resultSingle=await repairScanColumnLayout(single.manifest,'unused',single.options);
  assert.equal(resultSingle.manifest.pages[0].tables[0].cells[3].text,'2');
});

test('repeated tables with identical content are matched in complete reading order',async()=>{
  const rows=[['商品名称','数量','单价','金额'],['鼠标','12','39.50','474.00'],['键盘','8','89.00','712.00']];
  const {manifest,options}=fixture([...rows,...rows]);
  const result=await repairScanColumnLayout(manifest,'unused',options);
  assert.equal(result.manifest.pages[0].tables.length,2);
  assert.deepEqual(result.manifest.pages[0].tables.map(t=>t.cells.map(c=>c.text)),[rows.flat(),rows.flat()]);
});

test('real OCR and DOCX cells retain leading zeros and an internal blank', {skip:!require('../ocr').ocrAvailable()}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fm-scan-columns-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const rows=[['Item','Qty','Price','Amount'],['PartA','001','00.50','000.50'],['PartB','','02.00','004.00']],xs=[80,340,500,710];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="white"/>${rows.flatMap((row,r)=>row.map((text,c)=>`<text x="${xs[c]}" y="${128+r*90}" font-family="Arial" font-size="32" fill="black">${text}</text>`)).join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(root,'reference.png'));
  const {manifest}=fixture(rows);manifest.pages[0].referenceImage='reference.png';
  const result=await repairScanColumnLayout(manifest,root);
  assert.deepEqual(result.manifest.pages[0].tables[0].cells.map(cell=>cell.text),rows.flat());
  const outputPath=path.join(root,'result.docx');
  const validation=await require('../pdf-office-docx').writePdfOfficeDocx({manifest:result.manifest,assetRoot:root,outputPath});
  assert.deepEqual(validation.tables,[{rows:3,columns:4}]);
  const zip=await require('jszip').loadAsync(await fs.readFile(outputPath));
  const xml=await zip.file('word/document.xml').async('string');
  const cells=[...xml.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(match=>[...match[0].matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/g)].map(text=>text[1]).join(''));
  assert.deepEqual(cells,rows.flat());
});

module.exports={fixture};
