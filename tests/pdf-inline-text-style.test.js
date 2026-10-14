const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mapInlineUnderlines} = require('../pdf-inline-text-style');

function line(text, x=20, y=50, lineIndex=0) {
  return [...text].map((text,i)=>({text,x:x+i*12,y,height:12,lineIndex,bbox:[x+i*12,y-12,x+(i+1)*12,y+2.4]}));
}
const rule = (bbox,extra={}) => ({bbox,kind:'stroke',singleHorizontal:true,dashed:false,lineWidth:0.57,color:'000000',...extra});

test('a native answer underline decorates only its covered answer glyphs',()=>{
  const glyphs=line('题干答案'),vector=rule([44,51.5,68,51.5]);
  const result=mapInlineUnderlines(glyphs,[vector]);
  assert.deepEqual([...result.underlines.keys()].map(g=>g.text),['答','案']);
  assert.deepEqual(result.underlines.get(glyphs[2]),{type:'single',color:'000000'});
  assert.equal(result.matchedVectors.length,1);
});

test('underline paint color stays independent from emphasized text color',()=>{
  const glyphs=line('红答案').map(g=>({...g,color:'FF0000'}));
  const result=mapInlineUnderlines(glyphs,[rule([20,52,56,52],{color:'1234ab'})]);
  assert.equal(result.underlines.size,3);
  assert.equal(result.underlines.get(glyphs[0]).color,'1234AB');
});

test('nearby page separators and strike-through rules are not underlines',()=>{
  const glyphs=line('普通正文');
  const vectors=[rule([0,52,595,52]),rule([20,60,68,60]),rule([20,44,68,44])];
  const result=mapInlineUnderlines(glyphs,vectors);
  assert.equal(result.underlines.size,0);
  assert.equal(result.unmatchedVectors.length,3);
});

test('unknown paint, dashed lines, thick rules and partial letters remain unclassified',()=>{
  const glyphs=line('答案');
  const vectors=[rule([20,52,44,52],{dashed:true}),rule([20,52,44,52],{singleHorizontal:false}),
    rule([20,52,44,52],{kind:'fill'}),rule([20,52,44,52],{lineWidth:2}),
    rule([20,52,44,52],{color:'FFFFFF'}),rule([20,52,23,52])];
  const result=mapInlineUnderlines(glyphs,vectors);
  assert.equal(result.underlines.size,0);
  assert.equal(result.unmatchedVectors.length,vectors.length);
});

test('a rule spanning disconnected columns is not promoted to a text underline',()=>{
  const glyphs=[...line('甲'),...line('乙',70)];
  const result=mapInlineUnderlines(glyphs,[rule([20,52,82,52])]);
  assert.equal(result.underlines.size,0);
});

test('ambiguous overlapping text lines do not acquire decoration',()=>{
  const glyphs=[...line('答案'),...line('另行',20,51,1)];
  const result=mapInlineUnderlines(glyphs,[rule([20,52,44,52])]);
  assert.equal(result.underlines.size,0);
});
