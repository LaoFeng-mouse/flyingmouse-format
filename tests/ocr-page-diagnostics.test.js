const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { recognizeImageResultWithWorker } = require('../ocr');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { convertPdf } = require('../pdf');

test('unreliable OCR reports its document page without exposing recognized text', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-ocr-page-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const input = path.join(directory, 'scan.png');
  await sharp(Buffer.from('<svg width="2480" height="350" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="80" y="170" font-size="90">Invoice 474.00</text></svg>')).png().toFile(input);
  let scratch;
  const worker = { recognize: async image => {
    scratch = path.dirname(image);
    // Replays the third-party recognizer response; application error handling,
    // image processing, retries and cleanup remain real.
    return {data:{text:'PRIVATE_RECOGNIZED_TEXT',confidence:51,blocks:[]}};
  } };
  await assert.rejects(recognizeImageResultWithWorker(worker, input, {pageNumber:7}), error => {
    assert.equal(error.code, 'OCR_LOW_CONFIDENCE');
    assert.equal(error.details.pageNumber, 7);
    assert.match(error.messages.zhCN, /第\s*7\s*页/);
    assert.match(error.messages.enUS, /page\s+7/i);
    assert.equal(error.details.confidence, 51);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_RECOGNIZED_TEXT/);
    return true;
  });
  await assert.rejects(fs.stat(scratch), {code:'ENOENT'});
});

test('PDF export names the failed scan page and preserves the input and existing destination', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-pdf-ocr-page-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([595,842]).drawText('Native page one with a readable invoice title.', {x:30,y:700,font,size:16});
  const png = await sharp(Buffer.from('<svg width="1000" height="350" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="40" y="180" font-size="85">Invoice 474.00</text></svg>')).png().toBuffer();
  const image = await document.embedPng(png);
  document.addPage([595,842]).drawImage(image,{x:0,y:400,width:595,height:208.25});
  const input = path.join(directory,'input.pdf'), output=path.join(directory,'existing.html');
  const original = Buffer.from(await document.save());
  await fs.writeFile(input,original);
  await fs.writeFile(output,'USER_EXISTING_OUTPUT');
  let terminated=false;
  const worker = {recognize:async()=>({data:{text:'PRIVATE_RECOGNIZED_TEXT',confidence:51,blocks:[]}}),
    terminate:async()=>{terminated=true;}};
  await assert.rejects(convertPdf(input,output,'html',{createOcrWorker:async()=>worker,ocrAvailable:()=>true}),error=>{
    assert.equal(error.code,'OCR_LOW_CONFIDENCE');
    assert.equal(error.details.pageNumber,2);
    assert.match(error.messages.zhCN,/第\s*2\s*页/);
    assert.doesNotMatch(error.message,/PRIVATE_RECOGNIZED_TEXT/);
    return true;
  });
  assert.equal(terminated,true);
  assert.deepEqual(await fs.readFile(input),original);
  assert.equal(await fs.readFile(output,'utf8'),'USER_EXISTING_OUTPUT');
});
