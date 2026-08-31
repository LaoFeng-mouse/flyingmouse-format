// text-docx 单元测试：生成的 docx 必须带真实 HeadingN 样式（styles.xml + w:pStyle），
// 否则 docx->md 走 mammoth 时标题降级普通段落 -> 大纲丢失（2026-08-31 实测修复）。
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { test } = require("node:test");
const yauzl = require("yauzl");

const { convertTextToDocx } = require("../text-docx");
const { convertDocumentToMarkdown, convertDocumentToText } = require("../office-convert");

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-textdocx-test-"));
}

function readZipEntry(zipPath, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) { reject(error); return; }
      zipfile.on("entry", (entry) => {
        if (entry.fileName === entryName) {
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError) { reject(streamError); return; }
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => { zipfile.close(); resolve(Buffer.concat(chunks).toString("utf8")); });
            stream.on("error", reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on("end", () => { zipfile.close(); reject(new Error(`entry not found: ${entryName}`)); });
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

test("text-to-docx writes HeadingN styles so headings survive docx->markdown round trip", async () => {
  const dir = await tmpDir();
  try {
    const docx = path.join(dir, "book.docx");
    await convertTextToDocx("# 大标题\n\n正文段落。\n\n### 三级标题\n\n更多正文。", "md", docx);

    const stylesXml = await readZipEntry(docx, "word/styles.xml");
    assert.match(stylesXml, /w:styleId="Heading1"/, "styles.xml must define Heading1");
    assert.match(stylesXml, /w:styleId="Heading3"/, "styles.xml must define Heading3");

    const documentXml = await readZipEntry(docx, "word/document.xml");
    assert.match(documentXml, /<w:pStyle w:val="Heading1"\/>/, "h1 paragraph must reference Heading1 style");
    assert.match(documentXml, /<w:pStyle w:val="Heading3"\/>/, "h3 paragraph must reference Heading3 style");

    // 端到端：docx -> md 标题必须恢复（修复前 mammoth 把它当普通段落）
    const mdOut = path.join(dir, "book.md");
    await convertDocumentToMarkdown(docx, mdOut, "docx", "book.docx");
    const markdown = await fsp.readFile(mdOut, "utf8");
    assert.match(markdown, /^# 大标题/m, "h1 must survive the round trip");
    assert.match(markdown, /^### 三级标题/m, "h3 must survive the round trip");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("text-to-docx collapses consecutive blank lines into a single empty paragraph", async () => {
  const dir = await tmpDir();
  try {
    const docx = path.join(dir, "blank.docx");
    await convertTextToDocx("第一段。\n\n\n\n\n第二段。", "txt", docx);
    const documentXml = await readZipEntry(docx, "word/document.xml");
    const emptyCount = (documentXml.match(/<w:p><w:pPr><\/w:pPr><w:r><w:t xml:space="preserve"><\/w:t><\/w:r><\/w:p>/g) || []).length;
    const allParagraphs = (documentXml.match(/<w:p[ >]/g) || []).length;
    // 两个内容段 + 至多 1 个空段（连续空行压缩）
    assert.ok(emptyCount <= 1, `consecutive blank lines must collapse (empty=${emptyCount})`);
    assert.ok(allParagraphs <= 3, `paragraph count must not inflate (paragraphs=${allParagraphs})`);

    // docx -> txt 内容完整
    const txtOut = path.join(dir, "blank.txt");
    await convertDocumentToText(docx, txtOut, "docx", "blank.docx");
    const text = await fsp.readFile(txtOut, "utf8");
    assert.ok(text.includes("第一段") && text.includes("第二段"));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
