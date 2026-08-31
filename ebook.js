// 电子书格式：EPUB 生成/解析 + MOBI 基础解析（实验性）。
// 零新依赖：EPUB 用 yazl/yauzl（项目已有），MOBI 文本记录走 zlib（Node 内置）。
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const yauzl = require("yauzl");
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

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      zipfile.on("entry", (entry) => {
        if (!/\/$/.test(entry.fileName)) {
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              reject(streamError);
              return;
            }
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => entries.set(entry.fileName, Buffer.concat(chunks)));
            stream.on("error", reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolve(entries);
      });
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

// 优先从 central directory 读（EOCD 定位）：流式打包器（7-Zip、部分在线工具）写
// data descriptor（局部头 bit3=1，compSize/crc 为 0 或占位），按局部头顺序扫会读到
// 0 字节数据而断链——这是「EPUB 转换几乎全失败」的根因（2026-08-31 实测复现）。
// central directory 回退到旧的局部头顺序扫描，保证两代逻辑都有出路。
function readZipEntriesSync(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = new Map();
  const zlibLocal = zlib;

  // ---- 路径 A：EOCD -> central directory ----
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd >= 0) {
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16); // central dir offset（ZIP64 不在此范围）
    let ok = true;
    for (let index = 0; index < entryCount && ok; index += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) { ok = false; break; }
      const method = buffer.readUInt16LE(offset + 10);
      const flags = buffer.readUInt16LE(offset + 8);
      const compSize = buffer.readUInt32LE(offset + 20);
      const nameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const lfhOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
      offset += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/") || !name || flags & 0x0001) continue; // 目录条目/加密条目跳过
      if (lfhOffset + 30 > buffer.length) { ok = false; break; }
      // 局部头的 name/extra 长度可能与 central 不一致（极少见），以局部头为准定位数据
      const lNameLen = buffer.readUInt16LE(lfhOffset + 26);
      const lExtraLen = buffer.readUInt16LE(lfhOffset + 28);
      const dataStart = lfhOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > buffer.length) { ok = false; break; }
      const data = buffer.subarray(dataStart, dataStart + compSize);
      try {
        entries.set(name, method === 0 ? Buffer.from(data) : Buffer.from(zlibLocal.inflateRawSync(data)));
      } catch {
        // 单条解压失败跳过（坏条目不拖垮整包）
      }
    }
    if (ok && entries.size) return entries;
  }

  // ---- 路径 B（回退）：局部头顺序扫描（兼容无 EOCD/ZIP64 特殊布局） ----
  const legacy = new Map();
  let p = 0;
  while (p + 46 <= buffer.length) {
    if (buffer.readUInt32LE(p) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(p + 8);
    const flags = buffer.readUInt16LE(p + 6);
    let compSize = buffer.readUInt32LE(p + 18);
    const nameLen = buffer.readUInt16LE(p + 26);
    const extraLen = buffer.readUInt16LE(p + 28);
    const name = buffer.toString("utf8", p + 30, p + 30 + nameLen);
    let dataStart = p + 30 + nameLen + extraLen;
    if (flags & 0x08 && compSize === 0) {
      // data descriptor：扫 0x08074b50 签名（或直接对 crc32+size 组合）取真实 compSize
      for (let j = dataStart; j + 4 <= buffer.length; j += 1) {
        if (buffer.readUInt32LE(j) === 0x08074b50) { compSize = j - dataStart; break; }
      }
    }
    const data = buffer.subarray(dataStart, dataStart + compSize);
    legacy.set(name, method === 0 ? Buffer.from(data) : Buffer.from(zlibLocal.inflateRawSync(data)));
    p = dataStart + compSize;
  }
  return legacy;
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

// 合并 spine xhtml → 干净单页 html（供直接输出或交给 LibreOffice 转 pdf/docx）。
// 清洗 EPUB 命名空间/样式/链接等 LO 不认的属性；第一版不提取内嵌图片。
function mergeEpubHtml(xhtmls) {
  const bodies = xhtmls.map((html) => {
    const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return match ? match[1] : html;
  }).join("\n");
  const cleaned = bodies
    .replace(/\sepub:[a-zA-Z-]+="[^"]*"/g, "")
    .replace(/\sxmlns:[a-zA-Z]+="[^"]*"/g, "")
    .replace(/<link\b[^>]*>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<img[^>]*>/g, ""); // 第一版不保留内嵌图（src 路径复杂），避免 LO 解析失败
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>book</title></head>\n<body>\n${cleaned}\n</body></html>`;
}

async function convertEpubToHtml(inputPath, outputPath) {
  const entries = readZipEntriesSync(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const html = mergeEpubHtml(xhtmls);
  if (!/<body[\s\S]*<\/body>/i.test(html)) throw new Error("EPUB 解析失败：未提取到任何内容。");
  await fsp.writeFile(outputPath, html, "utf8");
}

// epub → pdf/docx：合并 html 后交给 LibreOffice（html→pdf/docx 管线实测可靠）。
// 惰性 require office-convert 避免模块循环。
async function convertEpubViaLibreOffice(inputPath, outputPath, target) {
  const { convertWithLibreOffice } = require("./office-convert");
  const entries = readZipEntriesSync(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const html = mergeEpubHtml(xhtmls);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-epub-"));
  const htmlPath = path.join(tempDir, "book.html");
  try {
    await fsp.writeFile(htmlPath, html, "utf8");
    await convertWithLibreOffice(htmlPath, outputPath, "book.html", target);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
  // PDB 容器标识（偏移 60）：标准 MOBI/"azw3"（AZW 新格式复用 MOBI 容器）为 "BOOKMOBI"，
  // 纯 PalmDoc 为 "TEXtREAd"。不对的文件早失败，避免把任意二进制当 MOBI 解析出乱码。
  const pdbMagic = buffer.toString("latin1", 60, 68);
  if (pdbMagic !== "BOOKMOBI" && pdbMagic !== "TEXtREAd") {
    throw new Error("MOBI 解析失败：文件不是有效的 MOBI/AZW3（PDB 标识不符）。");
  }
  // 加密（PalmDOC 头偏移 12）：0=未加密，1/2=Kindle DRM/旧加密。加密文件应明确拒绝，
  // 而不是静默解出乱码。
  const encryption = buffer.readUInt16BE(record0 + 12);
  if (encryption !== 0) {
    throw new Error(`MOBI 解析失败：该文件受 DRM 加密（encryption=${encryption}），无法解密转换。`);
  }
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

// ---- FB2 解析（FictionBook 2.0：XML 文本，或 .fb2.zip 容器）----

// 把 FB2 XML 正文转成可交给 htmlToText/htmlToMarkdown 的类 HTML 结构。
function fb2BodyHtml(xml) {
  let s = String(xml || "");
  s = s.replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // 只取 <body> 正文，排除 <description> 元数据段（书名/作者等）。
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  const inner = bodyMatch ? bodyMatch[1] : s;
  return inner
    .replace(/<(title|h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, c) => `<h2>${c.replace(/<\/?(?:p|br)\b[^>]*>/gi, "").trim()}</h2>`)
    .replace(/<(p|subtitle|cite|epigraph)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, c) => `<p>${c}</p>`)
    .replace(/<v\b[^>]*>([\s\S]*?)<\/v>/gi, (_m, c) => `<p>${c}</p>`)
    .replace(/<\/?(?:section|body)\b[^>]*>/gi, "")
    .replace(/<image[^>]*\/?>/gi, "")
    .replace(/<br\s*\/?>/gi, "<br>");
}

async function extractFb2Html(inputPath) {
  const buffer = await fsp.readFile(inputPath);
  // .fb2.zip 容器：ZIP 内含单个 .fb2。
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    const entries = readZipEntriesSync(inputPath);
    let fb2Name = null;
    for (const name of entries.keys()) {
      if (/\.fb2$/i.test(name)) { fb2Name = name; break; }
    }
    if (!fb2Name) throw new Error("FB2 解析失败：ZIP 包内未找到 .fb2 文件。");
    return fb2BodyHtml(entries.get(fb2Name).toString("utf8"));
  }
  return fb2BodyHtml(buffer.toString("utf8"));
}

async function convertFb2ToText(inputPath, outputPath) {
  const html = await extractFb2Html(inputPath);
  const text = htmlToText(html);
  if (!text.trim()) throw new Error("FB2 解析失败：未提取到任何文本。");
  await fsp.writeFile(outputPath, `${text.trim()}\n`, "utf8");
}

async function convertFb2ToMarkdown(inputPath, outputPath) {
  const html = await extractFb2Html(inputPath);
  const md = htmlToMarkdown(html);
  if (!md.trim()) throw new Error("FB2 解析失败：未提取到任何文本。");
  await fsp.writeFile(outputPath, `${md.trim()}\n`, "utf8");
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
    if (target === "html") {
      await convertEpubToHtml(inputPath, outputPath);
      return;
    }
    if (target === "pdf" || target === "docx") {
      await convertEpubViaLibreOffice(inputPath, outputPath, target);
      return;
    }
    throw new Error("EPUB 暂只支持转换为 TXT、Markdown、HTML、PDF 或 DOCX。");
  }
  if (inputExt === "mobi" || inputExt === "azw3") {
    // AZW3（KF8）复用 MOBI 的 PalmDOC 容器结构，走同一解析器。
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
    throw new Error(`${inputExt.toUpperCase()} 暂只支持转换为 EPUB、TXT 或 Markdown。`);
  }
  if (inputExt === "fb2") {
    if (target === "txt") {
      await convertFb2ToText(inputPath, outputPath);
      return;
    }
    if (target === "md") {
      await convertFb2ToMarkdown(inputPath, outputPath);
      return;
    }
    if (target === "html") {
      await fsp.writeFile(outputPath, await extractFb2Html(inputPath), "utf8");
      return;
    }
    if (target === "epub") {
      const html = await extractFb2Html(inputPath);
      const text = htmlToText(html);
      if (!text.trim()) throw new Error("FB2 解析失败：未提取到任何文本。");
      await convertTextToEpub(text, "txt", originalName || "book", outputPath);
      return;
    }
    throw new Error("FB2 暂只支持转换为 TXT、Markdown、HTML 或 EPUB。");
  }
  throw new Error("不支持的电子书格式。");
}

module.exports = {
  convertTextToEpub,
  convertEpubToText,
  convertEpubToMarkdown,
  convertEpubToHtml,
  convertEpubViaLibreOffice,
  convertMobiToText,
  convertMobiToEpub,
  convertFb2ToText,
  convertFb2ToMarkdown,
  extractFb2Html,
  convertEbook,
  parseMobiText,
  splitChapters
};
