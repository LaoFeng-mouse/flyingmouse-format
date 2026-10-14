// Preserve visible scan pixels before OCR. A PDF may stretch an otherwise clear
// image to half its original height; raising render DPI cannot restore its glyphs.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { loadPdfjs, getPdfjsDocumentOptions } = require('./pdfjs');

const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_PAGE_PIXELS = 100_000_000;
const IDENTITY = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3],
    a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function bounds(matrix) {
  const points = [[0,0], [0,1], [1,0], [1,1]].map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]]);
  return [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])), Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))];
}
const overlaps = (a,b) => Math.min(a[2],b[2])-Math.max(a[0],b[0]) > 0.5 && Math.min(a[3],b[3])-Math.max(a[1],b[1]) > 0.5;

function visibleImagePlacements(operators, OPS, viewport, nativeLines = []) {
  // Unknown clipping, masks, vector paint, transparency and optional-content
  // layers must use the page renderer. Extracting their raw image could disclose
  // pixels deliberately covered or cropped out of the visible document.
  const unsafe = new Set(['clip','eoClip','constructPath','fill','eoFill','stroke','closeStroke','fillStroke','eoFillStroke',
    'closeFillStroke','closeEOFillStroke','shadingFill','setGState','paintFormXObjectBegin','paintFormXObjectEnd',
    'beginGroup','endGroup','beginAnnotation','endAnnotation','beginMarkedContent','beginMarkedContentProps',
    'paintImageMaskXObject','paintImageMaskXObjectGroup','paintImageMaskXObjectRepeat','paintSolidColorImageMask',
    'paintInlineImageXObject','paintInlineImageXObjectGroup','paintImageXObjectRepeat'].map(name=>OPS[name]).filter(Number.isFinite));
  let matrix = IDENTITY;
  const stack = [], images = [];
  for (let i=0; i<operators.fnArray.length; i++) {
    const operation = operators.fnArray[i], args = operators.argsArray[i];
    if (unsafe.has(operation)) return [];
    if (operation === OPS.setTextRenderingMode && Number(args?.[0]) !== 0) return [];
    if (operation === OPS.save) { if (stack.length >= 64) return []; stack.push(matrix); }
    else if (operation === OPS.restore) { if (!stack.length) return []; matrix=stack.pop(); }
    else if (operation === OPS.transform) {
      if (!args || args.length !== 6 || !args.every(Number.isFinite)) return [];
      matrix = multiply(matrix,args);
    } else if (operation === OPS.paintImageXObject) {
      if (images.length >= 24) return [];
      const [id,width,height] = args || [];
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width*height > MAX_IMAGE_PIXELS) return [];
      const sx=Math.hypot(matrix[0],matrix[1]), sy=Math.hypot(matrix[2],matrix[3]);
      if (!sx || !sy || matrix[0]*matrix[3]-matrix[1]*matrix[2] <= 0 || Math.abs(matrix[0]*matrix[2]+matrix[1]*matrix[3]) > sx*sy*.001) return [];
      const bbox = bounds(multiply(viewport.transform,matrix));
      if (bbox[0] < -.1 || bbox[1] < -.1 || bbox[2] > viewport.width+.1 || bbox[3] > viewport.height+.1) return [];
      if ((bbox[2]-bbox[0])*(bbox[3]-bbox[1]) < viewport.width*viewport.height*.01) return [];
      if (nativeLines.some(line=>Array.isArray(line.bbox) && overlaps(line.bbox,bbox)) || images.some(image=>overlaps(image.bbox,bbox))) return [];
      images.push({ id,width,height,bbox });
    }
  }
  if (stack.length || images.reduce((total,image)=>total+image.width*image.height,0) > MAX_PAGE_PIXELS) return [];
  return images.sort((a,b)=>a.bbox[1]-b.bbox[1] || a.bbox[0]-b.bbox[0]);
}

async function imageToPng(image, ImageKind, outputPath) {
  if (!image?.data || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width*image.height > MAX_IMAGE_PIXELS) return false;
  let data=Buffer.from(image.data), channels;
  if (image.kind === ImageKind.RGB_24BPP) channels=3;
  else if (image.kind === ImageKind.RGBA_32BPP) {
    channels=4;
    for (let i=3;i<data.length;i+=4) if (data[i] !== 255) return false;
  } else if (image.kind === ImageKind.GRAYSCALE_1BPP) {
    const stride=Math.ceil(image.width/8), gray=Buffer.alloc(image.width*image.height);
    if (data.length !== stride*image.height) return false;
    for (let y=0;y<image.height;y++) for (let x=0;x<image.width;x++) gray[y*image.width+x] = data[y*stride+(x>>3)] & (128>>(x&7)) ? 255 : 0;
    data=gray; channels=1;
  } else return false;
  if (data.length !== image.width*image.height*channels) return false;
  await sharp(data,{raw:{width:image.width,height:image.height,channels},limitInputPixels:MAX_IMAGE_PIXELS}).png().toFile(outputPath);
  return true;
}

async function extractPdfScanRegions(inputPath, nativePages, directory) {
  const lib=await loadPdfjs();
  const task=lib.getDocument(getPdfjsDocumentOptions({ data:new Uint8Array(await fs.readFile(inputPath)), disableFontFace:true,
    useSystemFonts:true, isEvalSupported:false, maxImageSize:MAX_IMAGE_PIXELS }));
  const results=new Map();
  try {
    const pdf=await task.promise;
    for (const native of nativePages) {
      const page=await pdf.getPage(native.pageNumber);
      try {
        const viewport=page.getViewport({scale:1,rotation:page.rotate || 0});
        const placements=visibleImagePlacements(await page.getOperatorList(),lib.OPS,viewport,native.lines);
        const regions=[];
        for (let i=0;i<placements.length;i++) {
          const placement=placements[i];
          const image=await new Promise(resolve=>page.objs.get(placement.id,resolve));
          const outputPath=path.join(directory,`scan-${native.pageNumber}-${i}.png`);
          if (!(await imageToPng(image,lib.ImageKind,outputPath))) { regions.length=0; break; }
          regions.push({ outputPath,bbox:placement.bbox });
        }
        if (regions.length) results.set(native.pageNumber,regions);
      } finally { page.cleanup(); }
    }
  } finally { await task.destroy(); }
  return results;
}

module.exports={ extractPdfScanRegions, visibleImagePlacements };
