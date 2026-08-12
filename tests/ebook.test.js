const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { test } = require("node:test");

const {
  convertTextToEpub,
  convertEpubToText,
  convertEpubToMarkdown,
  convertMobiToText,
  splitChapters
} = require("../ebook");

const SAMPLES = "C:\\Users\\34615\\Documents\\Codex\\2026-08-08\\zhi\\samples";

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ebook-test-"));
}

test("txt to EPUB produces a valid ZIP package with mimetype, opf and ncx", async () => {
  const dir = await tmpDir();
  try {
    const out = path.join(dir, "book.epub");
    await convertTextToEpub("# 第一章\n\n内容甲。\n\n## 第二章\n\n内容乙。", "md", "测试书.txt", out);
    const buf = await fsp.readFile(out);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "epub must be a zip");
    const latin = buf.toString("latin1");
    // mimetype 条目名与内容（zip 局部头 + 文件名可查，内容可能在压缩流中）
    assert.ok(latin.includes("mimetype"), "mimetype entry must exist");
    assert.ok(latin.includes("META-INF/container.xml"), "container.xml entry must exist");
    assert.ok(latin.includes("OEBPS/content.opf"), "content.opf entry must exist");
    assert.ok(latin.includes("OEBPS/toc.ncx"), "toc.ncx entry must exist");
    assert.ok(latin.includes("OEBPS/chapter-1.xhtml"), "chapter 1 must exist");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("splitChapters splits markdown by headings and txt by blocks", () => {
  const md = "# A\n\nbody1\n\n## B\n\nbody2";
  const mdParts = splitChapters(md, "md");
  assert.ok(mdParts.length >= 2);
  assert.equal(mdParts[0].title, "A");
  assert.ok(mdParts[0].body.includes("body1"));

  const txt = "para one\n\npara two\n\npara three";
  const txtParts = splitChapters(txt, "txt");
  assert.ok(txtParts.length >= 1);
  assert.ok(txtParts[0].body.includes("para one"));
});

test("EPUB to TXT extracts readable text from a real Gutenberg epub", async () => {
  const epub = path.join(SAMPLES, "alice.epub");
  if (!require("node:fs").existsSync(epub)) return; // 样本缺失时跳过
  const dir = await tmpDir();
  try {
    const out = path.join(dir, "alice.txt");
    await convertEpubToText(epub, out);
    const text = await fsp.readFile(out, "utf8");
    assert.ok(text.length > 1000, "extracted text must be substantial");
    assert.match(text, /Alice/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("MOBI to TXT parses PalmDOC records from a real Gutenberg mobi", async () => {
  const mobi = path.join(SAMPLES, "alice.mobi");
  if (!require("node:fs").existsSync(mobi)) return;
  const dir = await tmpDir();
  try {
    const out = path.join(dir, "alice-mobi.txt");
    await convertMobiToText(mobi, out);
    const text = await fsp.readFile(out, "utf8");
    assert.ok(text.length > 1000, "mobi text must be substantial");
    assert.match(text, /Alice/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
