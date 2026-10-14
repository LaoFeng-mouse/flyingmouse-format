'use strict';

// Bounded recovery for native prose containing short raster word labels.
// Whole visual lines containing labels remain pictures. No OCR confidence or native-text coverage
// check is relaxed; unsupported paint/geometry returns to the normal route.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { PDFDocument, PDFName, PDFDict, PDFRawStream } = require('pdf-lib');
const { Document, Packer, Paragraph, TextRun, ImageRun, SectionType } = require('docx');
const { loadPdfjs, getPdfjsDocumentOptions } = require('./pdfjs');
const { PDFTOPPM_PATH } = require('./config');
const { run } = require('./utils');
const { LIMITS, assertPdfPages, assertImageMetadata, ResourceLimitError } = require('./resource-policy');
const { throwIfCanceled, cancellationError } = require('./conversion-cancellation');
const { mapInlineUnderlines } = require('./pdf-inline-text-style');

const MAX_IMAGES = 500;
const SCALE = 3;
const EPS = 0.15;
const nums = (v, n) => {
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) return null;
  const a = Array.from(v);
  return a.length === n && a.every(Number.isFinite) ? a : null;
};
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const axis = m => nums(m, 6) && Math.abs(m[1]) < 1e-5 && Math.abs(m[2]) < 1e-5 && m[0] > 0 && m[3] < 0;
const box = (m, b) => [Math.min(m[0]*b[0]+m[4],m[0]*b[2]+m[4]),
  Math.min(m[3]*b[1]+m[5],m[3]*b[3]+m[5]), Math.max(m[0]*b[0]+m[4],m[0]*b[2]+m[4]),
  Math.max(m[3]*b[1]+m[5],m[3]*b[3]+m[5])];
const valid = b => nums(b, 4) && b[2] > b[0] && b[3] > b[1];
const overlap = (a, b) => Math.min(a[2], b[2])-Math.max(a[0], b[0]) > EPS
  && Math.min(a[3], b[3])-Math.max(a[1], b[1]) > EPS;
const normalized = s => String(s).normalize('NFKC').replace(/\s/gu, '');

async function imageMetadataWithinBudget(data, signal) {
  // This route only admits direct Image XObjects. Inspect their declared
  // sizes before getOperatorList can allocate decoder buffers. Unused/shared
  // resources are deliberately counted, so ambiguity falls back safely.
  const pdf=await PDFDocument.load(data,{updateMetadata:false});
  throwIfCanceled(signal);assertPdfPages(pdf.getPageCount());
  for(const page of pdf.getPages()) {
    throwIfCanceled(signal);
    const resources=page.node.Resources();if(!resources)return false;
    const ref=resources.get(PDFName.of('XObject'));if(!ref)continue;
    const dictionary=pdf.context.lookup(ref);if(!(dictionary instanceof PDFDict))return false;
    const seen=new Set();let pixels=0;
    for(const [,entry]of dictionary.entries()) {
      if(seen.has(entry))continue;seen.add(entry);if(seen.size>MAX_IMAGES)return false;
      const image=pdf.context.lookup(entry);
      if(!(image instanceof PDFRawStream) || image.dict.get(PDFName.of('Subtype'))?.toString()!=='/Image')return false;
      const width=pdf.context.lookup(image.dict.get(PDFName.of('Width')))?.asNumber?.();
      const height=pdf.context.lookup(image.dict.get(PDFName.of('Height')))?.asNumber?.();
      pixels+=assertImageMetadata({width,height});
      if(pixels>LIMITS.maxImagePixels)throw new ResourceLimitError('IMAGE_PIXELS_EXCEEDED',{pixels});
    }
  }
  return true;
}

function planPage(operators, OPS, viewport, source, textContent) {
  if (!axis(viewport.transform) || !Array.isArray(source.lines) || !source.lines.length
    || operators.fnArray?.length !== operators.argsArray?.length || operators.fnArray.length > 200000) return null;
  const lines = source.lines;
  if (lines.some(l => !valid(l.bbox) || !l.items?.length || l.items.some(i => !valid(i.bbox)
    || i.bbox[0]<0 || i.bbox[1]<0 || i.bbox[2]>viewport.width || i.bbox[3]>viewport.height
    || !Number.isFinite(i.height) || i.height <= 0 || i.dir && i.dir !== 'ltr'))) return null;
  const allowed = new Set(['dependency','setStrokeGray','setStrokeCMYKColor',
    'setLineCap','setLineJoin','setMiterLimit','setDash','setRenderingIntent','setFlatness',
    'beginText','endText'].map(n => OPS[n]).filter(Number.isInteger));
  let s = { m: Array.from(viewport.transform), tm: [1,0,0,1,0,0], tx: 0, ty: 0,
    fontSize: 0, font: null, charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, leading: 0,
    fill:'000000',stroke:'000000',renderMode:0,lineWidth:1,dashed:false,pendingSpace:'' };
  const stack = [], images = [], glyphs = [], vectors = [],vectorStyles=[];
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index], args = operators.argsArray[index] || [];
    if (op === OPS.save) { if (stack.length >= 64) return null; stack.push({ ...s, m: s.m.slice(), tm: s.tm.slice() }); }
    else if (op === OPS.restore) { if (!stack.length) return null; s = stack.pop(); }
    else if (op === OPS.transform) { const m = nums(args, 6); if (!m) return null; s.m = mul(s.m, m); if (!axis(s.m)) return null; }
    else if(op===OPS.setLineWidth){if(!Number.isFinite(args[0]) || args[0]<0)return null;s.lineWidth=args[0];}
    else if(op===OPS.setDash){if(!Array.isArray(args[0]) || args[0].some(v=>!Number.isFinite(v)||v<0))return null;s.dashed=args[0].length>0;}
    else if (op === OPS.setFont) { if (!(args[1] > 0 && args[1] <= 100)) return null; s.font = args[0]; s.fontSize = args[1]; }
    else if (op === OPS.setTextMatrix) {
      const tm = nums(args.length === 1 ? args[0] : args, 6);
      if (!tm || Math.abs(tm[1]) > 1e-5 || Math.abs(tm[2]) > 1e-5 || tm[0] <= 0 || tm[3] <= 0) return null;
      s.tm = tm; s.tx = s.ty = 0;
    } else if (op === OPS.moveText || op === OPS.setLeadingMoveText) {
      if (!nums(args, 2)) return null;
      s.tm[4] += args[0]*s.tm[0]; s.tm[5] += args[1]*s.tm[3]; s.tx = s.ty = 0;
      if (op === OPS.setLeadingMoveText) s.leading = -args[1];
    } else if (op === OPS.setCharSpacing || op === OPS.setWordSpacing || op === OPS.setHScale
      || op === OPS.setTextRise || op === OPS.setLeading) {
      if (!Number.isFinite(args[0])) return null;
      const key = op === OPS.setCharSpacing ? 'charSpacing' : op === OPS.setWordSpacing ? 'wordSpacing'
        : op === OPS.setHScale ? 'hScale' : op === OPS.setTextRise ? 'rise' : 'leading';
      s[key] = key === 'hScale' ? args[0]/100 : args[0];
      if (s.hScale <= 0) return null;
    } else if (op === OPS.nextLine) { s.tm[5] -= s.leading*s.tm[3]; s.tx = s.ty = 0; }
    else if (op === OPS.setTextRenderingMode) { if (![0,1,2].includes(args[0])) return null; s.renderMode=args[0]; }
    else if (op === OPS.setGState) {
      if (!Array.isArray(args[0]) || !args[0].every(a => Array.isArray(a) && a.length === 2
        && (['CA','ca'].includes(a[0]) && a[1] === 1 || a[0] === 'BM' && ['source-over','Normal'].includes(a[1])
          || a[0] === 'SMask' && [false,'None'].includes(a[1])))) return null;
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      // White native text is not evidence of visible, editable prose.
      const color = typeof args[0] === 'string' ? args[0] : null;
      if (color && /^#[\da-f]{6}$/i.test(color)) { if (Math.min(...[1,3,5].map(i=>parseInt(color.slice(i,i+2),16))) > 230) return null; }
      else if (args.length !== 3 || args.every(v => v > .9)) return null;
      s[op === OPS.setFillRGBColor?'fill':'stroke']=color?color.slice(1).toUpperCase():args.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');
    } else if (op === OPS.setFillGray || op === OPS.setStrokeGray) {
      if (!(args[0] >= 0 && args[0] <= 1) || op===OPS.setFillGray&&args[0]>=.9) return null;
      s[op===OPS.setFillGray?'fill':'stroke']=Math.round(args[0]*255).toString(16).padStart(2,'0').repeat(3).toUpperCase();
    }
    else if (op === OPS.showText) {
      if (!Array.isArray(args[0]) || !s.fontSize) return null;
      const m = mul(s.m, s.tm);
      if (!axis(m)) return null;
      for (const g of args[0]) {
        if (typeof g === 'number') { s.tx -= g*s.fontSize*.001*s.hScale; continue; }
        if (!g || typeof g.unicode !== 'string' || !Number.isFinite(g.width) || g.width < 0 || g.accent) return null;
        const advance = (g.width*s.fontSize*.001 + s.charSpacing + (g.isSpace ? s.wordSpacing : 0))*s.hScale;
        if (advance < 0) return null;
        if(g.unicode.trim() && (Math.abs(m[3]*s.fontSize)<2 || m[0]*advance<.5))return null;
        if (g.unicode.trim()) { glyphs.push({ text: g.unicode, explicitSpace:s.pendingSpace, order: index, font: s.font, color:s.renderMode===1?s.stroke:s.fill,
          bbox: box(m, [s.tx, s.ty+s.rise-s.fontSize*.2, s.tx+Math.max(advance,.1), s.ty+s.rise+s.fontSize]),
          x: m[0]*s.tx+m[4], y: m[3]*(s.ty+s.rise)+m[5], height: Math.abs(m[3]*s.fontSize) }); s.pendingSpace=''; }
        else s.pendingSpace+=g.unicode;
        s.tx += advance;
      }
    } else if (op === OPS.paintImageXObject) {
      const [id,width,height] = args, b = box(s.m,[0,0,1,1]);
      if (typeof id !== 'string' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width*height > LIMITS.maxImagePixels || images.length >= MAX_IMAGES
        || !valid(b) || b[0] < 0 || b[1] < 0 || b[2] > viewport.width || b[3] > viewport.height
        || b[3]-b[1] > 32 || b[2]-b[0] > viewport.width*.55) return null;
      const center = (b[1]+b[3])/2;
      const candidates = lines.map((l,i)=>({i,d:Math.abs((l.bbox[1]+l.bbox[3])/2-center)})).sort((a,b)=>a.d-b.d);
      if (candidates[0].d > Math.min(6, (b[3]-b[1])*.35)
        || candidates[1] && candidates[1].d-candidates[0].d < 5) return null;
      const lineIndex = candidates[0].i, line = lines[lineIndex];
      if (b[3]-b[1] < line.height*.5 || b[3]-b[1] > line.height*2.2) return null;
      for (const item of line.items) if (overlap(item.bbox,b)) {
        const extent = Math.min(item.end,b[2])-Math.max(item.x,b[0]);
        if (extent > item.height*1.1 || item.x > b[0]+EPS && item.end < b[2]-EPS && /[\p{L}\p{N}]/u.test(item.text)) return null;
      }
      if (lines.some((l,i)=>i !== lineIndex && l.items.some(item=>overlap(item.bbox,b))) || images.some(image=>overlap(image.bbox,b))) return null;
      images.push({ id,width,height,bbox:b,order:index,lineIndex });
    } else if (op === OPS.constructPath) {
      const b = nums(args[2],4);
      if (!b || ![OPS.stroke,OPS.fill,OPS.eoFill].includes(args[0])) return null;
      const painted = box(s.m,b);
      // Only short horizontal rules are supported in this prose fallback.
      if (painted[2]-painted[0] < 1 || painted[3]-painted[1] > 1.6) return null;
      const command=Array.isArray(args[1])&&args[1].length===1?nums(args[1][0],6):null;
      vectorStyles.push({order:index,kind:args[0]===OPS.stroke?'stroke':'fill',bbox:painted.slice(),color:s.stroke,
        lineWidth:s.lineWidth*Math.abs(s.m[3]),dashed:s.dashed,
        singleHorizontal:Boolean(command&&command[0]===0&&command[3]===1&&Math.abs(command[2]-command[5])<1e-4)});
      if(args[0]===OPS.stroke){const half=Math.max(.1,s.lineWidth*Math.abs(s.m[3])/2);if(half>.8)return null;
        painted[0]-=half;painted[1]-=half;painted[2]+=half;painted[3]+=half;}
      vectors.push(painted);
    } else if (!allowed.has(op)) return null;
  }
  if (stack.length || !glyphs.length) return null;
  const items = lines.flatMap((l,lineIndex)=>l.items.map((item,itemIndex)=>({item,lineIndex,itemIndex,glyphs:[]})));
  if(!textContent?.items) return null;
  let cursor=0;
  for(const raw of textContent.items) {
    const text=String(raw.str || '').trim();
    if(!text) continue;
    const t=nums(raw.transform,6); if(!t) return null;
    const x=viewport.transform[0]*t[4]+viewport.transform[4], y=viewport.transform[3]*t[5]+viewport.transform[5];
    const matches=items.filter(({item})=>item.text===text && Math.abs(item.x-x)<.01 && Math.abs(item.y-y)<.01);
    if(matches.length!==1 || matches[0].glyphs.length) return null;
    let collected='';
    while(cursor<glyphs.length && collected.length<normalized(text).length) {
      const glyph=glyphs[cursor++];collected+=normalized(glyph.text);matches[0].glyphs.push(glyph);
    }
    if(collected!==normalized(text)) return null;
  }
  if(cursor!==glyphs.length) return null;
  for (const entry of items) {
    entry.glyphs.sort((a,b)=>a.x-b.x);
    if (normalized(entry.glyphs.map(g=>g.text).join('')) !== normalized(entry.item.text)) return null;
    let offset=0;
    for(const glyph of entry.glyphs) {
      glyph.lineIndex=entry.lineIndex;glyph.itemIndex=entry.itemIndex;glyph.sourceStart=offset;
      while(offset<entry.item.text.length && /\s/u.test(entry.item.text[offset])) offset++;
      const sourcePart=entry.item.text.slice(offset,offset+glyph.text.length);
      if(normalized(sourcePart)!==normalized(glyph.text)) return null;
      offset+=glyph.text.length;glyph.sourceEnd=offset;
      glyph.sourceText=entry.item.text.slice(glyph.sourceStart,offset);
      // PDF.js may synthesize spaces from glyph distance. Keep actual PDF
      // space glyphs; infer separated Latin words later from source geometry.
      const previous=entry.glyphs[entry.glyphs.indexOf(glyph)-1];
      const wordGap=previous && !glyph.explicitSpace && glyph.x-previous.bbox[2]>glyph.height*.12
        && /[\p{Script=Latin}\p{N}]$/u.test(previous.text) && /^[\p{Script=Latin}\p{N}]/u.test(glyph.text);
      glyph.displayText=(previous?(glyph.explicitSpace || (wordGap?' ':'')):'')+glyph.text;
    }
  }
  return { lines, images, glyphs, items, vectors,vectorStyles };
}

async function verifyUncoveredVectorText(plan,removed,page,operators,OPS,signal,regions=[]) {
  const conflicts=plan.vectors.flatMap(v=>plan.glyphs.filter(g=>!removed.has(g)&&v[1]<g.y-2&&overlap(g.bbox,v)).map(g=>[
    Math.max(g.bbox[0],v[0]),Math.max(g.bbox[1],v[1]),Math.min(g.bbox[2],v[2]),Math.min(g.bbox[3],v[3])]));
  if(!conflicts.length && !regions.length)return true;
  const {createCanvas}=require('@napi-rs/canvas'),viewport=page.getViewport({scale:SCALE});
  const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);assertImageMetadata({width,height});
  const canvas=createCanvas(width,height),rendering=page.render({canvas,viewport,background:'rgba(0,0,0,0)',
    operationsFilter:i=>![OPS.paintImageXObject,OPS.constructPath].includes(operators.fnArray[i])});
  const abort=()=>rendering.cancel();signal?.addEventListener('abort',abort,{once:true});
  try {
    await rendering.promise;throwIfCanceled(signal);
    const data=canvas.getContext('2d').getImageData(0,0,width,height).data;
    for(const b of conflicts)for(let y=Math.max(0,Math.floor(b[1]*SCALE));y<Math.min(height,Math.ceil(b[3]*SCALE));y++)
      for(let x=Math.max(0,Math.floor(b[0]*SCALE));x<Math.min(width,Math.ceil(b[2]*SCALE));x++)
        if(data[(y*width+x)*4+3]>0)return false;
    const ink=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&data[(y*width+x)*4+3]>16;
    for(const region of regions) {
      const top=Math.floor(region.bbox[1]*SCALE),bottom=Math.ceil(region.bbox[3]*SCALE);
      // Full-width strips contain horizontal overhang. Decline uncertain
      // vertical cuts rather than clipping continuous visible native ink.
      for(let x=0;x<width;x++)if(ink(x,top-1)&&ink(x,top)||ink(x,bottom-1)&&ink(x,bottom))return false;
    }
    return true;
  }finally{signal?.removeEventListener('abort',abort);canvas.width=canvas.height=1;}
}

function rasterRegions(plan, viewport) {
  const union=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
  let regions=plan.images.map(im=>({bbox:im.bbox.slice(),lineIndex:im.lineIndex,images:[im],glyphs:new Set()}));
  let changed=true;
  while(changed) {
    changed=false;
    for(const region of regions) {
      for(const glyph of plan.glyphs) if(!region.glyphs.has(glyph) && overlap(region.bbox,glyph.bbox)) {
        if(glyph.lineIndex!==region.lineIndex) return null;
        region.glyphs.add(glyph);region.bbox=union(region.bbox,glyph.bbox);changed=true;
      }
      if(region.glyphs.size>8 || region.bbox[2]-region.bbox[0]>viewport.width*.6
        || region.bbox[3]-region.bbox[1]>36 || region.bbox[0]<0 || region.bbox[1]<0
        || region.bbox[2]>viewport.width || region.bbox[3]>viewport.height) return null;
    }
    for(let i=0;i<regions.length;i++) for(let j=i+1;j<regions.length;j++) if(overlap(regions[i].bbox,regions[j].bbox)) {
      const a=regions[i],b=regions[j];if(a.lineIndex!==b.lineIndex) return null;
      a.bbox=union(a.bbox,b.bbox);a.images.push(...b.images);for(const g of b.glyphs)a.glyphs.add(g);
      regions.splice(j--,1);changed=true;
    }
  }
  return regions;
}

function lineRasterRegions(plan, viewport, unmatchedVectors=[]) {
  // A picture and neighboring text cannot share a portable DOCX baseline.
  // Preserve their entire visible source line instead of shifting glyphs or
  // guessing a renderer-specific baseline correction. Horizontal overhangs
  // and the original underline are inside a full-page-width visible strip.
  const bodyStarts=plan.items.filter(e=>e.item.text.replace(/\s/gu,'').length>=12
    && e.item.end-e.item.x>viewport.width*.3).map(e=>e.item.x).sort((a,b)=>a-b);
  const bodyLeft=bodyStarts.length>=3?bodyStarts[Math.floor((bodyStarts.length-1)*.1)]:0;
  const margin=g=>bodyLeft>viewport.width*.06 && g.bbox[2]<bodyLeft-.5 && g.bbox[0]<bodyLeft-3;
  const bodyLines=plan.lines.map((_,i)=>i).filter(i=>plan.glyphs.some(g=>g.lineIndex===i&&!margin(g)));
  let regions=plan.images.map(im=>({lineIndices:new Set([im.lineIndex]),images:[im]}));
  for(const vector of unmatchedVectors) {
    const y=(vector.bbox[1]+vector.bbox[3])/2;
    const nearest=bodyLines.slice().sort((a,b)=>Math.abs(plan.lines[a].y-y)-Math.abs(plan.lines[b].y-y))[0];
    if(nearest===undefined)return null;
    regions.push({lineIndices:new Set([nearest]),images:[],rules:[vector.bbox]});
  }
  for(let i=0;i<plan.lines.length;i++) {
    const gs=plan.glyphs.filter(g=>g.lineIndex===i),side=gs.filter(margin);
    if(!side.length)continue;
    // All content is retained. A marginal annotation is attached visually to
    // its nearest body line, never serialized between two parts of a question.
    const nearest=bodyLines.slice().sort((a,b)=>Math.abs(plan.lines[a].y-plan.lines[i].y)-Math.abs(plan.lines[b].y-plan.lines[i].y))[0];
    if(nearest===undefined)return null;
    regions.push({lineIndices:new Set([i,nearest]),images:[]});
  }
  const update=r=>{
    r.glyphs=new Set(plan.glyphs.filter(g=>r.lineIndices.has(g.lineIndex)));
    r.images=plan.images.filter(im=>r.lineIndices.has(im.lineIndex));
    const boxes=[...[...r.glyphs].map(g=>g.inkEnvelope || g.bbox),...r.images.map(im=>im.bbox),...(r.rules || [])];
    r.lineIndex=Math.min(...r.lineIndices);
    r.bbox=[0,Math.max(0,Math.min(...boxes.map(b=>b[1]))-2),viewport.width,
      Math.min(viewport.height,Math.max(...boxes.map(b=>b[3]))+2)];
  };
  let changed=true;
  while(changed) {
    changed=false;regions.forEach(update);
    for(const r of regions)for(const g of plan.glyphs)if(!r.lineIndices.has(g.lineIndex)&&overlap(r.bbox,g.inkEnvelope || g.bbox)) {
      r.lineIndices.add(g.lineIndex);changed=true;
    }
    if(changed)continue;
    for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++)if(overlap(regions[i].bbox,regions[j].bbox)) {
      for(const index of regions[j].lineIndices)regions[i].lineIndices.add(index);
      regions[i].rules=[...(regions[i].rules || []),...(regions[j].rules || [])];
      regions.splice(j--,1);changed=true;
    }
  }
  regions.forEach(update);
  return regions.sort((a,b)=>a.lineIndex-b.lineIndex);
}

async function opaqueImage(page, image, signal) {
  const decoded = await new Promise((resolve,reject)=> {
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>finish(cancellationError());
    const timer = setTimeout(()=>finish(new Error('Inline image decode timed out')),10000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) return abort();
    try { page.objs.get(image.id,value=>finish(null,value)); } catch(e) {finish(e);}
  });
  if (!decoded || decoded.width !== image.width || decoded.height !== image.height || !decoded.data) return false;
  if ([1,2].includes(decoded.kind)) return true;
  if (decoded.kind !== 3 || decoded.data.length !== image.width*image.height*4) return false;
  for(let i=3;i<decoded.data.length;i+=4) if(decoded.data[i] !== 255) return false;
  return true;
}

async function renderVisiblePage(inputPath, pageNumber, tempDir, options) {
  const prefix=path.join(tempDir,`page-${pageNumber}`);
  await (options.run || run)(options.pdftoppmPath || PDFTOPPM_PATH,
    ['-png','-cropbox','-r',String(SCALE*72),'-f',String(pageNumber),'-l',String(pageNumber),'-singlefile',inputPath,prefix],
    {timeout:300000,signal:options.signal});
  throwIfCanceled(options.signal);return `${prefix}.png`;
}

async function convertInlineImagePdfToDocx({ inputPath, outputPath, pages, options = {} }) {
  throwIfCanceled(options.signal);
  if (!Array.isArray(pages) || !pages.length || !pages.some(p=>(p.ocrImageCoverage ?? p.imageCoverage)>0)
    || pages.some(p=>p.ocr || !p.lines?.length)) return null;
  const lib = await loadPdfjs();
  throwIfCanceled(options.signal);
  if (Number(String(lib.version).split('.')[0]) !== 6) return null;
  const inputData=new Uint8Array(await fs.readFile(inputPath));
  throwIfCanceled(options.signal);
  try {if(!await imageMetadataWithinBudget(inputData,options.signal))return null;}
  catch(error){throwIfCanceled(options.signal);if(error?.errorCode)throw error;return null;}
  throwIfCanceled(options.signal);
  const task = lib.getDocument(getPdfjsDocumentOptions({ data:inputData,
    disableFontFace:false, useSystemFonts:true, maxImageSize:LIMITS.maxImagePixels,stopAtErrors:true,isEvalSupported:false }));
  const abort=()=>{void task.destroy().catch(()=>{});};
  options.signal?.addEventListener('abort',abort,{once:true});
  let tempDir;
  try {
    throwIfCanceled(options.signal);
    const pdf = await task.promise;
    assertPdfPages(pdf.numPages);
    if (pdf.numPages !== pages.length) return null;
    const sections = [], pageNumbers = [], rasterizedGlyphs = [], textCoveragePages=[], expectedInlineParagraphs=[];
    let imageCount = 0, imageBytes = 0, cropCount=0;
    for(let p=1;p<=pdf.numPages;p++) {
      throwIfCanceled(options.signal);
      const page = await pdf.getPage(p);
      try {
        const viewport = page.getViewport({scale:1}), operators = await page.getOperatorList();
        throwIfCanceled(options.signal);
        const plan = planPage(operators,lib.OPS,viewport,pages[p-1],await page.getTextContent());
        if(!plan || imageCount+plan.images.length>MAX_IMAGES) return null;
        const fontEnvelopes=new Map();
        for(const glyph of plan.glyphs) {
          if(!fontEnvelopes.has(glyph.font)) {
            const font=page.commonObjs.get(glyph.font), bounds=nums(font?.bbox,4),matrix=nums(font?.fontMatrix,6);
            if(matrix && (matrix[1] || matrix[2] || !(matrix[3]>0)))return null;
            if((!bounds || !matrix)&&(!Number.isFinite(font?.ascent)||!Number.isFinite(font?.descent)))return null;
            const ascent=bounds&&matrix?Math.max(1,bounds[3]*matrix[3]):Math.max(1.2,font.ascent);
            const descent=bounds&&matrix?Math.max(.2,-bounds[1]*matrix[3]):Math.max(.4,-font.descent);
            if(ascent>3 || descent>2)return null;
            fontEnvelopes.set(glyph.font,{ascent,descent});
          }
          const {ascent,descent}=fontEnvelopes.get(glyph.font);
          glyph.inkEnvelope=[glyph.bbox[0],glyph.y-glyph.height*ascent,glyph.bbox[2],glyph.y+glyph.height*descent];
        }
        if(plan.images.reduce((n,im)=>n+im.width*im.height,0)>LIMITS.maxImagePixels) return null;
        const styles=mapInlineUnderlines(plan.glyphs,plan.vectorStyles);
        const regions=lineRasterRegions(plan,viewport,styles.unmatchedVectors);if(!regions || cropCount+regions.length>MAX_IMAGES)return null;
        const removed=new Set(regions.flatMap(r=>[...r.glyphs]));
        if(!await verifyUncoveredVectorText(plan,removed,page,operators,lib.OPS,options.signal,regions))return null;
        if(regions.length) {
          assertImageMetadata({width:Math.ceil(viewport.width*SCALE),height:Math.ceil(viewport.height*SCALE)});
          for(const im of plan.images) if(!await opaqueImage(page,im,options.signal)) return null;
          if(!tempDir)tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'fmf-inline-pdf-'));
          const rendered=await renderVisiblePage(inputPath,p,tempDir,options);
          const metadata=await sharp(rendered,{limitInputPixels:LIMITS.maxImagePixels}).metadata();assertImageMetadata(metadata);
          if(Math.abs(metadata.width-viewport.width*SCALE)>1.1 || Math.abs(metadata.height-viewport.height*SCALE)>1.1)return null;
          for(const im of regions) {
            throwIfCanceled(options.signal);
            const [x0,y0,x1,y1]=im.bbox, left=Math.max(0,Math.floor(x0*SCALE)),top=Math.max(0,Math.floor(y0*SCALE));
            const width=Math.min(metadata.width,Math.ceil(x1*SCALE))-left,height=Math.min(metadata.height,Math.ceil(y1*SCALE))-top;
            im.bytes=await sharp(rendered,{limitInputPixels:LIMITS.maxImagePixels}).extract({left,top,width,height}).png().toBuffer();
            im.bbox=[left/SCALE,top/SCALE,(left+width)/SCALE,(top+height)/SCALE];
            im.cropIndex=++cropCount;
            rasterizedGlyphs.push(...[...im.glyphs].map(g=>({pageNumber:p,lineIndex:g.lineIndex,itemIndex:g.itemIndex,
              sourceStart:g.sourceStart,sourceEnd:g.sourceEnd,text:g.text,bbox:g.bbox,cropIndex:im.cropIndex,cropBbox:im.bbox})));
            imageBytes+=im.bytes.length;
            if(imageBytes>Math.min(64*1024*1024,LIMITS.workingBytes/4)) return null;
          }
          pageNumbers.push(p);imageCount+=plan.images.length;
        }
        const leftMargin=0,rightMargin=0;
        const coverageLines=[];
        const children=plan.lines.flatMap((line,lineIndex)=> {
          const lineRegion=regions.find(r=>r.lineIndices.has(lineIndex));
          if(lineRegion && lineRegion.lineIndex!==lineIndex)return [];
          const keptItems=[];
          for(const entry of plan.items.filter(e=>e.lineIndex===lineIndex)) {
            let kept;
            for(const g of entry.glyphs) {
              if(removed.has(g)){kept=null;continue;}
              if(!kept){kept={...entry.item,text:'',x:g.x,end:g.bbox[2],glyphs:[]};keptItems.push(kept);}
              kept.text+=g.sourceText;kept.end=Math.max(kept.end,g.bbox[2]);kept.glyphs.push(g);
              kept.bbox=[kept.x,entry.item.bbox[1],kept.end,entry.item.bbox[3]];
            }
          }
          const coverageItems=keptItems.map(({glyphs,...item})=>item);
          if(coverageItems.length)coverageLines.push({...line,items:coverageItems,text:coverageItems.map(i=>i.text).join(' '),cells:coverageItems.map(i=>i.text)});
          const entries=keptItems.map(item=>({x:item.x,item}));
          entries.push(...regions.filter(im=>im.lineIndex===lineIndex).map(im=>({x:im.bbox[0],image:im})));
          entries.sort((a,b)=>a.x-b.x);
          const runs=[], expected=[];
          const expectText=text=>{if(expected.at(-1)?.text!==undefined)expected.at(-1).text+=text;else expected.push({text});};
          for(let entryIndex=0;entryIndex<entries.length;entryIndex++) {
            const entry=entries[entryIndex],previous=entries[entryIndex-1];
            if(previous) {
              const gap=entry.x-(previous.image?previous.image.bbox[2]:previous.item.end);
              const height=entry.item?.height || previous.item?.height || line.height;
              if(gap>Math.max(1,height*.12)) {
                const before=previous.item&&styles.underlines.get(previous.item.glyphs.at(-1));
                const after=entry.item&&styles.underlines.get(entry.item.glyphs[0]);
                runs.push(new TextRun({text:' ',font:{ascii:'Arial',hAnsi:'Arial',eastAsia:'Arial',cs:'Arial'},size:Math.round(height*2),
                  characterSpacing:Math.round((gap-height*.278)*20),...(before&&after&&before.color===after.color?{underline:before}:{})}));
                expectText(' ');
              }
            }
            if(entry.image) {
              const im=entry.image; runs.push(new ImageRun({data:im.bytes,type:'png',transformation:{width:(im.bbox[2]-im.bbox[0])*4/3,height:(im.bbox[3]-im.bbox[1])*4/3},altText:{name:`Source page ${p} line ${lineIndex+1}`,title:'原 PDF 内嵌词条图片',description:'图内文字保留为图片'}}));
              expected.push({imageSha256:createHash('sha256').update(im.bytes).digest('hex')});
            } else {
              const e=entry.item, groups=[];
              for(const g of e.glyphs) {
                const text=g.displayText;
                if(!text) continue;
                const underline=styles.underlines.get(g);
                if(groups.at(-1)?.color===g.color && groups.at(-1)?.underline?.color===underline?.color) groups.at(-1).text+=text;
                else groups.push({text,color:g.color,...(underline?{underline}:{})});
              }
              expectText(e.glyphs.map(g=>g.displayText).join(''));
              // Keep native runs at their actual half-point font size. Some Office
              // renderers shorten a scaled CJK run's layout width without scaling
              // its glyph advances, so a following style run overwrites its tail.
              for(const group of groups) runs.push(new TextRun({...group,font:{ascii:'Arial',hAnsi:'Arial',eastAsia:'SimSun'},size:Math.round(e.height*2)}));
            }
          }
          expectedInlineParagraphs.push(expected);
          return [new Paragraph({children:runs,spacing:{before:0,after:0},indent:{left:lineRegion?0:Math.max(0,Math.round((line.bbox[0]-leftMargin)*20))}})];
        });
        textCoveragePages.push({...pages[p-1],lines:coverageLines,rows:coverageLines.map(l=>l.cells)});
        sections.push({properties:{type:SectionType.NEXT_PAGE,page:{size:{width:Math.ceil(Math.ceil(viewport.width*SCALE)/SCALE*20),height:Math.round(viewport.height*20)},margin:{top:400,bottom:400,left:Math.round(leftMargin*20),right:Math.round(rightMargin*20)}}},children});
      } finally {page.cleanup();}
    }
    if(!imageCount) return null;
    throwIfCanceled(options.signal);
    const data=await Packer.toBuffer(new Document({creator:'牢蜂',description:'含词条图片、页边标注或复杂横线的整行保留为图片，其余原生正文可编辑。',sections}));
    throwIfCanceled(options.signal);
    // Caller supplies an unpublished attempt path and performs package/text
    // coverage validation before its atomic rename. Never overwrite a target.
    await fs.writeFile(outputPath,data,{flag:'wx'});
    return {imageCount,cropCount,textCoveragePages,rasterizedGlyphs,expectedInlineParagraphs,
      rasterizedLineCount:new Set(rasterizedGlyphs.map(g=>`${g.pageNumber}:${g.lineIndex}`)).size,
      hasEditableContent:textCoveragePages.some(p=>p.lines.length),rasterizedNativeGlyphCount:rasterizedGlyphs.length,
      warnings:[{code:'PDF_INLINE_IMAGES_PRESERVED',pageNumbers,messages:{
      zhCN:`第 ${pageNumbers.join('、')} 页含词条图片、页边标注或复杂横线的整行按原页保留为图片，这些行不可直接改字；其余正文可编辑。普通正文的字体、字距、下划线位置和行距可能变化，请对照原 PDF 复核。`,
      enUS:`Whole lines containing image labels, marginal annotations or complex rules on pages ${pageNumbers.join(', ')} remain source-page images and cannot be edited as text. Other native text is editable. Fonts, character spacing, underline placement and line spacing may change; compare with the original PDF.`}}]};
  } catch(error) {
    throwIfCanceled(options.signal);
    if(error?.errorCode || ['CONVERSION_CANCELED','CONVERSION_CANCELLED','ENOSPC','EACCES','EPERM','EEXIST'].includes(error?.code)) throw error;
    options.onRejected?.(error);
    return null;
  } finally {
    options.signal?.removeEventListener('abort',abort);
    await task.destroy();
    if(tempDir)await fs.rm(tempDir,{recursive:true,force:true}).catch(()=>{});
    throwIfCanceled(options.signal);
  }
}

module.exports={convertInlineImagePdfToDocx,planPage,rasterRegions,lineRasterRegions};
