'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const sharp = require('sharp');
const renderer = require('../ofd-renderer');
const ns = 'http://www.ofdspec.org/2016';
const text = '<o:TextObject ID="3" Boundary="20 20 150 20" Font="2" Size="6"><o:TextCode X="0" Y="6">VISIBLE CONTROL</o:TextCode></o:TextObject>';
const background = '<o:PathObject ID="4" Boundary="0 0 210 297" Fill="true" Stroke="false"><o:FillColor Value="255 255 255"/><o:AbbreviatedData>M 0 0 L 210 0 L 210 297 L 0 297 C</o:AbbreviatedData></o:PathObject>';
const image = '<o:ImageObject ID="3" Boundary="20 20 100 100" ResourceID="2"/>';
async function fixture(options = {}) {
  const zip = new JSZip();
  zip.file('OFD.xml', `<o:OFD xmlns:o="${ns}"><o:DocBody><o:DocRoot>Doc_0/Document.xml</o:DocRoot></o:DocBody></o:OFD>`);
  zip.file('Doc_0/Document.xml', `<o:Document xmlns:o="${ns}"><o:CommonData><o:PageArea><o:PhysicalBox>0 0 210 297</o:PhysicalBox></o:PageArea><o:DocumentRes>${options.resPath || 'DocumentRes.xml'}</o:DocumentRes>${options.common || ''}</o:CommonData><o:Pages><o:Page ID="1" BaseLoc="Pages/Content.xml"/></o:Pages>${options.documentExtra || ''}</o:Document>`);
  zip.file(`Doc_0/${options.resPath || 'DocumentRes.xml'}`, `<o:Res xmlns:o="${ns}" BaseLoc="${options.base || '.'}">${options.resources || '<o:Fonts><o:Font ID="2" FontName="Helvetica"/></o:Fonts>'}</o:Res>`);
  if (!options.missingPage) zip.file('Doc_0/Pages/Content.xml', options.page || `<o:Page xmlns:o="${options.namespace || ns}"><o:Content><o:Layer ID="9">${options.content ?? text}</o:Layer></o:Content></o:Page>`);
  for (const [name, bytes] of Object.entries(options.extra || {})) zip.file(name, bytes);
  return zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
}
const imageResources = '<o:MultiMedias><o:MultiMedia ID="2" Type="Image" Format="PNG"><o:MediaFile>Image.png</o:MediaFile></o:MultiMedia></o:MultiMedias>';

test('recognizes arbitrary namespace prefixes and preserves interleaved nested drawing order', async () => {
  const doc = await renderer.parse(await fixture({content:background + `<o:PageBlock ID="5">${text}${background.replace('ID="4"','ID="6"')}</o:PageBlock>` + text.replace('ID="3"','ID="7"')}));
  assert.equal(doc.pages.length, 1);
  assert.deepEqual(doc.pages[0].layers[0].objects.map(o => o.type), ['path','text','path','text']);
});
test('resolves BaseLoc relative to resource XML, not document directory', async () => {
  const png = await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
  const input = await fixture({content:image, resPath:'Resources/DocumentRes.xml', base:'../Assets', resources:imageResources, extra:{'Doc_0/Assets/Image.png':png}});
  const doc = await renderer.parse(input);
  assert.equal(doc.images.get('2').path, 'Doc_0/Assets/Image.png');
  assert.ok((await renderer.convert(input,{silent:true})).length > 500);
});
test('default namespace is equivalent and wrong URI is rejected', async () => {
  const normal = await fixture({page:`<Page xmlns="${ns}"><Content><Layer ID="9">${text.replaceAll('o:','')}</Layer></Content></Page>`});
  assert.equal((await renderer.parse(normal)).pages[0].layers[0].objects.length, 1);
  await assert.rejects(renderer.parse(await fixture({namespace:'https://example.invalid/not-ofd'})), {code:'OFD_INVALID_XML'});
});
test('missing page cannot silently produce a PDF blank page', async () => {
  await assert.rejects(renderer.convert(await fixture({missingPage:true}), {silent:true}), {code:'OFD_MISSING_PAGE'});
});
test('missing and undecodable declared images fail explicitly', async () => {
  await assert.rejects(renderer.convert(await fixture({content:image, resources:imageResources}), {silent:true}), {code:'OFD_MISSING_RESOURCE'});
  await assert.rejects(renderer.convert(await fixture({content:image, resources:imageResources, extra:{'Doc_0/Image.png':Buffer.from('not png')}}), {silent:true}), {code:'OFD_RENDER_FAILED'});
});
test('unhandled composite, clipping, and page annotations cannot be dropped', async () => {
  for (const options of [
    {content:'<o:CompositeObject ID="4" Boundary="0 0 10 10" ResourceID="8"/>'},
    {content:text.replace('<o:TextCode','<o:Clips/><o:TextCode')},
    {documentExtra:'<o:Annotations>Annotations.xml</o:Annotations>'}
  ]) await assert.rejects(renderer.parse(await fixture(options)), {code:'OFD_UNSUPPORTED_CONTENT'});
});
test('source blank pages are distinguished from content pages in inspection', async () => {
  const blank = await renderer.inspect(await fixture({content:''}));
  const nonblank = await renderer.inspect(await fixture());
  assert.equal(blank.pages[0].hasContent, false);
  assert.equal(nonblank.pages[0].hasContent, true);
  let inspected;
  await renderer.convert(await fixture(), {silent:true,onInspect:value=>{inspected=value;}});
  assert.equal(inspected.pageCount,1);
});
test('archive traversal, external paths, DTD and excessive deltas fail within finite limits', async () => {
  await assert.rejects(renderer.parse(await fixture({base:'../../../../escape',resources:imageResources,content:image})), {code:'OFD_INVALID_ARCHIVE'});
  await assert.rejects(renderer.parse(await fixture({base:'C:/Windows',resources:imageResources,content:image})), {code:'OFD_INVALID_ARCHIVE'});
  await assert.rejects(renderer.parse(await fixture({page:`<!DOCTYPE Page [<!ENTITY a "a">]><o:Page xmlns:o="${ns}"/>`})), {code:'OFD_INVALID_XML'});
  await assert.rejects(renderer.parse(await fixture({content:text.replace('X="0"','DeltaX="g 1000000000 1" X="0"')})), {code:'OFD_RESOURCE_LIMIT'});
});
test('white image, white paths, transparent and whitespace objects are legitimate blank content', async () => {
  const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  const white=await fixture({content:image,resources:imageResources,extra:{'Doc_0/Image.png':png}});
  for(const input of [white,await fixture({content:background}),await fixture({content:text.replace('Size="6"','Size="6" Alpha="0"')}),await fixture({content:text.replace('VISIBLE CONTROL','   ')})]) {
    const info=await renderer.inspect(input);
    assert.equal(info.pages[0].expectsVisibleContent,false);
    assert.ok((await renderer.convert(input,{silent:true})).length>500);
  }
});
test('foreground template order is preserved and missing templates are rejected',async()=>{
  const template=`<o:Page xmlns:o="${ns}"><o:Content><o:Layer ID="10">${background}</o:Layer></o:Content></o:Page>`;
  const input=await fixture({common:'<o:TemplatePage ID="8" BaseLoc="Tpl.xml" ZOrder="Foreground"/>',page:`<o:Page xmlns:o="${ns}"><o:Template TemplateID="8"/><o:Content><o:Layer ID="9">${text}</o:Layer></o:Content></o:Page>`,extra:{'Doc_0/Tpl.xml':template}});
  assert.deepEqual((await renderer.parse(input)).pages[0].layers.flatMap(l=>l.objects.map(o=>o.type)),['text','path']);
  await assert.rejects(renderer.parse(await fixture({page:`<o:Page xmlns:o="${ns}"><o:Template TemplateID="missing"/></o:Page>`})),{code:'OFD_MISSING_PAGE'});
});
test('namespace shadowing cannot smuggle same local names and incomplete path commands fail',async()=>{
  await assert.rejects(renderer.parse(await fixture({content:text.replace('<o:TextCode','<o:TextCode xmlns:o="urn:not-ofd"')})),{code:'OFD_INVALID_XML'});
  await assert.rejects(renderer.parse(await fixture({content:background.replace('M 0 0 L 210 0 L 210 297 L 0 297 C','M 0 0 L 2')})),{code:'OFD_INVALID_XML'});
});
test('repeated conversions preserve supported Chinese characters rather than question marks',{skip:process.platform !== 'win32'},async()=>{
  const input=await fixture({content:text.replace('VISIBLE CONTROL','飞鼠转换测试'),resources:'<o:Fonts><o:Font ID="2" FontName="SimHei"/></o:Fonts>'});
  for(let i=0;i<2;i++) assert.ok((await renderer.convert(input,{silent:true})).length>500);
});
test('semantic layer and template groups are ordered while same-group XML order is retained',async()=>{
  const template=`<o:Page xmlns:o="${ns}"><o:Content><o:Layer ID="10">${background}</o:Layer></o:Content></o:Page>`;
  const input=await fixture({common:'<o:TemplatePage ID="8" BaseLoc="Tpl.xml" ZOrder="Body"/>',page:`<o:Page xmlns:o="${ns}"><o:Template TemplateID="8"/><o:Content><o:Layer ID="9" Type="Foreground">${text}</o:Layer><o:Layer ID="11" Type="Body">${text}</o:Layer><o:Layer ID="12" Type="Background">${background}</o:Layer><o:Layer ID="13" Type="Body">${text}</o:Layer></o:Content></o:Page>`,extra:{'Doc_0/Tpl.xml':template}});
  assert.deepEqual((await renderer.parse(input)).pages[0].layers.map(l=>l.id),['12','10','11','13','9']);
});
test('explicit default attributes and basic inherited DrawParam retain valid text and paths',async()=>{
  const defaults=text.replace('Size="6"','Size="6" Weight="400" Italic="false" ReadDirection="0" CharDirection="0"');
  const resources='<o:Fonts><o:Font ID="2" FontName="Helvetica"/></o:Fonts><o:DrawParams><o:DrawParam ID="20"><o:FillColor Value="0 0 0"/></o:DrawParam><o:DrawParam ID="21" Relative="20" LineWidth="0.5"/></o:DrawParams>';
  const page=`<o:Page xmlns:o="${ns}"><o:Content><o:Layer ID="9" DrawParam="21">${defaults}${background}</o:Layer></o:Content></o:Page>`;
  assert.ok((await renderer.convert(await fixture({page,resources}),{silent:true})).length>500);
  const parsed=await renderer.parse(await fixture({page,resources}));
  assert.equal(parsed.pages[0].layers[0].objects[0].fillColor.value,'0 0 0');
  assert.equal(parsed.pages[0].layers[0].objects[1].fillColor.value,'255 255 255');
  assert.equal(parsed.pages[0].layers[0].objects[1].lineWidth,0.5);
});
test('fully transparent PNG with black stored RGB is legitimate blank content',async()=>{
  const png=await sharp({create:{width:8,height:8,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  assert.equal((await renderer.inspect(await fixture({content:image,resources:imageResources,extra:{'Doc_0/Image.png':png}}))).pages[0].expectsVisibleContent,false);
});
test('cancellation after parsing starts aborts long rendering before any result is returned',async()=>{
  const input=await fixture({content:Array.from({length:2000},(_,i)=>text.replace('ID="3"',`ID="${i+30}"`)).join('')});
  const controller=new AbortController();let started=false;let canceled=false;
  await assert.rejects(renderer.convert(input,{silent:true,signal:controller.signal,onInspect(){started=true;setImmediate(()=>{canceled=true;controller.abort();});}}),{code:'CONVERSION_CANCELED'});
  assert.equal(started,true);assert.equal(canceled,true);
});
test('standard S subpath-start consumes x y and retains a visible path',async()=>{
  const doc=await renderer.parse(await fixture({content:background.replace('M 0 0','S 0 0').replace('255 255 255','0 0 0')}));
  assert.deepEqual(doc.pages[0].layers[0].objects[0].commands[0],{type:'M',x:0,y:0});
});
test('repeated placement of one image reuses its PDF image stream',async()=>{
  const png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
  const content=Array.from({length:100},(_,i)=>image.replace('ID="3"',`ID="${i+30}"`)).join('');
  const bytes=await renderer.convert(await fixture({content,resources:imageResources,extra:{'Doc_0/Image.png':png}}),{silent:true});
  const {PDFDocument,PDFDict,PDFName}=require('pdf-lib');
  const pdf=await PDFDocument.load(bytes);
  const images=pdf.context.enumerateIndirectObjects().filter(([,obj])=>{const dict=obj instanceof PDFDict?obj:obj.dict;return dict?.get(PDFName.of('Subtype'))===PDFName.of('Image');});
  assert.equal(images.length,1);
});
test('DrawParam inheritance rejects cycles and page-scoped resources are available before drawing',async()=>{
  const cyclic='<o:Fonts><o:Font ID="2" FontName="Helvetica"/></o:Fonts><o:DrawParams><o:DrawParam ID="20" Relative="21"/><o:DrawParam ID="21" Relative="20"/></o:DrawParams>';
  await assert.rejects(renderer.parse(await fixture({content:text.replace('Size="6"','Size="6" DrawParam="20"'),resources:cyclic})),{code:'OFD_INVALID_XML'});
  const page=`<o:Page xmlns:o="${ns}"><o:PageRes>Res.xml</o:PageRes><o:Content><o:Layer ID="9" DrawParam="20">${text}</o:Layer></o:Content></o:Page>`;
  const res=`<o:Res xmlns:o="${ns}"><o:DrawParams><o:DrawParam ID="20"><o:FillColor Value="10 20 30"/></o:DrawParam></o:DrawParams></o:Res>`;
  assert.equal((await renderer.parse(await fixture({page,extra:{'Doc_0/Pages/Res.xml':res}}))).pages[0].layers[0].objects[0].fillColor.value,'10 20 30');
});
test('cumulative unique image pixel budget is checked before full pixel decoding',async()=>{
  // One compact valid 1 MP PNG copied under 101 distinct resource paths. Header
  // preflight rejects 101 MP without allocating their combined decoded pixels.
  const png=await sharp({create:{width:1000,height:1000,channels:3,background:'white'}}).png().toBuffer();
  const extra={};let content='',media='';
  for(let i=0;i<101;i++){
    extra[`Doc_0/Image${i}.png`]=png;
    media+=`<o:MultiMedia ID="${i+200}" Type="Image" Format="PNG"><o:MediaFile>Image${i}.png</o:MediaFile></o:MultiMedia>`;
    content+=`<o:ImageObject ID="${i+400}" Boundary="0 0 100 100" ResourceID="${i+200}"/>`;
  }
  await assert.rejects(renderer.parse(await fixture({content,resources:`<o:MultiMedias>${media}</o:MultiMedias>`,extra})),{code:'OFD_RESOURCE_LIMIT'});
});
module.exports = { fixture, ns, text, background, image, imageResources };

async function textPositions(content) {
  const { loadPdfjs } = require('../pdfjs');
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: await renderer.convert(await fixture({content}), {silent:true}),
    isEvalSupported:false, useSystemFonts:true });
  try {
    const pdf = await task.promise;
    const extracted = await (await pdf.getPage(1)).getTextContent();
    return extracted.items.filter(item => item.str?.trim()).map(item => ({
      text:item.str, x:item.transform[4], y:item.transform[5]
    }));
  } finally { await task.destroy(); }
}

test('omitted TextCode origins inherit the preceding origin across horizontal and vertical runs',async()=>{
  const wrap = codes => `<o:TextObject ID="3" Boundary="20 20 150 100" Font="2" Size="6" CTM="2 0 0 2 0 0">${codes}</o:TextObject>`;
  for (const [implicit,explicit] of [
    ['<o:TextCode X="0" Y="6" DeltaX="6">AB</o:TextCode><o:TextCode Y="18" DeltaX="6">CD</o:TextCode>',
      '<o:TextCode X="0" Y="6" DeltaX="6">AB</o:TextCode><o:TextCode X="0" Y="18" DeltaX="6">CD</o:TextCode>'],
    ['<o:TextCode X="0" Y="6" DeltaY="6">AB</o:TextCode><o:TextCode X="18" DeltaY="6">CD</o:TextCode>',
      '<o:TextCode X="0" Y="6" DeltaY="6">AB</o:TextCode><o:TextCode X="18" Y="6" DeltaY="6">CD</o:TextCode>'],
    ['<o:TextCode X="0" Y="6">AB</o:TextCode><o:TextCode Y="18">CD</o:TextCode>',
      '<o:TextCode X="0" Y="6">AB</o:TextCode><o:TextCode X="0" Y="18">CD</o:TextCode>']
  ]) assert.deepEqual(await textPositions(wrap(implicit)),await textPositions(wrap(explicit)));
});

test('DeltaY-only text stays in its column while default text keeps natural horizontal spacing',async()=>{
  const vertical = text.replace('X="0" Y="6">VISIBLE CONTROL','X="0" Y="6" DeltaY="6">ABC');
  const actual = await textPositions(vertical);
  assert.deepEqual(actual,await textPositions(vertical.replace('DeltaY="6"','DeltaY="6" DeltaX="0"')));
  assert.equal(actual.length,3);
  assert.ok(actual.every(item => item.x === actual[0].x));
  assert.ok(actual[0].y > actual[1].y && actual[1].y > actual[2].y);
  const horizontal = await textPositions(text.replace('VISIBLE CONTROL','ABC'));
  assert.equal(horizontal.length,1);
  assert.equal(horizontal[0].text,'ABC');
});
