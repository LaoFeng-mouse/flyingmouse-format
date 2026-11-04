const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {extractPdfRowsByPage}=require('../pdf-table');
const {repairNativeMathXml,nativeFractionGeometry}=require('../pdf-native-math');

const BEFORE='Before the displayed equation in the source document.';
const AFTER='After the equation, the original prose remains editable.';
const paragraph=text=>'<w:p><w:r><w:t xml:space="preserve">'+text+'</w:t></w:r></w:p>';
const document=body=>'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>';
async function fixture(t,{scalar=false,heading=false,negative=false,rule=false,nested=false,table=false,tight=false,wide=false,paired=false,vectorMinus=false,duplicateSource=false,standalone=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fm-math-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(BEFORE,{x:40,y:720,size:12,font});page.drawText(AFTER,{x:40,y:420,size:12,font});
  const numerator=scalar?'1':heading?'Sales report':'a + b',denominator=scalar?'2':heading?'Current month':'c - d';
  const width=wide?100:scalar?18:heading?100:60,left=180-width/2,center=wide?156:180;
  if(vectorMinus){
    page.drawText('x = a',{x:100,y:495,size:12,font});page.drawText('b',{x:151,y:495,size:12,font});
    page.drawLine({start:{x:138,y:499},end:{x:147,y:499},thickness:.8});
  }
  else if(negative)page.drawText('x = a - b - c',{x:130,y:500,size:12,font});
  else if(rule) {
    page.drawText('Ordinary document heading',{x:40,y:520,size:12,font});
    page.drawLine({start:{x:40,y:514},end:{x:350,y:514},thickness:1});
    page.drawText('Normal prose below the rule is still prose.',{x:40,y:494,size:12,font});
  } else if(nested) {
    page.drawText('x =',{x:145,y:495,size:10,font});
    page.drawLine({start:{x:175,y:500},end:{x:205,y:500},thickness:1});
    page.drawLine({start:{x:182,y:515},end:{x:198,y:515},thickness:1});
    page.drawText('a',{x:187,y:522,size:10,font});page.drawText('b',{x:187,y:503,size:10,font});page.drawText('c',{x:187,y:488,size:10,font});
  } else {
    if(!scalar&&!heading&&!standalone)page.drawText('x =',{x:left-32,y:495,size:12,font});
    page.drawText(numerator,{x:center-font.widthOfTextAtSize(numerator,12)/2,y:507,size:12,font});
    page.drawLine({start:{x:left,y:500},end:{x:left+width,y:500},thickness:1});
    page.drawText(denominator,{x:center-font.widthOfTextAtSize(denominator,12)/2,y:tight?489:480,size:12,font});
    if(table)for(const x of [left,left+width])page.drawLine({start:{x,y:474},end:{x,y:527},thickness:1});
    if(paired||duplicateSource){
      page.drawText(duplicateSource?'x =':'z =',{x:308,y:495,size:12,font});page.drawText(duplicateSource?'a + b':'E',{x:346,y:507,size:12,font});
      page.drawLine({start:{x:340,y:500},end:{x:400,y:500},thickness:1});page.drawText(duplicateSource?'c - d':'F',{x:346,y:480,size:12,font});
    }
  }
  const input=path.join(root,'source.pdf');await fs.writeFile(input,await pdf.save());
  return {input,pages:await extractPdfRowsByPage(input),numerator,denominator};
}

test('native fraction geometry restores editable OMML and source prose order from flattened engine text',async t=>{
  const {input,pages}=await fixture(t);
  const original=document(paragraph(BEFORE)+paragraph(AFTER+' x = a + b c - d'));
  const result=await repairNativeMathXml(input,original,pages);
  assert.equal(result.repairedCount,1);assert.deepEqual(result.pageNumbers,[1]);
  assert.match(result.xml,/<m:f>.*?<m:num>.*?<m:t[^>]*>a \+ b<\/m:t>.*?<m:den>.*?<m:t[^>]*>c - d<\/m:t>/s);
  assert.ok(result.xml.indexOf(BEFORE)<result.xml.indexOf('<m:f>'));
  assert.ok(result.xml.indexOf('<m:f>')<result.xml.indexOf(AFTER));
  assert.equal((result.xml.match(/>x = /g)||[]).length,1);
  const repeated=await repairNativeMathXml(input,result.xml,pages);
  assert.equal(repeated.xml,result.xml);assert.equal(repeated.repairedCount,0);
});

test('standalone numeric fractions use source bar geometry, not digit-string splitting',async t=>{
  const {input,pages}=await fixture(t,{scalar:true});
  const original=document(paragraph(BEFORE)+paragraph('1 2')+paragraph(AFTER));
  const result=await repairNativeMathXml(input,original,pages);
  assert.equal(result.repairedCount,1);assert.match(result.xml,/<m:num>.*?>1<\/m:t>.*?<m:den>.*?>2<\/m:t>/s);
});

test('a standalone compound fraction does not require an adjacent equals sign',async t=>{
  const {input,pages}=await fixture(t,{standalone:true});
  const original=document(paragraph(BEFORE)+paragraph('a + b c - d')+paragraph(AFTER));
  const result=await repairNativeMathXml(input,original,pages);assert.equal(result.repairedCount,1);
  assert.match(result.xml,/<m:num>.*?>a \+ b<\/m:t>.*?<m:den>.*?>c - d<\/m:t>/s);
});

test('font-size boxes crossing the bar and left-aligned operands in a wider bar remain fractions',async t=>{
  for(const options of [{scalar:true,tight:true},{wide:true}]){
    const {input,pages}=await fixture(t,options),original=document(paragraph(BEFORE)+paragraph(options.scalar?'1 2':'x = a + b c - d')+paragraph(AFTER));
    assert.equal((await repairNativeMathXml(input,original,pages)).repairedCount,1);
  }
});

test('side-by-side fractions match whole source operand nodes across serialized visual rows',async t=>{
  const {input,pages}=await fixture(t,{paired:true});
  const row=(a,b)=>'<w:p><w:r><w:t>'+a+'</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>'+b+'</w:t></w:r></w:p>';
  const original=document(paragraph(BEFORE)+row('a + b','E')+row('x =','z =')+row('c - d','F')+paragraph(AFTER));
  const result=await repairNativeMathXml(input,original,pages);
  assert.equal(result.repairedCount,2);assert.match(result.xml,/<m:t[^>]*>E<\/m:t>/);
  assert.ok(result.xml.indexOf(BEFORE)<result.xml.indexOf('<m:f>'));assert.ok(result.xml.lastIndexOf('</m:f>')<result.xml.indexOf(AFTER));
});

test('a source vector subtraction sign between native equation terms remains visible and editable',async t=>{
  const {input,pages}=await fixture(t,{vectorMinus:true}),original=document(paragraph(BEFORE)+paragraph('x = a b')+paragraph(AFTER));
  const result=await repairNativeMathXml(input,original,pages);
  assert.match(result.xml,/x = a[^<]*−[^<]*b/);assert.equal(result.operatorCount,1);
  assert.equal((await repairNativeMathXml(input,result.xml,pages)).xml,result.xml);
});

test('ordinary heading rules, rules between prose headings, and minus signs are not fractions',async t=>{
  for(const options of [{heading:true},{negative:true},{rule:true},{scalar:true,table:true}]) {
    const {input,pages}=await fixture(t,options),original=document(paragraph('Unchanged original producer text'));
    assert.equal((await nativeFractionGeometry(input,pages)).length,0,JSON.stringify(options));
    assert.deepEqual(await repairNativeMathXml(input,original,pages),{xml:original,repairedCount:0,pageNumbers:[]});
  }
});

test('recognized fractions with duplicated flattened text or ambiguous source anchors fail closed',async t=>{
  const {input,pages}=await fixture(t);
  for(const xml of [document(paragraph(BEFORE)+paragraph('x = a + b c - d')+paragraph('x = a + b c - d')+paragraph(AFTER)),
    document(paragraph(BEFORE)+paragraph(BEFORE)+paragraph('x = a + b c - d')+paragraph(AFTER)),
    document(paragraph(BEFORE)+paragraph('x = a + b')+paragraph(AFTER))]) {
    await assert.rejects(repairNativeMathXml(input,xml,pages),{code:'PDF_NATIVE_MATH_UNVERIFIED'});
  }
});

test('one output expression cannot certify two identical source fractions',async t=>{
  const {input,pages}=await fixture(t,{duplicateSource:true});
  const original=document(paragraph(BEFORE)+paragraph('x = a + b c - d')+paragraph(AFTER));
  await assert.rejects(repairNativeMathXml(input,original,pages),{code:'PDF_NATIVE_MATH_UNVERIFIED'});
});

test('nested source fractions are not silently flattened by the single-level repair',async t=>{
  const {input,pages}=await fixture(t,{nested:true});
  await assert.rejects(nativeFractionGeometry(input,pages),{code:'PDF_NATIVE_MATH_UNVERIFIED'});
});

test('math repair propagates cancellation before reading source content',async t=>{
  const {input,pages}=await fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(repairNativeMathXml(input,'',pages,{signal:controller.signal}),{code:'CONVERSION_CANCELED'});
});

test('empty, blank, and OCR-only pages do not reopen a nonexistent PDF',async()=>{
  const original=document(paragraph('Editable OCR text'));
  for(const pages of [[],[{pageNumber:1,ocr:true,lines:[{text:'OCR text'}]}],[{pageNumber:1,blank:true,lines:[]}]]){
    assert.deepEqual(await nativeFractionGeometry('nonexistent-native-math-input.pdf',pages),[]);
    assert.deepEqual(await repairNativeMathXml('nonexistent-native-math-input.pdf',original,pages),{xml:original,repairedCount:0,pageNumbers:[]});
  }
});
