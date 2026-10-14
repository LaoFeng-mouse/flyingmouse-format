'use strict';

// This only maps a known, single painted underline to its native glyphs.
// Unclassified rules retain their identity; callers must not claim them as
// text decoration or silently discard them on the strength of this helper.
function mapInlineUnderlines(glyphs, vectors) {
  const underlines = new Map(), matchedVectors = [], unmatchedVectors = [];
  const validGlyphs = (glyphs || []).filter(g => g && Number.isFinite(g.x)
    && Number.isFinite(g.y) && Number.isFinite(g.height) && g.height > 0
    && Array.isArray(g.bbox) && Number.isFinite(g.bbox[2]) && g.bbox[2] > g.x
    && Number.isInteger(g.lineIndex));
  for (const vector of vectors || []) {
    const b = vector?.bbox, color = vector?.color;
    if (vector?.kind !== 'stroke' || vector.singleHorizontal !== true
      || vector.dashed !== false || !Number.isFinite(vector.lineWidth)
      || vector.lineWidth < 0.2 || vector.lineWidth > 0.8
      || !/^[\da-f]{6}$/i.test(color || '')
      || Math.min(...[0,2,4].map(i => parseInt(color.slice(i,i+2),16))) > 230
      || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)
      || b[2] <= b[0] || Math.abs(b[3]-b[1]) > 0.1) {
      unmatchedVectors.push(vector); continue;
    }
    const y = (b[1]+b[3])/2;
    const covered = validGlyphs.filter(g => {
      const offset = y-g.y;
      const overlap = Math.min(b[2],g.bbox[2])-Math.max(b[0],g.x);
      return offset >= -g.height*0.06 && offset <= g.height*0.4
        && overlap >= (g.bbox[2]-g.x)*0.5;
    }).sort((a,b) => a.x-b.x);
    if (!covered.length || new Set(covered.map(g => g.lineIndex)).size !== 1) {
      unmatchedVectors.push(vector); continue;
    }
    const first = covered[0], last = covered.at(-1);
    const edgeTolerance = Math.max(1,Math.min(first.height,last.height)*0.55);
    const hasLargeGap = covered.some((g,i) => i > 0
      && g.x-covered[i-1].bbox[2] > Math.min(g.height,covered[i-1].height)*0.8);
    const conflictingStyle = covered.some(g => underlines.has(g)
      && underlines.get(g).color !== color.toUpperCase());
    if (Math.abs(b[0]-first.x) > edgeTolerance
      || Math.abs(b[2]-last.bbox[2]) > edgeTolerance || hasLargeGap || conflictingStyle) {
      unmatchedVectors.push(vector); continue;
    }
    for (const glyph of covered) underlines.set(glyph,{type:'single',color:color.toUpperCase()});
    matchedVectors.push(vector);
  }
  return {underlines,matchedVectors,unmatchedVectors};
}

module.exports = {mapInlineUnderlines};
