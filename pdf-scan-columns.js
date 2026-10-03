// Recover missed borderless tables using the retained page image. Model boxes
// can be in a dewarped frame: they are used only to select candidates, never to
// crop the reference image or to infer digit boundaries.
const sharp = require('sharp');
const fsp = require('node:fs/promises');
const { LIMITS } = require('./resource-policy');
const { resolveStructureAsset, validateStructureManifest } = require('./pdf-structure-contract');
const { throwIfCanceled, cancellationError } = require('./conversion-cancellation');

// Full-width ASCII digits/separators are typographic equivalents, not numeric
// correction. Do not coerce numbers or normalize unrelated Unicode symbols.
const compact = text => String(text || '').replace(/[０-９．，＋－％]/gu, char => String.fromCharCode(char.charCodeAt(0)-0xfee0)).replace(/\s/gu, '');
const letters = text => compact(text).replace(/[^\p{L}]/gu, '');
const numeric = text => /^[+\-￥¥$€£]?[\d.,]+%?$/u.test(compact(text));
const MAX_CELLS = 512;
function unverified(pageNumber) {
  return Object.assign(new Error(`第 ${pageNumber} 页存在疑似扫描列，但原图的列边界或文字尚无法可靠核对。请核对原件后重试。`), {
    code: 'PDF_SCAN_COLUMNS_UNVERIFIED', messages: {
      zhCN: `第 ${pageNumber} 页存在疑似扫描列，但原图的列边界或文字尚无法可靠核对。请核对原件后重试。`,
      enUS: `Scanned columns on page ${pageNumber} could not be verified against the original image. Check the source and retry.`
    }
  });
}

function textWidthUpperBound(text, height) {
  return [...compact(text)].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uac00-\ud7af]/u.test(char) ? 1 : .68) * height, 0);
}
function candidateGroups(page) {
  const blocks = page.blocks || [], candidates = [];
  const body = block => {
    const text = compact(block?.text), box = block?.bbox;
    if (!['text','paragraph'].includes(block?.type) || !Array.isArray(box) || box.length !== 4) return false;
    // A numeric title, colon label, prose with units, and ordinary tightly set
    // text do not qualify. This is a bounded short-record repair, not a parser
    // for arbitrary numeric prose.
    if (!/^[\p{L}]*[+\-￥¥$€£]?[\d.,%]+$/u.test(text) || !/\d/u.test(text)) return false;
    const height = box[3] - box[1], width = box[2] - box[0];
    return height > 0 && width > textWidthUpperBound(text, height) * 1.1;
  };
  for (let i = 0; i < blocks.length - 1; i++) {
    const header = blocks[i], text = compact(header?.text), box = header?.bbox;
    if (!['text','paragraph','heading'].includes(header?.type) || !/^[\p{L}]{2,80}$/u.test(text) || !box) continue;
    if (box[2] - box[0] < page.width * .18
      || box[2] - box[0] <= textWidthUpperBound(text, box[3] - box[1]) * 1.1) continue;
    const indexes = [i];
    for (let j = i + 1; j < blocks.length && indexes.length <= 128; j++) {
      const next = blocks[j], previous = blocks[j - 1];
      if (!body(next) || next.bbox[1] < previous.bbox[1]
        || next.bbox[1] - previous.bbox[3] > 8 * Math.max(next.bbox[3] - next.bbox[1], previous.bbox[3] - previous.bbox[1])
        || Math.abs(next.bbox[0] - box[0]) > page.width * .2) break;
      indexes.push(j);
    }
    if (indexes.length > 128) throw unverified(page.pageNumber);
    if (indexes.length >= 2) { candidates.push(indexes); i = indexes.at(-1); }
  }
  return candidates.map(indexes => ({ indexes, blocks:indexes.map(index=>blocks[index]) }));
}

function detectedTableCandidates(page) {
  const result = [];
  for (const table of page.tables || []) {
    // A model can emit a table yet join two numeric columns inside one cell.
    // Existing ordinary grid cells do not pay for a second OCR pass.
    const suspected = (table.cells || []).some(cell => {
      if (String(cell.text || '').trim().split(/\s+/u).filter(numeric).length > 1) return true;
      const text = compact(cell.text);
      // Repeated decimal runs are a reason to inspect the image, never a way
      // to split or calculate its values. Standard thousands grouping, dates,
      // a single identifier, and IP addresses do not trigger this check.
      if (/^[+\-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)
        || /^[+\-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text)) return false;
      return /^[+\-]?\d+[.,]\d{3,}[.,]\d+$/.test(text);
    });
    if (!suspected) continue;
    if (table.rowCount > 128 || table.columnCount > 16 || table.cells.some(cell=>cell.rowSpan !== 1 || cell.columnSpan !== 1)) throw unverified(page.pageNumber);
    const indexes = (page.blocks || []).flatMap((block,index)=>block.type === 'table' && block.tableId === table.id ? [index] : []);
    if (indexes.length !== 1) throw unverified(page.pageNumber);
    const blocks = [];
    for (let row = 0; row < table.rowCount; row++) {
      const cells = table.cells.filter(cell=>cell.row === row).sort((a,b)=>a.column-b.column);
      if (!cells.length) throw unverified(page.pageNumber);
      blocks.push({text:cells.map(cell=>cell.text || '').join(''),confidence:Math.min(...cells.map(cell=>cell.confidence || 0))});
    }
    result.push({ indexes, blocks, existingId:table.id });
  }
  return result;
}

async function inspectReference(page, assetRoot, { signal }) {
  const ocr = require('./ocr');
  const imagePath = resolveStructureAsset(assetRoot, page.referenceImage);
  const metadata = await sharp(imagePath, { limitInputPixels: LIMITS.maxImagePixels }).metadata();
  if (!metadata.width || !metadata.height || metadata.orientation > 1
    || Math.abs(metadata.width / metadata.height - page.width / page.height) > .002) throw unverified(page.pageNumber);
  const prepared = await ocr.prepareImageForOcr(imagePath);
  let worker, ended = false, timer, rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // Every rejection is observed, including an abort between two recognitions.
  stopped.catch(() => {});
  const stop = error => {
    if (ended) return;
    ended = true;
    rejectStopped(error);
    if (worker) worker.terminate().catch(() => {});
  };
  const abort = () => stop(cancellationError());
  const dispose = async () => {
    ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (worker) await worker.terminate().catch(() => {});
    await fsp.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    throwIfCanceled(signal);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(unverified(page.pageNumber)), 60000);
    const creating = ocr.createOcrWorker().then(value => { worker = value; if (ended) value.terminate().catch(() => {}); return value; });
    await Promise.race([creating, stopped]);
    const recognize = async (input, mode) => {
      throwIfCanceled(signal);
      const result = await Promise.race([worker.recognize(input, { rotateAuto: false, tessedit_pageseg_mode: mode }, { text: true, blocks: true }), stopped]);
      throwIfCanceled(signal);
      if (result.data.rotateRadians !== 0) throw unverified(page.pageNumber);
      return result.data;
    };
    const data = await recognize(prepared.outputPath, '6');
    const raw = await sharp(prepared.outputPath, { limitInputPixels: LIMITS.maxImagePixels }).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
    return {
      width: raw.info.width, height: raw.info.height, pixels: raw.data, rotation: 0,
      lines: (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || [])),
      async recognizeRegion(box) {
        const pad = Math.ceil((box[3] - box[1]) * .2);
        const left = Math.max(0, Math.floor(box[0] - pad)), top = Math.max(0, Math.floor(box[1] - pad));
        const right = Math.min(raw.info.width, Math.ceil(box[2] + pad)), bottom = Math.min(raw.info.height, Math.ceil(box[3] + pad));
        const input = await sharp(prepared.outputPath, { limitInputPixels: LIMITS.maxImagePixels })
          .extract({ left, top, width: right - left, height: bottom - top }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: 'white' }).png().toBuffer();
        return recognize(input, '7');
      }, dispose
    };
  } catch (error) { await dispose(); throw error; }
}

function validBox(box, reference) {
  return box && [box.x0,box.y0,box.x1,box.y1].every(Number.isFinite) && box.x0 >= 0 && box.y0 >= 0
    && box.x1 > box.x0 && box.y1 > box.y0 && box.x1 <= reference.width && box.y1 <= reference.height;
}
function imageGroups(line, reference) {
  const box = line.bbox;
  if (!validBox(box, reference)) return null;
  const top = Math.floor(box.y0), bottom = Math.ceil(box.y1), runs = [];
  let start = null;
  for (let x = Math.floor(box.x0); x < Math.ceil(box.x1); x++) {
    let ink = false;
    for (let y = top; y < bottom; y++) if (reference.pixels[y * reference.width + x] < 170) { ink = true; break; }
    if (ink && start === null) start = x;
    if (!ink && start !== null) { runs.push([start,x]); start = null; }
  }
  if (start !== null) runs.push([start, Math.ceil(box.x1)]);
  const advances = [];
  for (const word of line.words || []) {
    const symbols = word.symbols || [];
    if (!numeric(word.text) || symbols.length < 3 || compact(symbols.map(symbol=>symbol.text).join('')) !== compact(word.text)
      || symbols.some(symbol=>!validBox(symbol.bbox,reference))) continue;
    for (let i=1;i<symbols.length;i++) {
      const a=symbols[i-1].bbox,b=symbols[i].bbox,advance=(b.x0+b.x1-a.x0-a.x1)/2;
      if (advance > 0) advances.push(advance);
    }
  }
  advances.sort((a,b)=>a-b);
  // Some scans use a full CJK advance for ASCII digits. Their ordinary glyph
  // gap can exceed 0.7 line heights; measure the typical character advance
  // instead of treating the decimal's white bearing as a column boundary.
  const minimumGap = Math.max((box.y1-box.y0)*.7, advances.length >= 3 ? advances[Math.floor(advances.length/2)]*.95 : 0);
  const groups = [];
  for (const run of runs) {
    if (groups.length && run[0] - groups.at(-1).box[2] <= minimumGap) groups.at(-1).box[2] = run[1];
    else groups.push({ box: [run[0], box.y0, run[1], box.y1], words: [] });
  }
  if (groups.length > 16) return null;
  for (const word of line.words || []) {
    if (!compact(word.text)) continue;
    if (!validBox(word.bbox, reference)) return null;
    const overlaps = groups.filter(group => Math.min(word.bbox.x1, group.box[2]) - Math.max(word.bbox.x0, group.box[0]) > 1);
    if (overlaps.length === 1) { overlaps[0].words.push(word); continue; }
    const symbols = word.symbols || [];
    if (!symbols.length || compact(symbols.map(symbol=>symbol.text).join('')) !== compact(word.text)) return null;
    // A fused OCR word can be split only with its complete character boxes and
    // actual empty image bands. A string alone supplies no split positions.
    for (const symbol of symbols) {
      if (!validBox(symbol.bbox,reference)) return null;
      const hits=groups.filter(group=>Math.min(symbol.bbox.x1,group.box[2])-Math.max(symbol.bbox.x0,group.box[0])>1);
      if (hits.length !== 1) return null;
      hits[0].words.push({...symbol,confidence:word.confidence});
    }
  }
  for (const group of groups) {
    group.text = compact(group.words.map(word => word.text).join(''));
    group.confidence = Math.min(...group.words.map(word => Number.isFinite(word.confidence) ? word.confidence : 0));
    if (!group.text) return null;
  }
  return groups;
}

function matchHeader(text, groups) {
  const cells = groups.map(group => letters(group.text));
  return cells.every(Boolean) && cells.join('') === compact(text) ? cells : null;
}
function matchBody(text, groups) {
  const source = compact(text), cells = groups.map(group => compact(group.text));
  if (cells.join('') === source) return cells;
  // Keep the existing model's nonnumeric first label. Only the independent OCR
  // numeric regions can determine where its concatenated numeric tail splits.
  // This never edits a digit, decimal point, sign, leading zero or amount.
  if (cells.length < 2 || numeric(cells[0]) || !cells.slice(1).every(numeric)) return null;
  const tail = cells.slice(1).join('');
  if (!source.endsWith(tail)) return null;
  const prefix = source.slice(0, source.length - tail.length);
  return /^[\p{L}]+$/u.test(prefix) ? [prefix, ...cells.slice(1)] : null;
}
function assignColumns(groups, template) {
  if (groups.length === template.length) return groups.map((_, index) => index);
  if (groups.length > template.length) return null;
  const cuts = [-Infinity, ...template.slice(1).map((group, i) => (template[i].box[2] + group.box[0]) / 2), Infinity];
  const indexes = groups.map(group => {
    const possible = template.map((_, index) => group.box[0] >= cuts[index] && group.box[2] <= cuts[index + 1] ? index : -1).filter(index => index >= 0);
    return possible.length === 1 ? possible[0] : -1;
  });
  return indexes.every((column,index) => column >= 0 && (!index || column > indexes[index-1])) ? indexes : null;
}
function consistentColumns(rows, count) {
  // Every successive column must have a real empty band in the data rows.
  // Headers may be centered, but must overlap their corresponding data band.
  const body = rows.slice(1), bounds = [];
  for (let column = 0; column < count; column++) {
    const boxes = body.flatMap(row => row.cells[column] ? [row.cells[column].box] : []);
    if (!boxes.length) return false;
    bounds.push([Math.min(...boxes.map(box=>box[0])), Math.max(...boxes.map(box=>box[2]))]);
    const header = rows[0].cells[column].box;
    if (Math.min(header[2], bounds[column][1]) <= Math.max(header[0], bounds[column][0])) return false;
    if (column && bounds[column-1][1] >= bounds[column][0]) return false;
  }
  return true;
}

async function findMatches(candidate, analyzed) {
  const blocks = candidate.blocks, matches = [];
  const sourceLabels = blocks.map(block=>compact(block.text).match(/^[\p{L}]+/u)?.[0] || '');
  for (let first = 0; first + blocks.length <= analyzed.length; first++) {
    const header = analyzed[first];
    if (!header || header.length < 2 || !matchHeader(blocks[0].text, header)) continue;
    const sourceRows = analyzed.slice(first, first + blocks.length);
    const template = sourceRows.slice(1).find(groups => groups?.length === header.length);
    if (!template) continue;
    const rows = [{ cells: header, texts: matchHeader(blocks[0].text, header) }];
    let failed = false;
    for (let i = 1; i < sourceRows.length; i++) {
      const groups = sourceRows[i];
      if (!groups?.length) { failed = true; break; }
      // Equal numeric tails cannot justify pairing a clearly recognized label
      // with a different known source row. Uncertain labels keep the model's
      // original text; they never let a recognized pair be silently swapped.
      const readLabel = compact(groups[0].text);
      if (readLabel !== sourceLabels[i] && sourceLabels.slice(1).includes(readLabel)) { failed = true; break; }
      const texts = matchBody(blocks[i].text, groups), columns = assignColumns(groups, template);
      if (!texts || !columns) { failed = true; break; }
      const row = { cells: Array(header.length).fill(null), texts: Array(header.length).fill('') };
      groups.forEach((group,index) => { row.cells[columns[index]] = group; row.texts[columns[index]] = texts[index]; });
      rows.push(row);
    }
    if (failed || !consistentColumns(rows, header.length) || rows.length * header.length > MAX_CELLS) continue;
    matches.push({ first, last: first + blocks.length - 1, rows });
  }
  return matches;
}

function uniqueOrderedMatches(choices) {
  const solutions = [];
  const visit = (index, previous, chosen) => {
    if (solutions.length > 1) return;
    if (index === choices.length) { solutions.push(chosen); return; }
    for (const choice of choices[index]) if (choice.first > previous) visit(index+1, choice.last, [...chosen,choice]);
  };
  visit(0,-1,[]);
  return solutions.length === 1 ? solutions[0] : null;
}

async function repairScanColumnLayout(manifest, assetRoot, options = {}) {
  throwIfCanceled(options.signal);
  const work = (manifest.pages || []).map(page => ({ page, candidates:[...candidateGroups(page),...detectedTableCandidates(page)].sort((a,b)=>a.indexes[0]-b.indexes[0]) })).filter(item => item.candidates.length);
  if (!work.length) return { manifest, warnings: [] };
  const clone = JSON.parse(JSON.stringify(manifest)), repairedPages = [];
  const dependencies = options.scanColumnDependencies || {};
  for (const { page, candidates } of work) {
    throwIfCanceled(options.signal);
    if (candidates.length > 32) throw unverified(page.pageNumber);
    const reference = await (dependencies.inspectReference || inspectReference)(page, assetRoot, { signal: options.signal });
    try {
      if (reference.rotation !== 0 || !Number.isSafeInteger(reference.width) || !Number.isSafeInteger(reference.height)
        || reference.width * reference.height > LIMITS.maxImagePixels || reference.pixels?.length !== reference.width * reference.height
        || !Array.isArray(reference.lines) || !reference.lines.length || reference.lines.length > 2048) throw unverified(page.pageNumber);
      const analyzed = reference.lines.map(line => imageGroups(line, reference));
      let retries = 0;
      // Low-confidence numeric recognition may be retried in its independently
      // measured image region, never by slicing or correcting a numeric string.
      for (const groups of analyzed) for (const group of groups || []) {
        if (numeric(group.text) && group.confidence < 70 && reference.recognizeRegion && retries < 32) {
          throwIfCanceled(options.signal); retries++;
          const retry = await reference.recognizeRegion(group.box);
          if (numeric(retry.text) && retry.confidence >= 70) { group.text = compact(retry.text); group.confidence = retry.confidence; }
        }
      }
      const choices = [];
      for (const candidate of candidates) choices.push(await findMatches(candidate,analyzed));
      const selected = uniqueOrderedMatches(choices);
      if (!selected) throw unverified(page.pageNumber);
      const changed = clone.pages.find(item => item.pageNumber === page.pageNumber), replacements = new Map(), removed = new Set();
      selected.forEach((match, tableIndex) => {
        const candidate = candidates[tableIndex], indexes = candidate.indexes, columnCount = match.rows[0].cells.length;
        const scale = box => [box[0]*page.width/reference.width,box[1]*page.height/reference.height,box[2]*page.width/reference.width,box[3]*page.height/reference.height];
        const occupied = match.rows.flatMap(row => row.cells.filter(Boolean)), box = [Math.min(...occupied.map(cell=>cell.box[0])),Math.min(...occupied.map(cell=>cell.box[1])),Math.max(...occupied.map(cell=>cell.box[2])),Math.max(...occupied.map(cell=>cell.box[3]))];
        let suffix = tableIndex + 1, id = `scan-columns-${page.pageNumber}-${suffix}`;
        while (changed.tables.some(table => table.id === id)) id = `scan-columns-${page.pageNumber}-${++suffix}`;
        const table = { id, bbox:scale(box), rowCount:match.rows.length,columnCount,confidence:.9,cells:[] };
        match.rows.forEach((row,r) => row.texts.forEach((text,c) => {
          const cell = row.cells[c];
          if (r && cell && numeric(text) && cell.confidence < 70) throw unverified(page.pageNumber);
          const cellBox = cell?.box || [match.rows[0].cells[c].box[0],row.cells.find(Boolean).box[1],match.rows[0].cells[c].box[2],row.cells.find(Boolean).box[3]];
          table.cells.push({ row:r,column:c,rowSpan:1,columnSpan:1,bbox:scale(cellBox),text,
            confidence:cell && compact(cell.text) === text ? Math.max(0,Math.min(1,cell.confidence/100)) : (candidate.blocks[r].confidence || 0) });
        }));
        if (candidate.existingId) changed.tables = changed.tables.filter(existing=>existing.id !== candidate.existingId);
        changed.tables.push(table);changed.tableLike = true;
        replacements.set(indexes[0],{type:'table',tableId:table.id,bbox:table.bbox,confidence:table.confidence});
        indexes.slice(1).forEach(index=>removed.add(index));
      });
      changed.blocks = changed.blocks.flatMap((block,index)=>removed.has(index)?[]:[replacements.get(index)||block]);
      changed.warnings = [...(changed.warnings || []),'PDF_SCAN_COLUMNS_RESTORED'];
      repairedPages.push(page.pageNumber);
    } finally { await reference.dispose?.(); }
  }
  throwIfCanceled(options.signal);
  const validated = (dependencies.validateManifest || validateStructureManifest)(clone, assetRoot);
  return { manifest: validated, warnings: [{ code:'PDF_SCAN_COLUMNS_RESTORED', pageNumbers:repairedPages, messages:{
    zhCN:'已根据原图列间空白和文字坐标恢复扫描表格的独立单元格；请对照原图复核识别文字。',
    enUS:'Separate scanned table cells were recovered from original image gaps and text coordinates. Review recognized text against the source image.'
  }}] };
}

module.exports = { repairScanColumnLayout };
