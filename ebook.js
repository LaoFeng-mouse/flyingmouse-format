// 电子书格式：EPUB 生成/解析 + MOBI 基础解析（实验性）。
// 零新依赖：EPUB 用 yazl/yauzl（项目已有），MOBI 文本记录走 zlib（Node 内置）。
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const yazl = require("yazl");

const { htmlToMarkdown } = require("./text-conversion");

// 与 server.js 的 htmlToText 同逻辑（ebook.js 独立模块，避免循环依赖）
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cleanTitle(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 80) || "Book";
}

// ---- EPUB 生成 ----

// 把 txt/md/html 文本拆成章节（md 按标题，其他按空行分块）。
function splitChapters(raw, source) {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  if (source === "md" || source === "markdown") {
    const parts = [];
    const blocks = text.split(/\n(?=#{1,6}\s)/);
    for (const block of blocks) {
      const titleMatch = /^#{1,6}\s+(.+)$/m.exec(block);
      const body = block.replace(/^#{1,6}\s+.+$/m, "").trim();
      if (!parts.length || titleMatch) {
        parts.push({ title: titleMatch ? titleMatch[1].trim() : `第 ${parts.length + 1} 章`, body });
      } else {
        const last = parts[parts.length - 1];
        last.body = `${last.body}\n\n${body}`;
      }
    }
    return parts.filter((part) => part.body || part.title);
  }
  // txt/html：按空行分块，合并小段
  const paragraphs = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const parts = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (buffer.length > 2000 || parts.length >= 99) {
      parts.push({ title: `第 ${parts.length + 1} 节`, body: buffer });
      buffer = "";
    }
  }
  if (buffer) parts.push({ title: `第 ${parts.length + 1} 节`, body: buffer });
  return parts.length ? parts : [{ title: "正文", body: text }];
}

function markdownToXhtml(source, body) {
  const lines = String(body || "").split("\n");
  const html = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      if (inList) { html.push("</ul>"); inList = false; }
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${escapeHtmlText(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${escapeHtmlText(bullet[1])}</li>`);
      continue;
    }
    if (inList) { html.push("</ul>"); inList = false; }
    if (trimmed) html.push(`<p>${escapeHtmlText(trimmed)}</p>`);
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

async function convertTextToEpub(raw, source, originalName, outputPath) {
  const title = cleanTitle(path.basename(originalName || "book", path.extname(originalName || "")));
  const chapters = splitChapters(raw, source);
  const zip = new yazl.ZipFile();
  // EPUB 规范：mimetype 必须是第一个条目且不压缩
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compressionLevel: 0 });
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`), "META-INF/container.xml");

  const manifest = [`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`];
  const spine = [];
  const chapterDocs = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const id = `chapter-${index + 1}`;
    const xhtml = source === "md" || source === "markdown" ? markdownToXhtml(source, chapters[index].body) : chapters[index].body;
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXmlText(chapters[index].title)}</title></head>
<body>
<h1>${escapeXmlText(chapters[index].title)}</h1>
${xhtml}
</body>
</html>`;
    chapterDocs.push(doc);
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
  }

  const navPoints = chapters.map((chapter, index) =>
    `    <navPoint id="nav-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXmlText(chapter.title)}</text></navLabel><content src="chapter-${index + 1}.xhtml"/></navPoint>`
  ).join("\n");

  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXmlText(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:${require("crypto").randomUUID()}</dc:identifier>
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine toc="ncx">
${spine.join("\n")}
  </spine>
</package>`), "OEBPS/content.opf");
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="bookid"/></head>
  <docTitle><text>${escapeXmlText(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`), "OEBPS/toc.ncx");
  for (let index = 0; index < chapterDocs.length; index += 1) {
    zip.addBuffer(Buffer.from(chapterDocs[index]), `OEBPS/chapter-${index + 1}.xhtml`);
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

// ---- EPUB 解析 ----

function readZipEntriesSync(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = new Map();
  let offset = 0;
  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    offset = dataStart + compSize;
  }
  return entries;
}

async function epubSpineXhtml(entries) {
  const container = entries.get("META-INF/container.xml") || [...entries.entries()].find(([name]) => name.toLowerCase().endsWith("container.xml"))?.[1];
  if (!container) throw new Error("EPUB 解析失败：缺少 META-INF/container.xml。");
  const rootfile = /full-path="([^"]+)"/.exec(container.toString("utf8"));
  if (!rootfile) throw new Error("EPUB 解析失败：container.xml 缺少 rootfile。");
  const opfPath = rootfile[1];
  const opf = entries.get(opfPath);
  if (!opf) throw new Error(`EPUB 解析失败：找不到 ${opfPath}。`);
  const opfText = opf.toString("utf8");
  const baseDir = path.posix.dirname(opfPath) === "." ? "" : `${path.posix.dirname(opfPath)}/`;
  const spineIds = [...opfText.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  // item 标签属性顺序不定（href 可能在 id 前），逐个标签解析
  const idHref = new Map();
  for (const match of opfText.matchAll(/<item\b[^>]*>/g)) {
    const tag = match[0];
    const id = /id="([^"]+)"/.exec(tag);
    const href = /href="([^"]+)"/.exec(tag);
    if (id && href) idHref.set(id[1], href[1]);
  }
  const spineHrefs = spineIds.map((id) => idHref.get(id)).filter(Boolean);
  const xhtml = [];
  for (const href of spineHrefs) {
    const normalized = href.startsWith(baseDir) ? href : `${baseDir}${href}`;
    const entry = entries.get(normalized) || entries.get(href);
    if (entry) xhtml.push(entry.toString("utf8"));
  }
  if (!xhtml.length) throw new Error("EPUB 解析失败：spine 中没有可读内容。");
  return xhtml;
}

async function convertEpubToText(inputPath, outputPath) {
  const entries = readZipEntriesSync(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const text = xhtmls.map((html) => htmlToText(html)).filter(Boolean).join("\n\n");
  if (!text.trim()) throw new Error("EPUB 解析失败：未提取到任何文本。");
  await fsp.writeFile(outputPath, `${text.trim()}\n`, "utf8");
}

async function convertEpubToMarkdown(inputPath, outputPath) {
  const entries = readZipEntriesSync(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const markdown = xhtmls.map((html) => htmlToMarkdown(html)).filter(Boolean).join("\n\n");
  if (!markdown.trim()) throw new Error("EPUB 解析失败：未提取到任何内容。");
  await fsp.writeFile(outputPath, `${markdown.trim()}\n`, "utf8");
}

// ---- MOBI 解析（实验性：PalmDOC + zlib 文本记录） ----

function parseMobiText(buffer) {
  // MOBI 文件是 PDB 容器：PalmDB header(78 字节) + 记录表(每条 8 字节) + 记录数据。
  // 记录 0 = MOBI header（其前 16 字节是 PalmDOC header：compression/textLength/recordCount），
  // 文本记录从记录 1 开始。
  if (buffer.length < 78) throw new Error("MOBI 解析失败：文件头不完整。");
  const numRecords = buffer.readUInt16BE(76);
  const recordListOffset = 78;
  if (recordListOffset + (numRecords + 1) * 8 > buffer.length || numRecords <= 0 || numRecords > 20000) {
    throw new Error("MOBI 解析失败：记录数不合法。");
  }
  const offsets = [];
  for (let index = 0; index <= numRecords; index += 1) {
    offsets.push(buffer.readUInt32BE(recordListOffset + index * 8));
  }
  const record0 = offsets[0];
  if (record0 + 16 > buffer.length) throw new Error("MOBI 解析失败：PalmDOC 头缺失。");
  const compression = buffer.readUInt16BE(record0);
  const recordCount = buffer.readUInt16BE(record0 + 8);
  if (recordCount <= 0 || recordCount > numRecords) throw new Error("MOBI 解析失败：文本记录数不合法。");

  const recordData = [];
  for (let index = 1; index <= recordCount && index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1] || buffer.length;
    if (start >= end || start >= buffer.length) break;
    const chunk = buffer.subarray(start, end);
    // 自动探测：zlib（带/不带 2 字节长度前缀）、raw deflate，全部失败按明文追加
    // （部分 KF8 文件的文本记录实际未压缩，compression 字段与内容不符）
    const attempts = [
      () => zlib.inflateSync(chunk),
      () => zlib.inflateRawSync(chunk),
      () => zlib.inflateSync(chunk.subarray(2)),
      () => zlib.inflateRawSync(chunk.subarray(2))
    ];
    let decompressed = null;
    for (const attempt of attempts) {
      try {
        decompressed = attempt();
        break;
      } catch {
        // try next
      }
    }
    recordData.push(decompressed || chunk);
  }
  const html = Buffer.concat(recordData).toString("utf8");
  const cleaned = html
    .replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<mbp:[^>]*>[\s\S]*?<\/mbp:[^>]*>/gi, "")
    .replace(/<mbp:[^>]*\/?>/gi, "")
    .replace(/<exthml[^>]*>[\s\S]*?<\/exthml>/gi, "")
    .replace(/<html[^>]*>[\s\S]*?<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*?<\/html>/i, "");
  if (!cleaned.replace(/<[^>]+>/g, "").trim()) throw new Error("MOBI 解析失败：未提取到文本内容。");
  return cleaned;
}

async function convertMobiToText(inputPath, outputPath) {
  const buffer = await fsp.readFile(inputPath);
  const html = parseMobiText(buffer);
  const text = htmlToText(html);
  if (!text.trim()) throw new Error("MOBI 解析失败：未提取到任何文本。");
  await fsp.writeFile(outputPath, `${text.trim()}\n`, "utf8");
}

async function convertMobiToEpub(inputPath, outputPath, originalName) {
  const buffer = await fsp.readFile(inputPath);
  const html = parseMobiText(buffer);
  const text = htmlToText(html);
  if (!text.trim()) throw new Error("MOBI 解析失败：未提取到任何文本。");
  await convertTextToEpub(text, "txt", originalName || "book", outputPath);
}

// 电子书输入分发（EPUB/MOBI 是二进制容器，不能按 utf8 文本读取）
async function convertEbook(inputPath, outputPath, inputExt, target, originalName) {
  if (inputExt === "epub") {
    if (target === "txt") {
      await convertEpubToText(inputPath, outputPath);
      return;
    }
    if (target === "md") {
      await convertEpubToMarkdown(inputPath, outputPath);
      return;
    }
    throw new Error("EPUB 暂只支持转换为 TXT 或 Markdown。");
  }
  if (inputExt === "mobi") {
    if (target === "epub") {
      await convertMobiToEpub(inputPath, outputPath, originalName);
      return;
    }
    if (target === "txt") {
      await convertMobiToText(inputPath, outputPath);
      return;
    }
    if (target === "md") {
      const html = parseMobiText(await fsp.readFile(inputPath));
      await fsp.writeFile(outputPath, `${htmlToMarkdown(html).trim()}\n`, "utf8");
      return;
    }
    throw new Error("MOBI 暂只支持转换为 EPUB、TXT 或 Markdown。");
  }
  throw new Error("不支持的电子书格式。");
}

module.exports = {
  convertTextToEpub,
  convertEpubToText,
  convertEpubToMarkdown,
  convertMobiToText,
  convertMobiToEpub,
  convertEbook,
  parseMobiText,
  splitChapters
};
