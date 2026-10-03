"use strict";

const MAX_OPERATORS = 250000;
const MAX_CHARACTERS = 1000000;

// PDF text rendering mode is part of the saved graphics state. BT/ET reset
// text matrices, not Tr. PDF.js Form XObjects and groups save/restore implicitly.
// Only glyph Unicode is used; fontChar is a drawing code, not extracted text.
function renderingCharacters(operatorList, OPS) {
  const functions = operatorList?.fnArray, argumentsList = operatorList?.argsArray;
  if (!Array.isArray(functions) || !Array.isArray(argumentsList)
    || functions.length !== argumentsList.length || functions.length > MAX_OPERATORS
    || !Number.isInteger(OPS?.showText) || !Number.isInteger(OPS?.setTextRenderingMode)) return null;
  const characters = [], stroked = [], stack = [];
  let mode = 0;
  const is = (value, name) => Number.isInteger(OPS[name]) && value === OPS[name];
  function appendGlyphs(glyphs) {
    if (!Array.isArray(glyphs)) return false;
    for (const glyph of glyphs) {
      // TJ numeric entries adjust placement without drawing a character.
      if (typeof glyph === "number" && Number.isFinite(glyph)) continue;
      if (!glyph || typeof glyph !== "object" || typeof glyph.unicode !== "string"
        || (!glyph.unicode && !glyph.isSpace)) return false;
      for (const character of glyph.unicode) {
        if (/\s/u.test(character)) continue;
        if (characters.length >= MAX_CHARACTERS) return false;
        characters.push(character);
        stroked.push(mode === 1 || mode === 2 || mode === 5 || mode === 6);
      }
    }
    return true;
  }
  for (let index = 0; index < functions.length; index++) {
    const fn = functions[index], args = argumentsList[index];
    if (is(fn, "save") || is(fn, "paintFormXObjectBegin") || is(fn, "beginGroup")) {
      stack.push({ mode, kind: is(fn, "save") ? "save" : is(fn, "beginGroup") ? "group" : "form" });
    } else if (is(fn, "restore") || is(fn, "paintFormXObjectEnd") || is(fn, "endGroup")) {
      const expected = is(fn, "restore") ? "save" : is(fn, "endGroup") ? "group" : "form";
      const previous = stack.pop();
      if (!previous || previous.kind !== expected) return null;
      mode = previous.mode;
    } else if (is(fn, "setTextRenderingMode")) {
      if (!Array.isArray(args) || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 7) return null;
      mode = args[0];
    } else if (is(fn, "showText") || is(fn, "showSpacedText") || is(fn, "nextLineShowText")) {
      if (!Array.isArray(args) || !appendGlyphs(args[0])) return null;
    } else if (is(fn, "nextLineSetSpacingShowText")) {
      if (!Array.isArray(args) || !appendGlyphs(args[2])) return null;
    }
  }
  return stack.length ? null : { characters, stroked };
}

function annotatePdfTextRenderStyles({ textContent, operatorList, OPS } = {}) {
  if (!textContent || !Array.isArray(textContent.items)) return textContent;
  const items = textContent.items.map(item => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    delete copy.sourceBold;
    return copy;
  });
  const result = { ...textContent, items };
  const rendered = renderingCharacters(operatorList, OPS);
  if (!rendered) return result;
  let cursor = 0;
  const matchedItems = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    let count = 0, allStroked = true;
    for (const character of item.str) {
      if (/\s/u.test(character)) continue;
      if (cursor >= rendered.characters.length || character !== rendered.characters[cursor]) return result;
      allStroked = allStroked && rendered.stroked[cursor];
      cursor++;
      count++;
    }
    if (count && allStroked) matchedItems.push(item);
  }
  // No searching past a mismatch: repeated words and extra/invisible text can
  // otherwise transfer another occurrence's style to an unrelated item.
  if (cursor !== rendered.characters.length) return result;
  for (const item of matchedItems) item.sourceBold = true;
  return result;
}

module.exports = { annotatePdfTextRenderStyles };
