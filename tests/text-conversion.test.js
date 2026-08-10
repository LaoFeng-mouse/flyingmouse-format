const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createTurndownService,
  htmlToMarkdown,
  csvToJsonObjects,
  jsonToCsv,
  markdownToHtml
} = require("../text-conversion");

test("Markdown converts semantic inline and block structures to HTML", () => {
  const html = markdownToHtml(`# Heading

This has *emphasis*, **strong text**, and [a link](https://example.com).

1. First
2. Second

- Mouse
- Format

\`\`\`js
const value = 1;
\`\`\`
`);
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<strong>strong text<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com">a link<\/a>/);
  assert.match(html, /<ol>[\s\S]*<li>First<\/li>[\s\S]*<li>Second<\/li>[\s\S]*<\/ol>/);
  assert.match(html, /<ul>[\s\S]*<li>Mouse<\/li>[\s\S]*<li>Format<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<pre><code class="language-js">const value = 1;\n<\/code><\/pre>/);
});

test("Markdown conversion rejects executable link protocols and raw HTML", () => {
  const html = markdownToHtml(`[bad](javascript:alert(1))

<script>alert("bad")</script>`);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
});

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

test("HTML converts simple tables to Markdown with escaped pipes and line breaks", () => {
  const markdown = htmlToMarkdown(`
    <table>
      <thead><tr><th>Name</th><th>Details</th></tr></thead>
      <tbody>
        <tr><td>Mouse | Format</td><td>First<br>Second</td></tr>
        <tr><td>Plain</td><td><p>Line one</p><p>Line two</p></td></tr>
      </tbody>
    </table>
  `);

  assert.equal(markdown, [
    "| Name | Details |",
    "| --- | --- |",
    "| Mouse \\| Format | First<br>Second |",
    "| Plain | Line one<br>Line two |"
  ].join("\n"));
});

test("HTML preserves spanning tables as sanitized HTML instead of flattening them", () => {
  const markdown = htmlToMarkdown(`
    <table onclick="alert(1)">
      <tr><th rowspan="2">Name</th><th>Value</th></tr>
      <tr><td><script>alert(1)</script><strong>Mouse</strong></td></tr>
    </table>
  `);

  assert.match(markdown, /^<table>/);
  assert.match(markdown, /<th rowspan="2">Name<\/th>/);
  assert.match(markdown, /<strong>Mouse<\/strong>/);
  assert.doesNotMatch(markdown, /onclick|script|alert/i);
  assert.doesNotMatch(markdown, /^\|/m);
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

test("JSON to CSV flattens nested objects, preserves arrays, and uses stable columns", () => {
  const csv = jsonToCsv(JSON.stringify([
    {
      name: "Mouse",
      profile: { score: 3, address: { city: "Shenzhen" } },
      tags: ["cute", { level: 2 }]
    },
    {
      profile: { address: { country: "CN" }, score: 4 },
      name: "Format"
    }
  ]));

  assert.equal(csv, [
    '"name","profile.address.city","profile.address.country","profile.score","tags"',
    '"Mouse","Shenzhen","","3","[""cute"",{""level"":2}]"',
    '"Format","","CN","4",""'
  ].join("\n"));
  assert.doesNotMatch(csv, /\[object Object\]/);
});

test("JSON to CSV column order is independent of object insertion order", () => {
  const first = jsonToCsv('[{"z":1,"nested":{"b":2,"a":3},"a":4}]');
  const second = jsonToCsv('[{"a":4,"nested":{"a":3,"b":2},"z":1}]');

  assert.equal(first, second);
  assert.match(first, /^"a","nested\.a","nested\.b","z"/);
});
