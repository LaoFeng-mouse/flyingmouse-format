"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { annotatePdfTextRenderStyles } = require("../pdf-text-render-style");

const OPS = { save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77 };
const glyphs = text => Array.from(text, unicode => ({ unicode, width: 500 }));
const item = str => ({ str, fontName: "regular-font", transform: [11, 0, 0, 11, 0, 0] });
const operators = rows => ({ fnArray: rows.map(row => OPS[row[0]]), argsArray: rows.map(row => row[1]) });
const annotate = (items, rows) => annotatePdfTextRenderStyles({
  textContent: { items: items.map(value => typeof value === "string" ? item(value) : value), styles: {} },
  operatorList: operators(rows), OPS
});

test("fill-plus-stroke marks source bold even when the PDF font metadata says regular", () => {
  const output = annotate(["普通字", "描边字"], [
    ["showText", [glyphs("普通字")]], ["setTextRenderingMode", [2]], ["showText", [glyphs("描边字")]]
  ]);
  assert.equal(output.items[0].sourceBold, undefined);
  assert.equal(output.items[1].sourceBold, true);
});

test("save restore and nested Form XObjects restore rendering mode without leaking bold", () => {
  const output = annotate(["甲", "乙", "丙", "丁", "戊"], [
    ["save", []], ["setTextRenderingMode", [2]], ["showText", [glyphs("甲")]],
    ["paintFormXObjectBegin", []], ["setTextRenderingMode", [0]], ["showText", [glyphs("乙")]],
    ["beginGroup", []], ["setTextRenderingMode", [1]], ["showText", [glyphs("丙")]],
    ["endGroup", []], ["paintFormXObjectEnd", []], ["showText", [glyphs("丁")]],
    ["restore", []], ["showText", [glyphs("戊")]]
  ]);
  assert.deepEqual(output.items.map(x => x.sourceBold), [true, undefined, true, true, undefined]);
});

test("beginText and endText do not reset the saved PDF text rendering mode", () => {
  const output = annotate(["第一段", "第二段"], [
    ["setTextRenderingMode", [2]], ["beginText", []], ["showText", [glyphs("第一段")]],
    ["endText", []], ["beginText", []], ["showText", [glyphs("第二段")]], ["endText", []]
  ]);
  assert.deepEqual(output.items.map(x => x.sourceBold), [true, true]);
});

test("only painted stroke modes mark source bold; invisible and clipping-only modes do not", () => {
  const text = "01234567", rows = [];
  for (let mode = 0; mode <= 7; mode++) rows.push(["setTextRenderingMode", [mode]], ["showText", [glyphs(String(mode))]]);
  const output = annotate([...text], rows);
  assert.deepEqual(output.items.map(x => x.sourceBold), [undefined, true, true, undefined, undefined, true, true, undefined]);
});

test("glyph Unicode aligns across text-item boundaries and ignores only layout whitespace and TJ offsets", () => {
  const output = annotate(["章 节", "A\tB", { type: "beginMarkedContent" }, "\n", "😀"], [
    ["setTextRenderingMode", [2]], ["showSpacedText", [[...glyphs("章节 A"), -120, ...glyphs(" B😀")]]]
  ]);
  assert.deepEqual(output.items.map(x => x.sourceBold), [true, true, undefined, undefined, true]);
});

test("an item containing both ordinary and stroked glyphs stays unmarked", () => {
  const output = annotate(["AB", "C"], [["showText", [glyphs("A")]], ["setTextRenderingMode", [2]], ["showText", [glyphs("BC")]]]);
  assert.equal(output.items[0].sourceBold, undefined);
  assert.equal(output.items[1].sourceBold, true);
});

test("one mismatched or extra glyph invalidates the entire association rather than guessing repeated words", () => {
  for (const operatorText of ["AAX", "AAA", "AB", "A"]) {
    const output = annotate(["AA"], [["setTextRenderingMode", [2]], ["showText", [glyphs(operatorText)]]]);
    assert.equal(output.items[0].sourceBold, undefined);
  }
});

test("repeated identical text uses sequential occurrence styles rather than a text lookup map", () => {
  const output = annotate(["同字", "同字"], [["showText", [glyphs("同字")]], ["setTextRenderingMode", [2]], ["showText", [glyphs("同字")]]]);
  assert.deepEqual(output.items.map(x => x.sourceBold), [undefined, true]);
});

test("malformed glyphs modes or graphics-state nesting fail closed", () => {
  for (const rows of [
    [["setTextRenderingMode", [2]], ["showText", [[{ fontChar: "A" }]]]],
    [["setTextRenderingMode", [2]], ["showText", [["A"]]]],
    [["setTextRenderingMode", [8]], ["showText", [glyphs("A")]]],
    [["restore", []], ["setTextRenderingMode", [2]], ["showText", [glyphs("A")]]],
    [["save", []], ["setTextRenderingMode", [2]], ["showText", [glyphs("A")]]],
    [["beginGroup", []], ["setTextRenderingMode", [2]], ["showText", [glyphs("A")]], ["restore", []]]
  ]) assert.equal(annotate(["A"], rows).items[0].sourceBold, undefined);
});

test("missing operators preserve original text and font metadata without trusting stale annotations", () => {
  const original = { items: [{ ...item("A"), sourceBold: true }], styles: { f: { bold: false } } };
  const snapshot = JSON.stringify(original);
  const output = annotatePdfTextRenderStyles({ textContent: original, operatorList: {}, OPS });
  assert.equal(output.items[0].str, "A");
  assert.equal(output.items[0].sourceBold, undefined);
  assert.equal(output.styles.f.bold, false);
  assert.equal(JSON.stringify(original), snapshot);
  assert.notEqual(output.items[0], original.items[0]);
});

test("successful annotation also leaves source text items and styles unchanged", () => {
  const original = { items: [item("A")], styles: { "regular-font": { bold: false } } };
  const output = annotatePdfTextRenderStyles({ textContent: original, operatorList: operators([
    ["setTextRenderingMode", [2]], ["showText", [glyphs("A")]]
  ]), OPS });
  assert.equal(output.items[0].sourceBold, true);
  assert.equal(original.items[0].sourceBold, undefined);
  assert.equal(original.styles["regular-font"].bold, false);
});

test("decoded next-line text variants use glyph Unicode and keep the rendering mode", () => {
  const output = annotate(["AB"], [["setTextRenderingMode", [1]],
    ["nextLineShowText", [glyphs("A")]], ["nextLineSetSpacingShowText", [12, 3, glyphs("B")]]]);
  assert.equal(output.items[0].sourceBold, true);
});
