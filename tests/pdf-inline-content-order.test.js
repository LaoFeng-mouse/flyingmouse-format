const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yazl = require('yazl');
const { convertPdfToDocx, validateNativePdfDocx } = require('../pdf');

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P='http://schemas.openxmlformats.org/package/2006/relationships';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const secondPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC','base64');
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const run=text=>`<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para=text=>`<w:p>${run(text)}</w:p>`;
const image=id=>`<w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r>`;
async function writePackage(filename, body, {images=[], alternate=false}={}) {
  let xml=`<w:document xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
  if(alternate)xml=xml.replaceAll('w:','word:').replace('xmlns:w=','xmlns:word=');
  const archive=new yazl.ZipFile();
  const entries=[
    ['word/document.xml',xml],
    ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels',`<Relationships xmlns="${P}"><Relationship Id="root" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels',`<Relationships xmlns="${P}">${images.map((bytes,i)=>`<Relationship Id="im${i}" Type="${R}/image" Target="media/${i}.png"/>`).join('')}</Relationships>`],
    ...images.map((bytes,i)=>[`word/media/${i}.png`,bytes])
  ];
  for(const [name,bytes]of entries)archive.addBuffer(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),name);
  archive.end();const chunks=[];for await(const chunk of archive.outputStream)chunks.push(chunk);
  await fs.writeFile(filename,Buffer.concat(chunks));
}
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fmf-inline-order-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,output:path.join(dir,'output.docx')};}

test('inline tokens preserve adjacent-run text, spaces, tabs, breaks and namespaces in XML order',async t=>{
  const {output}=await setup(t);
  await writePackage(output,`<w:p>${run('now')}${run('here')}${run(' ')}${run(' x ')}<w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>`,{alternate:true});
  const result=await validateNativePdfDocx(output,{includeInlineParagraphs:true});
  assert.deepEqual(result.inlineParagraphs,[[{text:'nowhere  x A\tB\nC'}]]);
  assert.ok(result.editableText.includes('now here'),'legacy extraction remains compatible');
});

test('inline tokens preserve exact paragraph and image order with payload hashes',async t=>{
  const {output}=await setup(t);
  await writePackage(output,`<w:p>${run('A')}${image('im1')}${run(' B ')}${image('im0')}${run('C')}</w:p>${para('again')}${para('again')}`,{images:[png,secondPng]});
  const result=await validateNativePdfDocx(output,{includeInlineParagraphs:true});
  assert.deepEqual(result.inlineParagraphs,[[{text:'A'},{imageSha256:sha(secondPng)},{text:' B '},{imageSha256:sha(png)},{text:'C'}],[{text:'again'}],[{text:'again'}]]);
});

test('inline tokens ignore empty section paragraphs but retain whitespace-only content and paragraph tab settings',async t=>{
  const {output}=await setup(t);
  await writePackage(output,`${para('before')}<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:p/><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run('  ')}<w:r><w:tab/><w:br/></w:r></w:p>${para('after')}`);
  const result=await validateNativePdfDocx(output,{includeInlineParagraphs:true});
  assert.deepEqual(result.inlineParagraphs,[[{text:'before'}],[{text:'  \t\n'}],[{text:'after'}]]);
});

test('inline tokens preserve runs interleaved with hyperlinks and decoded punctuation',async t=>{
  const {output}=await setup(t);
  await writePackage(output,`<w:p>${run('A ')}<w:hyperlink>${run('B&amp;&#x3002;')}</w:hyperlink>${run(' C &amp;#x3002;')}</w:p>`);
  const result=await validateNativePdfDocx(output,{includeInlineParagraphs:true});
  assert.deepEqual(result.inlineParagraphs,[[{text:'A B&。 C &#x3002;'}]]);
});

const failures=[
  {name:'lost punctuation',body:para('Keep，不得转卖禁止销售'),expected:[[{text:'Keep，不得转卖，禁止销售。'}]]},
  {name:'reversed paragraphs',body:para('Keep')+para('second')+para('first'),expected:[[{text:'Keep'}],[{text:'first'}],[{text:'second'}]]},
  {name:'lost repeated paragraph',body:para('Keep')+para('again'),expected:[[{text:'Keep'}],[{text:'again'}],[{text:'again'}]]},
  {name:'merged words split over XML runs',body:`<w:p>${run('Keep ')}${run('now')}${run('here')}</w:p>`,expected:[[{text:'Keep now here'}]]},
  {name:'changed case',body:para('Keep us'),expected:[[{text:'Keep US'}]]},
  {name:'swapped image payloads',body:`<w:p>${run('Keep')}${image('im1')}${image('im0')}</w:p>`,images:[png,secondPng],expected:[[{text:'Keep'},{imageSha256:sha(png)},{imageSha256:sha(secondPng)}]]}
];
for(const scenario of failures)test(`inline publication refuses ${scenario.name} and preserves an existing target`,async t=>{
  const {dir,output}=await setup(t);await fs.writeFile(output,'existing result');
  await assert.rejects(convertPdfToDocx('unused.pdf',output,[{pageNumber:1,rows:[['Keep']],imageCoverage:.01}],{
    docenginePath:null,
    convertInlineImagePdfToDocx:async({outputPath})=>{await writePackage(outputPath,scenario.body,{images:scenario.images||[]});return{warnings:[],expectedInlineParagraphs:scenario.expected};}
  }),{code:'PDF_DOCX_TEXT_COVERAGE_FAILED'});
  assert.equal(await fs.readFile(output,'utf8'),'existing result');
  assert.deepEqual(await fs.readdir(dir),['output.docx']);
});

test('inline publication accepts exact content despite harmless run splits',async t=>{
  const {output}=await setup(t);
  const expected=[[{text:'Keep now here，US。'},{imageSha256:sha(png)},{text:' done'}],[{text:'Again'}],[{text:'Again'}]];
  await convertPdfToDocx('unused.pdf',output,[{pageNumber:1,rows:[['Keep']],imageCoverage:.01}],{
    docenginePath:null,
    convertInlineImagePdfToDocx:async({outputPath})=>{
      await writePackage(outputPath,`<w:p>${run('Keep now')}${run(' here，US。')}${image('im0')}${run(' done')}</w:p>${para('Again')}${para('Again')}`,{images:[png]});
      return {warnings:[],expectedInlineParagraphs:expected};
    }
  });
  assert.deepEqual((await validateNativePdfDocx(output,{includeInlineParagraphs:true})).inlineParagraphs,expected);
});

test('image-only native validation requires the explicit inline option and an actual image reference',async t=>{
  const {output}=await setup(t);
  await writePackage(output,`<w:p>${image('im0')}</w:p>`,{images:[png]});
  for(const options of [{},{includeInlineParagraphs:true},{allowImageOnlyInline:true}]){
    await assert.rejects(validateNativePdfDocx(output,options),{code:'PDF_DOCX_NO_EDITABLE_CONTENT'});
  }
  const result=await validateNativePdfDocx(output,{includeInlineParagraphs:true,allowImageOnlyInline:true});
  assert.equal(result.hasEditableContent,false);
  assert.equal(result.editableText,'');
  assert.deepEqual(result.inlineParagraphs,[[{imageSha256:sha(png)}]]);
  await writePackage(output,'<w:p/>',{images:[png]});
  await assert.rejects(validateNativePdfDocx(output,{includeInlineParagraphs:true,allowImageOnlyInline:true}),{code:'PDF_DOCX_NO_EDITABLE_CONTENT'});
});

async function convertRasterized(output,body,result,images=[png]){
  return convertPdfToDocx('unused.pdf',output,[{pageNumber:1,rows:[['Source line']],imageCoverage:.01}],{
    docenginePath:null,
    convertInlineImagePdfToDocx:async({outputPath})=>{
      await writePackage(outputPath,body,{images});
      return {warnings:[],textCoveragePages:[],...result};
    }
  });
}
const rasterizedResult={rasterizedLineCount:1,hasEditableContent:false,expectedInlineParagraphs:[[{imageSha256:sha(png)}]]};

test('inline publication permits a fully rasterized visual line while reporting no editable content',async t=>{
  const {output}=await setup(t);
  const result=await convertRasterized(output,`<w:p>${image('im0')}</w:p>`,rasterizedResult);
  assert.equal(result.hasEditableContent,false);
  assert.equal(result.rasterizedLineCount,1);
  const actual=await validateNativePdfDocx(output,{includeInlineParagraphs:true,allowImageOnlyInline:true});
  assert.deepEqual(actual.inlineParagraphs,rasterizedResult.expectedInlineParagraphs);
});

const invalidImageOnlyContracts=[
  ['missing rasterized count',{rasterizedLineCount:undefined}],
  ['zero rasterized count',{rasterizedLineCount:0}],
  ['non-integer rasterized count',{rasterizedLineCount:.5}],
  ['string rasterized count',{rasterizedLineCount:'1'}],
  ['missing editable flag',{hasEditableContent:undefined}],
  ['claimed editable text',{hasEditableContent:true}],
  ['missing exact contract',{expectedInlineParagraphs:undefined}],
  ['empty exact contract',{expectedInlineParagraphs:[]}],
  ['no expected image',{expectedInlineParagraphs:[[{text:'Source line'}]]}],
  ['malformed image digest',{expectedInlineParagraphs:[[{imageSha256:'invalid'}]]}],
  ['extra token property',{expectedInlineParagraphs:[[{imageSha256:sha(png),text:''}]]}],
  ['malformed paragraph',{expectedInlineParagraphs:[null]}]
];
for(const [name,overrides] of invalidImageOnlyContracts)test(`image-only inline publication refuses ${name}`,async t=>{
  const {dir,output}=await setup(t);await fs.writeFile(output,'existing result');
  await assert.rejects(convertRasterized(output,`<w:p>${image('im0')}</w:p>`,{...rasterizedResult,...overrides}),{code:'PDF_DOCX_NO_EDITABLE_CONTENT'});
  assert.equal(await fs.readFile(output,'utf8'),'existing result');
  assert.deepEqual(await fs.readdir(dir),['output.docx']);
});

test('image-only inline publication still rejects replaced, reordered and omitted image tokens',async t=>{
  const {dir,output}=await setup(t);await fs.writeFile(output,'existing result');
  const expectedInlineParagraphs=[[{imageSha256:sha(png)}],[{imageSha256:sha(secondPng)}]];
  for(const body of [
    `<w:p>${image('im1')}</w:p><w:p>${image('im0')}</w:p>`,
    `<w:p>${image('im0')}</w:p><w:p>${image('im0')}</w:p>`,
    `<w:p>${image('im0')}</w:p>`
  ]){
    await assert.rejects(convertRasterized(output,body,{...rasterizedResult,rasterizedLineCount:2,expectedInlineParagraphs},[png,secondPng]),{code:'PDF_DOCX_TEXT_COVERAGE_FAILED'});
    assert.equal(await fs.readFile(output,'utf8'),'existing result');
    assert.deepEqual(await fs.readdir(dir),['output.docx']);
  }
});
