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
  convertFb2ToText,
  convertFb2ToMarkdown,
  extractFb2Html,
  convertEbook,
  parseMobiText,
  splitChapters
} = require("../ebook");

const SAMPLES = path.join(__dirname, "fixtures");

// 构造带 data descriptor（局部头 bit3=1、compSize=0、数据后 16 字节 0x08074b50 描述符）
// 的最小 EPUB：7-Zip/流式打包器的标准写法，旧版 readZipEntriesSync 按局部头顺序扫
// 会读到 0 字节数据断链 ->「EPUB 转换几乎全失败」用户反馈的根因（2026-08-31 实测复现）。
function buildDataDescriptorEpub(targetPath) {
  const zlib = require("node:zlib");
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      c = (crc ^ buf[i]) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const entries = [
    { name: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
    { name: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`) },
    { name: "OEBPS/content.opf", data: Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine></package>`) },
    { name: "OEBPS/c1.xhtml", data: Buffer.from(`<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>
<body><p>Hello descriptor world</p></body></html>`) }
  ];
  const parts = [];
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const nameB = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const comp = e.store ? e.data : zlib.deflateRawSync(e.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.store ? 0 : 0x08, 6); // bit3 = data descriptor
    lfh.writeUInt16LE(e.store ? 0 : 8, 8);
    lfh.writeUInt16LE(nameB.length, 26);
    let piece = Buffer.concat([lfh, nameB, comp]);
    if (!e.store) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(comp.length, 8);
      dd.writeUInt32LE(e.data.length, 12);
      piece = Buffer.concat([piece, dd]);
    }
    central.push({ name: e.name, nameB, crc, comp, raw: e.data, method: e.store ? 0 : 8, lfhOffset: offset });
    parts.push(piece);
    offset += piece.length;
  }
  const cdOffset = offset;
  for (const c of central) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(c.method, 10);
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.comp.length, 20);
    cdh.writeUInt32LE(c.raw.length, 24);
    cdh.writeUInt16LE(c.nameB.length, 28);
    cdh.writeUInt32LE(c.lfhOffset, 42);
    parts.push(Buffer.concat([cdh, c.nameB]));
  }
  const cdSize = parts.slice(central.length ? parts.length - central.length : 0).reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  parts.push(eocd);
  require("node:fs").writeFileSync(targetPath, Buffer.concat(parts));
}

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

test("EPUB with data descriptor entries (7-Zip style zip) converts to TXT", async () => {
  // 7-Zip 等流式打包器写 bit3+compSize=0 的 zip，旧解析器读 0 字节断链（用户「几乎全失败」反馈）
  const dir = await tmpDir();
  try {
    const epub = path.join(dir, "dd.epub");
    buildDataDescriptorEpub(epub);
    const out = path.join(dir, "dd.txt");
    await convertEpubToText(epub, out);
    const text = await fsp.readFile(out, "utf8");
    assert.ok(text.includes("Hello descriptor world"), "data-descriptor epub must extract text");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

// ---- MOBI/KF8 加固 + azw3/fb2 输入（2026-08-31 新增）----

// 构造最小 PalmDOC/MOBI 容器（仅头部 + 空文本记录），用于触发 magic/加密校验错误。
function buildPalmDocMobi({ encryption = 0, magic = "BOOKMOBI" } = {}) {
  const numRecords = 1;
  const r0 = 78 + (numRecords + 1) * 8; // PDB 头 78 + 记录表 (n+1)*8
  const total = r0 + 16 + 4; // record0 至少有 16 字节 PalmDOC 头 + 若干
  const buf = Buffer.alloc(total, 0);
  buf.write(magic, 60, "latin1");
  buf.writeUInt16BE(numRecords, 76);
  buf.writeUInt32BE(r0, 78);
  buf.writeUInt32BE(r0, 78 + 8);
  buf.writeUInt16BE(2, r0); // compression=2 (zlib)
  buf.writeUInt16BE(1, r0 + 8); // recordCount=1
  buf.writeUInt16BE(encryption, r0 + 12); // encryption
  return buf;
}

test("parseMobiText rejects a non-MOBI buffer (bad PDB magic)", () => {
  assert.throws(() => parseMobiText(buildPalmDocMobi({ magic: "XXXXXXXX" })), /不是有效的 MOBI\/AZW3/);
});

test("parseMobiText rejects a DRM-encrypted MOBI", () => {
  assert.throws(() => parseMobiText(buildPalmDocMobi({ encryption: 1 })), /DRM|加密/);
});

test("AZW3 routes through the MOBI parser and converts to TXT", async () => {
  const mobi = path.join(SAMPLES, "alice.mobi");
  if (!require("node:fs").existsSync(mobi)) return;
  const dir = await tmpDir();
  try {
    const azw3 = path.join(dir, "alice.azw3");
    await fsp.copyFile(mobi, azw3);
    const out = path.join(dir, "alice-azw3.txt");
    await convertEbook(azw3, out, "azw3", "txt", "alice.azw3");
    const text = await fsp.readFile(out, "utf8");
    assert.ok(text.length > 1000, "azw3 text must be substantial");
    assert.match(text, /Alice/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const FB2_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<description><title-info><book-title>Test Book</book-title></title-info></description>
<body>
<title><p>Chapter One</p></title>
<section>
<title><p>Section Title</p></title>
<p>First paragraph of the body.</p>
<p>Second paragraph &amp; more text.</p>
<subtitle>A subtitle</subtitle>
</section>
<section><p>Final paragraph.</p></section>
</body>
</FictionBook>`;

test("FB2 to TXT extracts body text (excludes description metadata)", async () => {
  const dir = await tmpDir();
  try {
    const fb2 = path.join(dir, "book.fb2");
    await fsp.writeFile(fb2, FB2_SAMPLE, "utf8");
    const out = path.join(dir, "book.txt");
    await convertFb2ToText(fb2, out);
    const text = await fsp.readFile(out, "utf8");
    assert.match(text, /Chapter One/);
    assert.match(text, /First paragraph of the body/);
    assert.match(text, /Final paragraph/);
    assert.doesNotMatch(text, /book-title/); // description 被排除
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("FB2 to Markdown emits headings and paragraphs", async () => {
  const dir = await tmpDir();
  try {
    const fb2 = path.join(dir, "book.fb2");
    await fsp.writeFile(fb2, FB2_SAMPLE, "utf8");
    const out = path.join(dir, "book.md");
    await convertFb2ToMarkdown(fb2, out);
    const md = await fsp.readFile(out, "utf8");
    assert.match(md, /^#{1,6}\s.*Section Title|^#{1,6}\s.*Chapter One/m);
    assert.match(md, /First paragraph of the body/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("FB2 in a ZIP container (.fb2.zip) converts to TXT", async () => {
  const yazl = require("yazl");
  const dir = await tmpDir();
  try {
    const fb2 = path.join(dir, "book.fb2");
    await fsp.writeFile(fb2, FB2_SAMPLE, "utf8");
    const zipPath = path.join(dir, "book.fb2.zip");
    await new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addFile(fb2, path.basename(fb2));
      zip.outputStream.pipe(require("node:fs").createWriteStream(zipPath)).on("close", resolve).on("error", reject);
      zip.end();
    });
    const out = path.join(dir, "zipped.txt");
    await convertFb2ToText(zipPath, out);
    const text = await fsp.readFile(out, "utf8");
    assert.match(text, /First paragraph of the body/);
    assert.match(text, /Final paragraph/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
