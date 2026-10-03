// Restore a narrow, geometrically proved class of native PDF fractions.
// Numerator/denominator membership comes from source coordinates, never from
// guessing a flattened expression. Ambiguous confirmed fractions fail closed.
const fs = require('node:fs/promises');
const { loadPdfjs } = require('./pdfjs');
const { parseXmlToJson } = require('./xml-json');
const { throwIfCanceled } = require('./conversion-cancellation');

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MATH = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const EPS = .15;
const compact = value => String(value || '').replace(/\s/gu, '');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function unverified() {
  const error = new Error('A native PDF mathematical expression could not be reconstructed without changing its meaning.');
  error.code = 'PDF_NATIVE_MATH_UNVERIFIED';
  error.messages = { zhCN: '已发现原生数学公式，但暂不能可靠保留其结构；已停止导出，避免产生含义错误的公式。',
    enUS: error.message };
  return error;
}
const finite = (value, length) => (Array.isArray(value) || ArrayBuffer.isView(value))
  && value.length === length && Array.from(value).every(Number.isFinite);
const multiply = (a,b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const axis = m => finite(m,6) && Math.abs(m[1])<1e-7 && Math.abs(m[2])<1e-7;
const boxOf = (m,b) => { const x=[m[0]*b[0]+m[4],m[0]*b[2]+m[4]],y=[m[3]*b[1]+m[5],m[3]*b[3]+m[5]];
  return [Math.min(...x),Math.min(...y),Math.max(...x),Math.max(...y)]; };
const contains = (outer,inner) => outer && inner[0]>=outer[0]-EPS && inner[1]>=outer[1]-EPS
  && inner[2]<=outer[2]+EPS && inner[3]<=outer[3]+EPS;
const intersects = (a,b) => Math.min(a[2],b[2])-Math.max(a[0],b[0])>EPS && Math.min(a[3],b[3])-Math.max(a[1],b[1])>EPS;

function pathBounds(args) {
  if (!finite(args?.[2],4) || !Array.isArray(args?.[1]) || args[1].length!==1) return null;
  const values=Array.from(args[1][0]||[]),points=[];
  if (values.length>10_000) return null;
  let active=false, closed=false;
  for(let i=0;i<values.length;) {
    const op=values[i++];
    if(op===4){if(!active)return null;closed=true;continue;}
    if(![0,1].includes(op)||i+1>=values.length||op===1&&!active)return null;
    const x=values[i++],y=values[i++];if(!Number.isFinite(x)||!Number.isFinite(y))return null;
    points.push([x,y]);active=true;
  }
  if(points.length<2)return null;
  const box=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  if(box.some((n,i)=>Math.abs(n-args[2][i])>EPS))return null;
  return {box,closed,points};
}

function fractionBars(operators, OPS, viewport) {
  let state={matrix:Array.from(viewport.transform),width:1,clip:[0,0,viewport.width,viewport.height],visible:true};
  const stack=[],bars=[],verticals=[];let clipping=false, unknown=false;
  for(let i=0;i<operators.fnArray.length;i++) {
    const op=operators.fnArray[i],args=operators.argsArray[i]||[];
    if(op===OPS.save){stack.push({...state,matrix:state.matrix.slice(),clip:state.clip?.slice()});continue;}
    if(op===OPS.restore){if(!stack.length){unknown=true;continue;}state=stack.pop();continue;}
    if(op===OPS.transform){if(!finite(args,6)){unknown=true;continue;}state.matrix=multiply(state.matrix,args);continue;}
    if(op===OPS.setLineWidth){state.width=Number(args[0]);continue;}
    if(op===OPS.setTextRenderingMode&&![0,1,2].includes(args[0]))unknown=true;
    if(op===OPS.setGState && !Array.isArray(args[0]))unknown=true;
    if(op===OPS.setGState && Array.isArray(args[0]) && args[0].some(([key,value])=>
      ['CA','ca'].includes(key)&&value!==1 || key==='SMask'&&value!==false&&value!=='None'
      || key==='BM'&&!['Normal','source-over'].includes(value)))unknown=true;
    if(op===OPS.clip||op===OPS.eoClip){clipping=true;continue;}
    if(op!==OPS.constructPath)continue;
    const path=pathBounds(args);
    if(!path||!axis(state.matrix)){if(clipping){unknown=true;clipping=false;}continue;}
    const box=boxOf(state.matrix,path.box);
    if(clipping) {
      clipping=false;
      const corners=new Set(path.points.map(p=>p.join(',')));
      if(args[0]!==OPS.endPath||!path.closed||corners.size!==4
        ||path.points.some(p=>![path.box[0],path.box[2]].includes(p[0])||![path.box[1],path.box[3]].includes(p[1]))) {unknown=true;continue;}
      state.clip=state.clip&&[Math.max(state.clip[0],box[0]),Math.max(state.clip[1],box[1]),Math.min(state.clip[2],box[2]),Math.min(state.clip[3],box[3])];
      continue;
    }
    const stroke=[OPS.stroke,OPS.closeStroke].includes(args[0]);
    const fill=[OPS.fill,OPS.eoFill].includes(args[0]);
    if(!stroke&&!fill)continue;
    // A short table-cell edge between two numbers is not a fraction bar.
    // Collect its attached vertical borders before checking horizontal bars.
    if(box[2]-box[0]<=2.5&&box[3]-box[1]>=4&&contains(state.clip,box))verticals.push(box.slice());
    if(stroke) {
      if(!Number.isFinite(state.width)||state.width<0||box[3]-box[1]>EPS)continue;
      const width=Math.max(.2,state.width*Math.max(Math.abs(state.matrix[0]),Math.abs(state.matrix[3])));
      box[1]-=width/2;box[3]+=width/2;
    } else if(!path.closed)continue;
    const width=box[2]-box[0],height=box[3]-box[1];
    if(width>=4&&width<=180&&height>0&&height<=2.5&&width>=height*6&&contains(state.clip,box))bars.push({bbox:box,clip:state.clip.slice()});
  }
  return {bars:bars.filter(bar=>!verticals.some(edge=>edge[0]<=bar.bbox[2]+1&&edge[2]>=bar.bbox[0]-1
    &&edge[1]<=bar.bbox[3]+1&&edge[3]>=bar.bbox[1]-1)),unknown:unknown||Boolean(stack.length)||clipping};
}

const bounds = items => [Math.min(...items.map(i=>i.bbox[0])),Math.min(...items.map(i=>i.bbox[1])),
  Math.max(...items.map(i=>i.bbox[2])),Math.max(...items.map(i=>i.bbox[3]))];
const lineText = items => items.slice().sort((a,b)=>a.x-b.x).map(i=>i.text).join(' ');
function geometryFractions(page, bars, styles={}) {
  const items=(page.lines||[]).flatMap(line=>line.items||[]).filter(item=>compact(item.text)&&finite(item.bbox,4));
  const fractions=[];
  for(const candidate of bars) {
    const bar=candidate.bbox;
    const width=bar[2]-bar[0],middle=(bar[1]+bar[3])/2;
    const inside=items.filter(i=>i.bbox[0]>=bar[0]-2&&i.bbox[2]<=bar[2]+2);
    // The extractor's box uses the full font size, not the glyph ascent.
    // A denominator's nominal box may cross the bar although its baseline and
    // actual font ascent put the printed glyph entirely beneath that bar.
    const above=inside.filter(i=>i.y<=middle-i.height*.1&&middle-i.y<=i.height*1.2);
    const below=inside.filter(i=>i.y>=middle+i.height*.5&&i.y-middle<=i.height*1.8);
    if(!above.length||!below.length)continue;
    const nearestAbove=Math.max(...above.map(i=>i.y)),nearestBelow=Math.min(...below.map(i=>i.y));
    const numerator=above.filter(i=>Math.abs(i.y-nearestAbove)<=Math.min(2,i.height*.15));
    const denominator=below.filter(i=>Math.abs(i.y-nearestBelow)<=Math.min(2,i.height*.15));
    const n=bounds(numerator),d=bounds(denominator),height=Math.max(...[...numerator,...denominator].map(i=>i.height));
    const baselineItems=items.filter(i=>i.bbox[1]<middle&&i.bbox[3]>middle
      &&i.y>=bar[3]-EPS&&i.y<=bar[3]+height*.8);
    const prefix=baselineItems.filter(i=>i.bbox[2]<=bar[0]+EPS&&bar[0]-i.bbox[2]<=height*3);
    const suffix=baselineItems.filter(i=>i.bbox[0]>=bar[2]-EPS&&i.bbox[0]-bar[2]<=height*3);
    const numeratorText=lineText(numerator),denominatorText=lineText(denominator);
    const prefixText=lineText(prefix),suffixText=lineText(suffix);
    // Geometry assigns the two operands. Additional mathematical evidence
    // distinguishes this narrow repair from a rule between prose headings.
    // It never invents an operand or parses flattened digits into a fraction.
    const scalar=text=>/^[+\-−]?(?:\d+(?:[.,]\d+)?|[\p{L}])$/u.test(compact(text));
    const shortExpression=text=>scalar(text)||/^[+\-−]?[\p{L}\d.]+(?:[+\-−*/×÷][\p{L}\d.]+)+$/u.test(compact(text))
      &&[...compact(text).matchAll(/\p{L}+/gu)].every(match=>match[0].length<=2);
    const equation=/[=≈≃≠<>≤≥∝∈]/u.test(prefixText+suffixText);
    if(!equation&&!(shortExpression(numeratorText)&&shortExpression(denominatorText)))continue;
    if(width>height*12||bar[1]-n[3]<height*.08)throw unverified();
    if(!equation&&(Math.min(n[2]-n[0],d[2]-d[0])<width*.3
      ||Math.abs((n[0]+n[2])/2-(bar[0]+bar[2])/2)>Math.max(height*.35,width*.2)
      ||Math.abs((d[0]+d[2])/2-(bar[0]+bar[2])/2)>Math.max(height*.35,width*.2)))throw unverified();
    const selected=[...prefix,...numerator,...denominator,...suffix];
    const bbox=bounds(selected);
    const extra=items.filter(i=>!selected.includes(i)&&intersects(i.bbox,bbox));
    const printedBoxes=selected.map(item=>{
      const metrics=styles[String(item.fontName).replace(/^g_d\d+_/, '')];
      return metrics&&Number.isFinite(metrics.ascent)&&Number.isFinite(metrics.descent)
        ? [item.bbox[0],item.y-item.height*metrics.ascent,item.bbox[2],item.y-item.height*metrics.descent]
        : item.bbox;
    });
    if(extra.length||printedBoxes.some(box=>!contains(candidate.clip,box))
      ||selected.some(i=>Math.abs(i.height-height)>height*.2))throw unverified();
    const before=(page.lines||[]).filter(line=>finite(line.bbox,4)&&line.bbox[3]<bbox[1]-EPS&&compact(line.text).length>=8).at(-1);
    const after=(page.lines||[]).find(line=>finite(line.bbox,4)&&line.bbox[1]>bbox[3]+EPS&&compact(line.text).length>=8);
    fractions.push({pageNumber:page.pageNumber,bar,bbox,items:selected,height,
      numerator:numeratorText,denominator:denominatorText,prefix:prefixText,suffix:suffixText,
      before:before?.text||'',after:after?.text||''});
  }
  if(fractions.some(f=>bars.some(other=>other.bbox!==f.bar
    &&Math.min(other.bbox[2],f.bar[2])-Math.max(other.bbox[0],f.bar[0])>EPS
    &&other.bbox[1]<f.bbox[3]+f.height*1.2&&other.bbox[3]>f.bbox[1]-f.height*1.2)))throw unverified();
  if(fractions.some((f,i)=>fractions.slice(i+1).some(other=>intersects(f.bbox,other.bbox)
    ||f.items.some(item=>other.items.includes(item)))))throw unverified();
  return fractions;
}

function geometryOperators(page,bars,fractions){
  const items=(page.lines||[]).flatMap(line=>line.items||[]).filter(item=>compact(item.text)&&finite(item.bbox,4));
  const operators=[];
  for(const candidate of bars){
    const bar=candidate.bbox;if(fractions.some(f=>f.bar===bar))continue;
    const middle=(bar[1]+bar[3])/2;
    const atBaseline=item=>item.y>=middle+item.height*.15&&item.y<=middle+item.height*.65;
    const left=items.filter(i=>atBaseline(i)&&i.bbox[2]<=bar[0]+EPS&&bar[0]-i.bbox[2]<=i.height*1.2).sort((a,b)=>b.bbox[2]-a.bbox[2])[0];
    const right=items.filter(i=>atBaseline(i)&&i.bbox[0]>=bar[2]-EPS&&i.bbox[0]-bar[2]<=i.height*1.2).sort((a,b)=>a.bbox[0]-b.bbox[0])[0];
    if(!left||!right)continue;
    const height=Math.max(left.height,right.height),width=bar[2]-bar[0];
    const line=items.filter(i=>Math.abs(i.y-left.y)<=height*.1);
    if(!/[=≈≃≠<>≤≥∝∈]/u.test(line.map(i=>i.text).join('')))continue;
    if(Math.abs(left.y-right.y)>height*.1||Math.abs(left.height-right.height)>height*.2
      ||width<height*.3||width>height*1.25||bar[3]-bar[1]>height*.12
      ||bars.some(other=>other.bbox!==bar&&Math.min(other.bbox[2],bar[2])-Math.max(other.bbox[0],bar[0])>EPS
        &&Math.abs((other.bbox[1]+other.bbox[3])/2-middle)<height*.5))throw unverified();
    operators.push({pageNumber:page.pageNumber,left:left.text,right:right.text,bar});
  }
  return operators;
}

async function nativeMathGeometry(inputPath,pages,{signal}={}) {
  throwIfCanceled(signal);
  const candidates=(pages||[]).filter(source=>source&&!source.ocr&&!source.blank&&source.lines?.length);
  if(!candidates.length)return {fractions:[],operators:[]};
  const lib=await loadPdfjs();let task;
  const cancel=()=>{if(task)void task.destroy().catch(()=>{});};
  try {
    task=lib.getDocument({data:new Uint8Array(await fs.readFile(inputPath)),isEvalSupported:false,disableFontFace:true,
      useSystemFonts:true,stopAtErrors:true});signal?.addEventListener('abort',cancel,{once:true});throwIfCanceled(signal);
    const pdf=await task.promise,fractionResult=[],operatorResult=[];
    for(const source of candidates) {
      throwIfCanceled(signal);
      const page=await pdf.getPage(source.pageNumber);
      try {
        const proof=fractionBars(await page.getOperatorList(),lib.OPS,page.getViewport({scale:1}));
        const textContent=await page.getTextContent();
        const styles=Object.fromEntries(Object.entries(textContent.styles||{}).map(([name,style])=>[name.replace(/^g_d\d+_/, ''),style]));
        const fractions=geometryFractions(source,proof.bars,styles);
        const operators=geometryOperators(source,proof.bars,fractions);
        if((fractions.length||operators.length)&&proof.unknown)throw unverified();
        fractionResult.push(...fractions);operatorResult.push(...operators);
      } finally {page.cleanup();}
    }
    // Repeated identical source expressions cannot be assigned to native
    // output occurrences uniquely by this repair. Do not reuse one restored
    // formula or one minus sign as evidence for several source occurrences.
    const fractionKeys=fractionResult.map(f=>[f.prefix,f.numerator,f.denominator,f.suffix].map(compact).join('\u0000'));
    const operatorKeys=operatorResult.map(o=>compact(o.left)+'\u0000'+compact(o.right));
    if(new Set(fractionKeys).size!==fractionKeys.length||new Set(operatorKeys).size!==operatorKeys.length)throw unverified();
    return {fractions:fractionResult,operators:operatorResult};
  } finally {signal?.removeEventListener('abort',cancel);if(task)await task.destroy().catch(()=>{});throwIfCanceled(signal);}
}

async function nativeFractionGeometry(inputPath,pages,options){return (await nativeMathGeometry(inputPath,pages,options)).fractions;}

function paragraphs(xml) {
  // Native engine serialization is w:-prefixed. Do not rewrite another XML
  // producer or complex descendants where text can be hidden or conditional.
  if(!new RegExp(`<w:document\\b[^>]*xmlns:w=["']${WORD}["']`).test(xml)
    ||(xml.match(/\bxmlns:w\s*=/g)||[]).length!==1)throw unverified();
  const body=/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);if(!body)throw unverified();
  const result=[],stack=[];let current;
  const offset=body.index+body[0].indexOf('>')+1;
  const tags=/<!--[\s\S]*?-->|<\/?[A-Za-z_][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
  for(const token of body[1].matchAll(tags)) {
    if(token[0].startsWith('<!--'))continue;
    const name=/^<\/?([^\s/>]+)/.exec(token[0])[1],close=token[0].startsWith('</'),empty=token[0].endsWith('/>');
    if(close)stack.pop();else if(!stack.length&&name==='w:p')current={start:offset+token.index};
    if(!close&&!empty)stack.push(name);
    if((close||empty)&&!stack.length&&current) {
      const end=offset+token.index+token[0].length,part=xml.slice(current.start,end);
      const nodes=[...part.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match=>({
        start:current.start+match.index,end:current.start+match.index+match[0].length,
        text:String(parseXmlToJson('<text>'+match[1]+'</text>').text||'') }));
      result.push({...current,end,part,nodes,plain:nodes.map(n=>n.text).join(''),complex:/<w:(?:drawing|pict|hyperlink|object|del|ins|fldChar|instrText|vanish|webHidden|txbxContent)\b/.test(part)});
      current=null;
    }
  }
  return result;
}

function mathXml(fraction) {
  const run=text=>text?'<m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="'+Math.round(fraction.height*2)+'"/></w:rPr><m:t xml:space="preserve">'+escape(text)+'</m:t></m:r>':'';
  return '<w:p><w:pPr><w:spacing w:before="80" w:after="80" w:line="240" w:lineRule="auto"/></w:pPr>'
    +'<m:oMathPara xmlns:m="'+MATH+'"><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>'
    +run(fraction.prefix?fraction.prefix+' ':'')+'<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>'+run(fraction.numerator)
    +'</m:num><m:den>'+run(fraction.denominator)+'</m:den></m:f>'+run(fraction.suffix?' '+fraction.suffix:'')
    +'</m:oMath></m:oMathPara></w:p>';
}

function repairFractionXml(documentXml, fractions) {
  let xml=documentXml;
  for(const fraction of fractions) {
    const mathText=value=>[...String(value).matchAll(/<m:t\b[^>]*>([\s\S]*?)<\/m:t>/g)]
      .map(match=>String(parseXmlToJson('<text>'+match[1]+'</text>').text||'')).join('');
    const existing=[...xml.matchAll(/<m:oMathPara\b[^>]*>[\s\S]*?<\/m:oMathPara>/g)].filter(match=>{
      const numerator=/<m:num>([\s\S]*?)<\/m:num>/.exec(match[0]),denominator=/<m:den>([\s\S]*?)<\/m:den>/.exec(match[0]);
      return (match[0].match(/<m:f>/g)||[]).length===1&&/<m:type m:val="bar"\/>/.test(match[0])
        &&numerator&&denominator&&compact(mathText(numerator[1]))===compact(fraction.numerator)
        &&compact(mathText(denominator[1]))===compact(fraction.denominator)
        &&compact(mathText(match[0]))===compact(fraction.prefix+fraction.numerator+fraction.denominator+fraction.suffix);
    });
    if(existing.length) {
      if(existing.length!==1)throw unverified();
      const body=paragraphs(xml),before=body.filter(p=>fraction.before&&compact(p.plain).includes(compact(fraction.before))),
        after=body.filter(p=>fraction.after&&compact(p.plain).includes(compact(fraction.after)));
      if(fraction.before&&(before.length!==1||before[0].end>existing[0].index)
        ||fraction.after&&(after.length!==1||after[0].start<existing[0].index+existing[0][0].length))throw unverified();
      continue;
    }
    const paras=paragraphs(xml),nodes=paras.flatMap(p=>p.nodes.map(n=>({...n,paragraph:p}))),map=[];let text='';
    nodes.forEach((node,index)=>{for(let offset=0;offset<node.text.length;offset++)if(!/\s/u.test(node.text[offset])){
      text+=node.text[offset];map.push({node:index,offset});}});
    const variants=new Set([
      compact(fraction.prefix+fraction.numerator+fraction.denominator+fraction.suffix),
      compact(fraction.numerator+fraction.prefix+fraction.denominator+fraction.suffix)
    ]);
    const matches=[];
    for(const variant of variants)for(let index=text.indexOf(variant);index>=0;index=text.indexOf(variant,index+1))matches.push({index,length:variant.length});
    const spans=[];
    if(matches.length===1){
      const match=matches[0];spans.push({first:map[match.index],last:map[match.index+match.length-1]});
    }else if(!matches.length){
      // Side-by-side equations are often serialized one visual row at a time.
      // Match whole source operands to whole native text nodes only; never
      // split an arbitrary character string to manufacture those operands.
      const used=new Set();
      for(const component of [fraction.prefix,fraction.numerator,fraction.denominator,fraction.suffix].filter(compact)){
        const indexes=nodes.map((node,index)=>compact(node.text)===compact(component)?index:-1).filter(index=>index>=0);
        if(indexes.length!==1||used.has(indexes[0]))throw unverified();
        const index=indexes[0];used.add(index);
        spans.push({first:{node:index,offset:0},last:{node:index,offset:nodes[index].text.length-1}});
      }
    }else throw unverified();
    const changes=[];
    for(const {first,last} of spans){
      if(!first||!last||nodes.slice(first.node,last.node+1).some(n=>n.paragraph.complex))throw unverified();
      for(let index=first.node;index<=last.node;index++){
        const node=nodes[index],start=index===first.node?first.offset:0,end=index===last.node?last.offset+1:node.text.length;
        changes.push({start:node.start,end:node.end,text:'<w:t xml:space="preserve">'+escape(node.text.slice(0,start)+node.text.slice(end))+'</w:t>'});
      }
    }
    for(const change of changes.sort((a,b)=>b.start-a.start))xml=xml.slice(0,change.start)+change.text+xml.slice(change.end);
    const remaining=paragraphs(xml);
    const findAnchor=anchor=>{if(!anchor)return [];const key=compact(anchor);return remaining.filter(p=>compact(p.plain).includes(key));};
    const before=findAnchor(fraction.before),after=findAnchor(fraction.after);
    if(before.length>1||after.length>1||(!before.length&&!after.length)
      ||fraction.before&&!before.length||fraction.after&&!after.length
      ||before.length&&after.length&&before[0].end>after[0].start)throw unverified();
    const insert=after.length?after[0].start:before[0].end;
    xml=xml.slice(0,insert)+mathXml(fraction)+xml.slice(insert);
  }
  return xml;
}

function repairOperatorXml(documentXml,operators){
  let xml=documentXml,operatorCount=0;
  for(const operator of operators){
    const body=paragraphs(xml),nodes=body.flatMap(p=>p.nodes.map(n=>({...n,paragraph:p}))),map=[];let text='';
    nodes.forEach((node,index)=>{for(let offset=0;offset<node.text.length;offset++)if(!/\s/u.test(node.text[offset])){
      text+=node.text[offset];map.push({node:index,offset});}});
    const left=compact(operator.left),right=compact(operator.right),key=left+right;
    const existing=[left+'−'+right,left+'-'+right].filter(value=>text.includes(value));
    if(existing.length){if(existing.length!==1||text.indexOf(existing[0])!==text.lastIndexOf(existing[0]))throw unverified();continue;}
    const start=text.indexOf(key);
    if(start<0||start!==text.lastIndexOf(key))throw unverified();
    const before=map[start+left.length-1],after=map[start+left.length];
    if(!before||!after||nodes[before.node].paragraph!==nodes[after.node].paragraph
      ||nodes[before.node].paragraph.complex)throw unverified();
    const node=nodes[before.node],offset=before.offset+1;
    const replacement='<w:t xml:space="preserve">'+escape(node.text.slice(0,offset)+' − '+node.text.slice(offset))+'</w:t>';
    xml=xml.slice(0,node.start)+replacement+xml.slice(node.end);operatorCount++;
  }
  return {xml,operatorCount};
}

async function repairNativeMathXml(inputPath,documentXml,pages,options={}) {
  const {fractions,operators}=await nativeMathGeometry(inputPath,pages,options);
  if(!fractions.length&&!operators.length)return {xml:documentXml,repairedCount:0,pageNumbers:[]};
  throwIfCanceled(options.signal);
  const operatorRepair=repairOperatorXml(documentXml,operators);
  const xml=repairFractionXml(operatorRepair.xml,fractions);throwIfCanceled(options.signal);
  const fractionCount=(xml.match(/<m:f>/g)||[]).length-(documentXml.match(/<m:f>/g)||[]).length;
  return {xml,repairedCount:fractionCount+operatorRepair.operatorCount,fractionCount,operatorCount:operatorRepair.operatorCount,
    pageNumbers:[...new Set([...fractions,...operators].map(f=>f.pageNumber))]};
}
module.exports={repairNativeMathXml,nativeFractionGeometry,repairFractionXml};
