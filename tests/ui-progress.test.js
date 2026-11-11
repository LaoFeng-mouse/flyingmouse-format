const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pageHarness } = require('./helpers/ui-page-harness');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
const result = name => ({status:200,body:{fileName:name,downloadUrl:'/downloads/11111111-1111-4111-8111-111111111111'}});
const phase = (id, stage, completed=null, total=null, unit=null, status='running') => ({status:200,body:{id,status,stage,completed,total,unit,elapsedMs:1000,updatedAt:Date.now()}});

test('EPUB reports measured chapters with accurate English and Chinese units', async () => {
  const held=deferred();let snapshot;
  const page=await pageHarness(()=>held.promise,{}, {clock:true,targets:()=>({category:'text',targets:['epub']}),progress:()=>snapshot || {status:404,body:{}}});
  await page.select(['book.txt']);const pending=page.convert();await turn();
  const id=page.conversionHeaders[0]['X-FlyingMouse-Progress-Id'];
  snapshot=phase(id,'converting',1,8,'chapters');await page.advance(600);
  assert.match(page.find('#progressDetails').textContent,/1 \/ 8 chapters/);assert.equal(page.find('#progressPercent').textContent,'12%');
  const language=page.find('#languageSelect');language.value='zh-CN';await language.dispatch('change');
  assert.match(page.find('#progressDetails').textContent,/1 \/ 8 章/);assert.equal(page.find('#progressPercent').textContent,'12%');
  snapshot=phase(id,'converting',8,8,'chapters');await page.advance(600);
  assert.equal(page.find('#progressPercent').textContent,'阶段完成');assert.equal(page.find('#downloadButton').hidden,true);
  held.resolve(result('book.epub'));await pending;assert.equal(page.find('#progressPercent').textContent,'100%');
});

test('a fully measured stage says stage complete in both languages while POST remains pending', async () => {
  const held=deferred(); let snapshot;
  const page=await pageHarness(()=>held.promise,{}, {clock:true,progress:()=>snapshot || {status:404,body:{}}});
  await page.select(['one.pdf']);const pending=page.convert();await turn();
  const id=page.conversionHeaders[0]['X-FlyingMouse-Progress-Id'];
  snapshot=phase(id,'uploading',200,200,'bytes');await page.advance(600);
  assert.equal(page.find('#progressPercent').textContent,'Stage complete');
  assert.equal(page.find('#progressFill').style.width,'100%');assert.match(page.find('#progressDetails').textContent,/200 \/ 200 bytes/);
  assert.equal(page.find('#downloadButton').hidden,true);assert.equal(page.find('#convertButton').disabled,true);
  const language=page.find('#languageSelect');language.value='zh-CN';await language.dispatch('change');
  assert.equal(page.find('#progressPercent').textContent,'阶段完成');assert.match(page.find('#progressDetails').textContent,/后续处理或校验/);
  snapshot=phase(id,'converting');await page.advance(600);
  assert.equal(page.find('#progressPercent').textContent,'');assert.equal(page.find('#progressFill').style.width,'0%');
  held.resolve(result('one.docx'));await pending;
  assert.equal(page.find('#progressPercent').textContent,'100%');assert.match(page.find('#batchList').textContent,/耗时：1.2 秒/);
});

test('real stage counts, static unknown stages and elapsed time survive language changes; success freezes time', async () => {
  const conversion=deferred(); let snapshot;
  const page=await pageHarness(()=>conversion.promise,{}, {clock:true,progress: url=>snapshot || {status:404,body:{}}});
  await page.select(['one.pdf']);const pending=page.convert();await turn();
  const id=page.conversionHeaders[0]?.['X-FlyingMouse-Progress-Id'];
  assert.match(id,/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  assert.doesNotMatch(page.find('#progressPanel').className,/indeterminate/);
  assert.equal(page.find('#progressPercent').textContent,'');
  await page.advance(1200);assert.match(page.find('#progressElapsed').textContent,/00:01/);
  snapshot=phase(id,'recognizing',1,4,'pages');await page.advance(600);
  assert.equal(page.find('#progressPercent').textContent,'25%');assert.match(page.find('#progressDetails').textContent,/1\s*\/\s*4/);
  const language=page.find('#languageSelect');language.value='zh-CN';await language.dispatch('change');
  assert.match(page.find('#progressLabel').textContent,/当前阶段进度/);assert.match(page.find('#progressDetails').textContent,/页/);
  assert.equal(page.find('#progressPercent').textContent,'25%');
  snapshot=phase(id,'validating');await page.advance(600);
  assert.equal(page.find('#progressPercent').textContent,'');assert.equal(page.find('#progressFill').style.width,'0%');
  assert.match(page.find('#progressDetails').textContent,/无法估算/);
  snapshot=phase(id,'completed',null,null,null,'succeeded');await page.advance(600);
  assert.equal(page.find('#downloadButton').hidden,true);assert.equal(page.find('#convertButton').disabled,true);
  conversion.resolve(result('one.docx'));await pending;
  assert.equal(page.find('#progressPercent').textContent,'100%');assert.match(page.find('#progressPanel').className,/success/);
  const elapsed=page.find('#progressElapsed').textContent;await page.advance(5000);assert.equal(page.find('#progressElapsed').textContent,elapsed);assert.equal(page.timers.size,0);
  assert.ok(page.progressRequests.every(request=>request.url===`/api/conversion-progress/${id}`));
});

test('late progress cannot replace a finished result or another run, and failed POST freezes time without success', async () => {
  const first=deferred(), second=deferred(), oldPoll=deferred();
  const page=await pageHarness((_file,index)=>index===1?first.promise:second.promise,{}, {clock:true,progress:(_url,index)=>index===1?oldPoll.promise:{status:404,body:{}}});
  await page.select(['first.pdf']);const a=page.convert();await turn();const firstId=page.conversionHeaders[0]['X-FlyingMouse-Progress-Id'];
  await page.advance(1400);first.resolve(result('first.docx'));await a;
  await page.find('#clearButton').dispatch('click');assert.equal(page.find('#progressPanel').hidden,true);
  await page.select(['second.pdf']);const b=page.convert();await turn();const secondId=page.conversionHeaders[1]['X-FlyingMouse-Progress-Id'];assert.notEqual(firstId,secondId);
  oldPoll.resolve(phase(firstId,'recognizing',999,1000,'pages'));await turn();assert.notEqual(page.find('#progressPercent').textContent,'100%');assert.doesNotMatch(page.find('#progressDetails').textContent,/999/);
  await page.advance(1500);second.reject(new Error('upload interrupted'));await b;
  assert.match(page.find('#progressPanel').className,/error/);assert.notEqual(page.find('#progressPercent').textContent,'100%');
  const elapsed=page.find('#progressElapsed').textContent;await page.advance(1000);assert.equal(page.find('#progressElapsed').textContent,elapsed);assert.equal(page.timers.size,0);
  assert.ok(page.progressRequests.every(request=>request.signal.aborted));
});

for (const mode of ['image merge','PDF merge']) {
test(`${mode} starts without an invented 35 percent and freezes failed duration`, async () => {
  const held=deferred();const image=mode==='image merge';
  const page=await pageHarness(()=>held.promise,{}, {clock:true,targets:()=>({category:image?'image':'pdf',targets:['pdf']}),progress:()=>({status:404,body:{}})});
  await page.select(image?['one.png','two.png']:['one.pdf','two.pdf']);const pending=page.convert();await turn();
  assert.notEqual(page.find('#progressPercent').textContent,'35%');assert.equal(page.find('#progressPercent').textContent,'');
  await page.advance(1700);held.resolve({status:500,body:{error:'merge failed'}});await pending;
  assert.match(page.find('#progressPanel').className,/error/);assert.notEqual(page.find('#progressPercent').textContent,'100%');
  assert.match(page.find('#progressElapsed').textContent,/00:01/);assert.equal(page.timers.size,0);
});
}

test('a mixed batch reports finished and failed item counts separately from stage percentages', async () => {
  const second=deferred();const page=await pageHarness((_file,index)=>index===1?{status:422,body:{error:'first failed'}}:second.promise,{}, {clock:true,progress:()=>({status:404,body:{}})});
  await page.select(['first.pdf','second.pdf']);const pending=page.convert();await turn();
  assert.match(page.find('#progressBatch').textContent,/1\s*\/\s*2/);assert.match(page.find('#progressBatch').textContent,/1 failed/);
  assert.notEqual(page.find('#progressPercent').textContent,'100%');second.resolve(result('second.docx'));await pending;
  assert.match(page.find('#progressBatch').textContent,/2\s*\/\s*2/);assert.match(page.find('#progressBatch').textContent,/1 failed/);
  assert.equal(page.find('#progressPercent').textContent,'100%');assert.doesNotMatch(page.find('#progressPanel').className,/success/);assert.equal(page.timers.size,0);
});

test('the cancel button aborts the in-flight POST and marks the queue canceled', async () => {
  const page = await pageHarness(() => new Promise(() => {}), {}, { clock: true, progress: () => ({ status: 404, body: {} }) });
  await page.select(['one.pdf', 'two.pdf']);
  const pending = page.convert();
  await turn();
  assert.equal(page.find('#cancelButton').hidden, false, 'cancel is offered while converting');
  assert.equal(page.find('#convertButton').disabled, true);
  await page.find('#cancelButton').dispatch('click');
  await pending;
  assert.match(page.find('#statusBox').textContent, /canceled/i);
  assert.equal(page.find('#cancelButton').hidden, true, 'cancel disappears once the batch settles');
  assert.match(page.find('#batchList').textContent, /Canceled/);
  assert.equal(page.find('#convertButton').disabled, false, 'controls are released after cancellation');
});

test('a canceled batch never starts the remaining queued files', async () => {
  let started = 0;
  const page = await pageHarness(() => { started += 1; return new Promise(() => {}); }, {},
    { clock: true, progress: () => ({ status: 404, body: {} }) });
  await page.select(['one.pdf', 'two.pdf', 'three.pdf']);
  const pending = page.convert();
  await turn();
  assert.equal(started, 1);
  await page.find('#cancelButton').dispatch('click');
  await pending;
  assert.equal(started, 1, 'later files must not be dispatched after cancellation');
  assert.equal(page.find('#convertButton').disabled, false);
});
