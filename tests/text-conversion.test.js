const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createTurndownService,
  htmlToMarkdown,
  csvToJsonObjects
} = require("../text-conversion");

test("HTML converts to structural ATX and fenced Markdown", () => {
  const markdown = htmlToMarkdown(`
    <h1>Hello</h1>
    <ul><li>Mouse</li><li>Format</li></ul>
    <pre><code>const value = 1;</code></pre>
  `);

  assert.match(markdown, /^# Hello/m);
  assert.match(markdown, /^\*\s+Mouse/m);
  assert.match(markdown, /^\*\s+Format/m);
  assert.match(markdown, /```[\s\S]*const value = 1;[\s\S]*```/);
  assert.equal(createTurndownService().options.headingStyle, "atx");
  assert.equal(createTurndownService().options.codeBlockStyle, "fenced");
});

test("CSV parser preserves BOM, commas, escaped quotes and quoted newlines", () => {
  const rows = csvToJsonObjects('\uFEFF"name","description","quote"\r\n"鼠鼠","第一行\r\n第二行","他说""你好"""\r\n');
  assert.deepEqual(rows, [{
    name: "鼠鼠",
    description: "第一行\r\n第二行",
    quote: '他说"你好"'
  }]);
});

test("CSV parser rejects inconsistent record lengths instead of dropping data", () => {
  assert.throws(
    () => csvToJsonObjects("name,description\n鼠鼠\n"),
    /CSV.*列数|CSV.*column/i
  );
});

test("CSV parser rejects duplicate and object-prototype header names", () => {
  assert.throws(() => csvToJsonObjects("name,name\nfirst,second\n"), /CSV.*重复|CSV.*duplicate/i);
  assert.throws(() => csvToJsonObjects("__proto__,value\nunsafe,1\n"), /CSV.*表头|CSV.*header/i);
});
