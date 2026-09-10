const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const yazl = require("yazl");
const { convertEpubToText, convertEpubToMarkdown, convertEpubToHtml, convertTextToEpub, parseMobiText } = require("../ebook");

async function makeEpub(filePath, options = {}) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
  const documents = {
    "META-INF/container.xml": "<container><rootfiles><rootfile full-path='OPS/content.opf'/></rootfiles></container>",
    "OPS/content.opf": `<package><manifest><item href='text/chapter%20one.xhtml' id='a'/><item id='b' href='text/two.xhtml'/></manifest><spine><itemref idref='a'/><itemref idref='b'/></spine></package>`,
    "OPS/text/chapter one.xhtml": `<html><head><title>One</title></head><body><h1>第一章</h1><p>甲 ${options.image ? "<img alt='图片' src='../images/pixel.png' />" : ""}</p></body></html>`,
    "OPS/text/two.xhtml": "<html><body><h1>第二章</h1><p>乙</p></body></html>"
  };
  if (options.missingChapter) delete documents["OPS/text/two.xhtml"];
  if (options.image && !options.missingImage) documents["OPS/images/pixel.png"] = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z04AAAAASUVORK5CYII=", "base64");
  for (const [name, content] of Object.entries(documents)) zip.addReadStream(Readable.from([Buffer.from(content)]), name);
  const written = pipeline(zip.outputStream, fs.createWriteStream(filePath));
  zip.end();
  await written;
}

test("EPUB streaming ZIP descriptors, single-quoted XML and encoded chapter paths preserve every chapter in spine order", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "epub-streaming-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const epub = path.join(dir, "streaming.epub"), output = path.join(dir, "book.txt");
  await makeEpub(epub);
  // Data descriptor signature confirms this fixture cannot be read using sizes
  // from only the local headers, unlike addBuffer-only ZIP fixtures.
  assert.ok((await fsp.readFile(epub)).includes(Buffer.from([0x50, 0x4b, 0x07, 0x08])));
  await convertEpubToText(epub, output);
  const text = await fsp.readFile(output, "utf8");
  assert.match(text, /第一章[\s\S]*甲[\s\S]*第二章[\s\S]*乙/);
});

test("EPUB missing chapters fail before creating an incomplete output", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "epub-missing-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const epub = path.join(dir, "book.epub"), output = path.join(dir, "book.txt");
  await makeEpub(epub, { missingChapter: true });
  await assert.rejects(convertEpubToText(epub, output), { code: "EPUB_CHAPTER_MISSING" });
  assert.equal(fs.existsSync(output), false);
});

test("EPUB HTML and Markdown keep raster image bytes; missing image resources are explicit errors", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "epub-resource-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const epub = path.join(dir, "book.epub"), html = path.join(dir, "book.html"), md = path.join(dir, "book.md");
  await makeEpub(epub, { image: true });
  await convertEpubToHtml(epub, html);
  await convertEpubToMarkdown(epub, md);
  assert.match(await fsp.readFile(html, "utf8"), /src="data:image\/png;base64,iVBOR/);
  assert.match(await fsp.readFile(md, "utf8"), /!\[图片\]\(data:image\/png;base64,iVBOR/);
  await makeEpub(epub, { image: true, missingImage: true });
  await assert.rejects(convertEpubToHtml(epub, path.join(dir, "missing.html")), { code: "EPUB_IMAGE_MISSING" });
});

test("plain text EPUB generation escapes markup and round-trips its original text", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "epub-roundtrip-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const epub = path.join(dir, "book.epub"), txt = path.join(dir, "book.txt");
  await convertTextToEpub("a < b & c > d\n鼠鼠", "txt", "book.txt", epub);
  await convertEpubToText(epub, txt);
  assert.match(await fsp.readFile(txt, "utf8"), /a < b & c > d\n鼠鼠/);
});

function mobiFixture({ compression = 1, chunk = Buffer.from("<p>Hello</p>"), textLength = chunk.length, codepage = 65001, version = 6 } = {}) {
  const record0 = Buffer.alloc(40);
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(textLength, 4);
  record0.writeUInt16BE(1, 8);
  record0.writeUInt16BE(4096, 10);
  record0.write("MOBI", 16);
  record0.writeUInt32BE(24, 20);
  record0.writeUInt32BE(codepage, 28);
  record0.writeUInt32BE(version, 36);
  const header = Buffer.alloc(78 + 16 + 2);
  header.writeUInt16BE(2, 76);
  header.writeUInt32BE(header.length, 78);
  header.writeUInt32BE(header.length + record0.length, 86);
  return Buffer.concat([header, record0, chunk]);
}

test("MOBI uses the actual PDB record count and decodes both uncompressed UTF-8 and PalmDOC backreferences", () => {
  const chinese = Buffer.from("<p>鼠鼠</p>");
  assert.equal(parseMobiText(mobiFixture({ chunk: chinese })), "<p>鼠鼠</p>");
  // abc + distance=3,length=3 backreference + PalmDOC space/H pair.
  const compressed = Buffer.from([0x61, 0x62, 0x63, 0x80, 0x18, 0xc8]);
  assert.equal(parseMobiText(mobiFixture({ compression: 2, chunk: compressed, textLength: 8 })), "abcabc H");
  assert.equal(parseMobiText(mobiFixture({ chunk: Buffer.from([0x63, 0x61, 0x66, 0xe9]), codepage: 1252 })), "café");
});

test("MOBI unsupported compression, KF8, corrupt records and invalid UTF-8 cannot become successful garbage text", () => {
  assert.throws(() => parseMobiText(mobiFixture({ compression: 17480 })), { code: "MOBI_COMPRESSION_UNSUPPORTED" });
  assert.throws(() => parseMobiText(mobiFixture({ version: 8 })), { code: "MOBI_KF8_UNSUPPORTED" });
  assert.throws(() => parseMobiText(mobiFixture({ compression: 2, chunk: Buffer.from([0x80]), textLength: 10 })), { code: "MOBI_INVALID_RECORD" });
  assert.throws(() => parseMobiText(mobiFixture({ chunk: Buffer.from([0xff]), textLength: 1 })), { code: "MOBI_ENCODING_INVALID" });
  assert.throws(() => parseMobiText(mobiFixture({ textLength: 999 })), { code: "MOBI_TEXT_INCOMPLETE" });
});
