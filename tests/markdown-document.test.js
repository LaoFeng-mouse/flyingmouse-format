const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const yauzl = require("yauzl");
const { convertText } = require("../text-docx");
const { convertMarkdownDocument, pandocPath } = require("../markdown-document");
const { markdownToHtml } = require("../text-conversion");

async function readPackage(filePath) {
  const buffer = await fsp.readFile(filePath);
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const entries = new Map();
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry) => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("error", reject);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    }));
    zip.readEntry();
  }));
}

const richMarkdown = [
  "# 鼠鼠转换报告", "", "正文 **加粗**、*斜体*、<u>下划线</u>、==重点==。", "",
  "| 名称 | 数值 |", "| --- | --- |", "| 甲 | 42 |", "",
  "1. 第一项", "   - 嵌套子项", "2. 第二项", "", "> 引文", "",
  "```python", "# code, not heading", 'print("**literal** ==literal== $  X  $ <u>literal</u>")', "```", "",
  "行内 $E=mc^2$ 与 \\(a+b\\)。", "", "$$\\frac{1}{2}+\\sqrt{x}$$", "",
  "[链接](https://example.com)", "", "![缺少的图片](missing.png)"
].join("\n");

test("Markdown DOCX preserves semantic structures, literal code and editable equations through the conversion entry point", async (t) => {
  if (!pandocPath() || !fs.existsSync(pandocPath())) return t.skip("Bundled Pandoc is unavailable on this test host");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "markdown-docx-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "报告.md"), output = path.join(dir, "报告.docx");
  await fsp.writeFile(input, `---\ntitle: 元数据标题\nauthor: 牢蜂\nheader-includes: disabled\n---\n\n${richMarkdown}`);
  const result = await convertText(input, output, "md", "docx", "报告.md");
  const entries = await readPackage(output);
  const xml = entries.get("word/document.xml").toString("utf8");
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /元数据标题/);
  assert.match(xml, /牢蜂/);
  assert.ok(result.warnings.some((warning) => warning.code === "MARKDOWN_METADATA_UNSUPPORTED"));
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /w:ilvl w:val="1"/);
  assert.match(xml, /w:pStyle w:val="SourceCode"/);
  assert.match(xml, /\*\*literal\*\* ==literal== \$  X  \$ &lt;u&gt;literal&lt;\/u&gt;/);
  assert.equal((xml.match(/<m:oMath>/g) || []).length, 3);
  assert.match(xml, /<m:f>/);
  assert.match(xml, /<m:rad>/);
  assert.match(xml, /<w:u w:val="single"/);
  assert.match(xml, /<w:highlight w:val="yellow"/);
  assert.match(entries.get("word/_rels/document.xml.rels").toString("utf8"), /https:\/\/example.com/);
  assert.ok(entries.has("word/numbering.xml"));
  assert.ok(result.warnings.some((warning) => warning.code === "MARKDOWN_IMAGE_UNAVAILABLE"));
  assert.match(xml, /缺少的图片/);
});

test("Markdown DOCX embeds supplied local images but cannot read outside the document directory or fetch remote images", async (t) => {
  if (!pandocPath() || !fs.existsSync(pandocPath())) return t.skip("Bundled Pandoc is unavailable on this test host");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "markdown-images-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, "source");
  await fsp.mkdir(sourceDir);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z04AAAAASUVORK5CYII=", "base64");
  await fsp.writeFile(path.join(sourceDir, "local.png"), png);
  await fsp.writeFile(path.join(dir, "outside.png"), png);
  const out = path.join(dir, "images.docx");
  const result = await convertMarkdownDocument("![本地](local.png)\n\n![越界](../outside.png)\n\n![远程](https://example.invalid/pixel.png)", out, { sourceDir });
  const entries = await readPackage(out);
  assert.equal([...entries.keys()].filter((name) => name.startsWith("word/media/")).length, 1);
  assert.equal(result.warnings.filter((warning) => warning.code === "MARKDOWN_IMAGE_UNAVAILABLE").length, 2);
});

test("Markdown DOCX reports a missing engine instead of pretending to convert", async (t) => {
  const previous = process.env.FLYINGMOUSE_PANDOC_PATH;
  process.env.FLYINGMOUSE_PANDOC_PATH = path.join(os.tmpdir(), "nonexistent-flyingmouse-pandoc.exe");
  t.after(() => { if (previous === undefined) delete process.env.FLYINGMOUSE_PANDOC_PATH; else process.env.FLYINGMOUSE_PANDOC_PATH = previous; });
  await assert.rejects(convertMarkdownDocument("# Document", path.join(os.tmpdir(), "must-not-write.docx")), { code: "MARKDOWN_ENGINE_MISSING" });
});

test("HTML mathematics renders offline MathML while fenced and inline code remain literal", () => {
  const html = markdownToHtml("$E=mc^2$ and \\(a+b\\)\n\n$$\\frac{1}{2}$$\n\n```text\n$  X  $\n```\n\n`$X$ ==code==`\n\n<u>under</u> ==highlight==");
  assert.equal((html.match(/<math\b/g) || []).length, 3);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<code class="language-text">\$  X  \$\n<\/code>/);
  assert.match(html, /<code>\$X\$ ==code==<\/code>/);
  assert.match(html, /<u>under<\/u>/);
  assert.match(html, /<mark>highlight<\/mark>/);
  assert.doesNotMatch(html, /<script|cdn\./i);
});

test("unsupported HTML mathematics is a clear conversion error", () => {
  assert.throws(() => markdownToHtml("$\\unsupportedMouseMacro{x}$"), { code: "MARKDOWN_MATH_UNSUPPORTED" });
});

test("format availability follows the Markdown engine and exposes only implemented ebook readers", () => {
  const { targetsForExt } = require("../utils");
  assert.ok(!targetsForExt("md", { libreoffice: true, pandoc: false }).includes("docx"));
  assert.ok(!targetsForExt("markdown", { libreoffice: true, pandoc: false }).includes("pdf"));
  assert.ok(targetsForExt("md", { libreoffice: true, pandoc: true }).includes("pdf"));
  assert.ok(targetsForExt("txt", { libreoffice: false, pandoc: false }).includes("docx"));
  assert.deepEqual(targetsForExt("epub", { libreoffice: true }), ["txt", "md", "html", "pdf", "docx"]);
  assert.deepEqual(targetsForExt("epub", { libreoffice: false }), ["txt", "md", "html"]);
  assert.ok(!targetsForExt("mobi", { libreoffice: true }).includes("html"));
});

test("Markdown PDF uses the same structured document and produces rendered equations through real LibreOffice", { timeout: 180000 }, async (t) => {
  const { LIBREOFFICE_PATH } = require("../config");
  if (!pandocPath() || !fs.existsSync(pandocPath()) || !fs.existsSync(LIBREOFFICE_PATH)) return t.skip("Bundled Pandoc and LibreOffice are required for this integration check");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "markdown-pdf-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "math.md"), output = path.join(dir, "math.pdf");
  await fsp.writeFile(input, "# Equation sample\n\nEnergy $E=mc^2$.\n\n$$\\frac{1}{2}+\\sqrt{x}$$\n\n```text\n**literal**\n```\n");
  await convertText(input, output, "md", "pdf", "math.md");
  const { loadPdfjs } = require("../pdfjs");
  const pdfjs = await loadPdfjs();
  const loading = pdfjs.getDocument({ data: new Uint8Array(await fsp.readFile(output)), isEvalSupported: false, useSystemFonts: true });
  const document = await loading.promise;
  t.after(() => loading.destroy());
  assert.equal(document.numPages, 1);
  const content = await (await document.getPage(1)).getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /Equation sample/);
  assert.match(text, /literal/);
  assert.match(text, /E/);
  assert.match(text, /m\s*c/);
  assert.match(text, /√|x/);
  assert.doesNotMatch(text, /\$|\\frac|\\sqrt/);
});
