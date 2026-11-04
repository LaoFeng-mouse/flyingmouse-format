// 电子书格式：EPUB 生成/解析 + MOBI 基础解析（实验性）。
// EPUB 读取中央目录；MOBI 只接受已实现的 PalmDOC 压缩与编码。
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const yauzl = require("yauzl");
const yazl = require("yazl");
const parse5 = require("parse5");
const { Readable } = require("stream");
const { throwIfCanceled } = require("./conversion-cancellation");
const { captureConversionProgressReporter } = require("./conversion-progress");

const { htmlToMarkdown, markdownToHtml } = require("./text-conversion");
const { xmlToJson } = require("./xml-json");

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
  // HTML cannot be sliced through tags. Keep its markup intact; lazy ZIP
  // compression below still prevents one compressor per paragraph.
  if (source === "html" || source === "htm") return [{ title: "正文", body: text }];
  // Keep every character (including blank lines). Prefer a paragraph boundary
  // in the latter half of each bounded chunk; giant paragraphs are split at a
  // Unicode-safe boundary instead of creating one unbounded XHTML document.
  const parts = [];
  const maxCharacters = 32768;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxCharacters);
    if (end < text.length) {
      const boundary = text.slice(start, end).lastIndexOf("\n\n");
      if (boundary >= maxCharacters / 2) end = start + boundary + 2;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    parts.push({ title: `第 ${parts.length + 1} 节`, body: text.slice(start, end) });
    start = end;
  }
  return parts.length ? parts : [{ title: "正文", body: text }];
}

function markdownToXhtml(source, body) {
  return /<body>([\s\S]*)<\/body>/.exec(markdownToHtml(body))[1]
    .replace(/<(br|hr|img)\b([^>]*?)(?<!\/)\s*>/gi, "<$1$2 />");
}

async function convertTextToEpub(raw, source, originalName, outputPath, options = {}) {
  throwIfCanceled(options.signal);
  const report = captureConversionProgressReporter();
  const title = cleanTitle(path.basename(originalName || "book", path.extname(originalName || "")));
  const chapters = splitChapters(raw, source);
  const documents = [];
  documents.push({ name: "META-INF/container.xml", content: () => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>` });

  const manifest = [`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`];
  const spine = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const id = `chapter-${index + 1}`;
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
  }
  function chapterDocument(index) {
    const xhtml = source === "md" || source === "markdown" ? markdownToXhtml(source, chapters[index].body)
      : source === "html" || source === "htm" ? chapters[index].body
        : `<p>${escapeHtmlText(chapters[index].body).replace(/\n/g, "<br />")}</p>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXmlText(chapters[index].title)}</title></head>
<body>
<h1>${escapeXmlText(chapters[index].title)}</h1>
${xhtml}
</body>
</html>`;
  }

  const navPoints = chapters.map((chapter, index) =>
    `    <navPoint id="nav-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXmlText(chapter.title)}</text></navLabel><content src="chapter-${index + 1}.xhtml"/></navPoint>`
  ).join("\n");

  documents.push({ name: "OEBPS/content.opf", content: () => `<?xml version="1.0" encoding="UTF-8"?>
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
</package>` });
  documents.push({ name: "OEBPS/toc.ncx", content: () => `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="bookid"/></head>
  <docTitle><text>${escapeXmlText(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>` });
  for (let index = 0; index < chapters.length; index += 1) {
    documents.push({ name: `OEBPS/chapter-${index + 1}.xhtml`, chapter: index + 1, content: () => chapterDocument(index) });
  }
  report({ stage: "converting", completed: 0, total: chapters.length, unit: "chapters" });
  await writeEpubArchive(outputPath, documents, options.signal, completed => {
    report({ stage: "converting", completed, total: chapters.length, unit: "chapters" });
  });
  report({ stage: "validating" });
}

// yazl.addBuffer starts deflate immediately for every entry. Lazy streams pump
// exactly one entry at a time and construct only the current XHTML buffer.
async function writeEpubArchive(outputPath, documents, signal, onChapter) {
  const zip = new yazl.ZipFile();
  let created = false, identity = null, pendingChapter = 0, writeError = null, outputFinished = false, archiveEnded = false;
  const output = fs.createWriteStream(outputPath, { flags: "wx" });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        output.destroy();
        zip.outputStream.destroy();
        reject(error);
      };
      const completeChapter = () => {
        if (pendingChapter) { const completed = pendingChapter; pendingChapter = 0; onChapter(completed); }
      };
      // A destination failure must not leave yazl's private compressor blocked
      // on backpressure. Drain its current entry; the next lazy callback runs
      // only after that compressor ends and will reject without starting more.
      const destinationFailed = error => {
        writeError ||= error;
        if (!created || archiveEnded) { fail(writeError); return; }
        zip.outputStream.unpipe(output);
        zip.outputStream.resume();
      };
      zip.on("error", fail);
      zip.outputStream.on("error", fail);
      output.on("error", destinationFailed);
      output.on("finish", () => { outputFinished = true; });
      output.on("close", () => {
        if (settled) return;
        if (!outputFinished) {
          destinationFailed(writeError || Object.assign(new Error("EPUB output closed before completion"), { code: "EPUB_WRITE_FAILED" }));
          return;
        }
        try { throwIfCanceled(signal); } catch (error) { fail(error); return; }
        settled = true;
        resolve();
      });
      zip.outputStream.on("end", () => {
        archiveEnded = true;
        if (settled) return;
        try {
          if (writeError) throw writeError;
          completeChapter();
          throwIfCanceled(signal);
        } catch (error) { fail(error); }
      });
      output.once("open", () => {
        created = true;
        if (settled) { output.destroy(); return; }
        try {
          identity = fs.fstatSync(output.fd);
          throwIfCanceled(signal);
          zip.outputStream.pipe(output);
          // EPUB requires this first entry to have known sizes and no deflate.
          zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compressionLevel: 0 });
          for (const document of documents) {
            zip.addReadStreamLazy(document.name, callback => {
              // Yield between entries so cancellation, status polling and the
              // desktop remain responsive while a large book is being written.
              setImmediate(() => {
                try {
                  if (settled) { callback(writeError || new Error("EPUB archive already closed")); return; }
                  if (output.destroyed && !outputFinished) {
                    destinationFailed(output.errored || writeError || Object.assign(new Error("EPUB output closed before completion"), { code: "EPUB_WRITE_FAILED" }));
                  }
                  if (writeError) throw writeError;
                  completeChapter();
                  throwIfCanceled(signal);
                  const input = Readable.from([Buffer.from(document.content())]);
                  input.on("error", error => zip.emit("error", error));
                  pendingChapter = document.chapter || 0;
                  callback(null, input);
                } catch (error) { callback(error); }
              });
            });
          }
          zip.end();
        } catch (error) { fail(error); }
      });
    });
  } catch (error) {
    if (!output.closed) await new Promise(resolve => output.once("close", resolve));
    // Only remove the file we exclusively created, never a replacement at the
    // same path or a pre-existing destination rejected by the wx open.
    if (created && identity) {
      try {
        const current = await fsp.lstat(outputPath);
        if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) await fsp.unlink(outputPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  }
}

// ---- EPUB 解析 ----

async function readZipEntries(zipPath) {
  const buffer = await fsp.readFile(zipPath);
  return new Promise((resolve, reject) => {
    const entries = new Map();
    let total = 0;
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      const fail = (error) => { zipfile.close(); reject(error); };
      zipfile.on("entry", (entry) => {
        total += entry.uncompressedSize;
        if (total > 256 * 1024 * 1024) return fail(ebookError("EPUB_RESOURCE_LIMIT", "EPUB 解压内容超过 256 MB，请拆分电子书后重试。"));
        if (entries.has(entry.fileName)) return fail(ebookError("EPUB_INVALID_ARCHIVE", `EPUB 包含重复文件：${entry.fileName}`));
        if (!/\/$/.test(entry.fileName)) {
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              fail(streamError);
              return;
            }
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => {
              entries.set(entry.fileName, Buffer.concat(chunks));
              zipfile.readEntry();
            });
            stream.on("error", fail);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolve(entries);
      });
      zipfile.on("error", fail);
      zipfile.readEntry();
    });
  });
}

function ebookError(code, message) {
  return Object.assign(new Error(message), { code });
}

function xmlChildren(object, localName) {
  if (!object || typeof object !== "object") return [];
  return Object.entries(object).filter(([name]) => name.split(":").pop() === localName)
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function packagePath(basePath, href) {
  let decoded;
  try { decoded = decodeURIComponent(String(href).split("#")[0]); } catch { throw ebookError("EPUB_INVALID_PATH", `EPUB 路径编码无效：${href}`); }
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(decoded) || decoded.includes("\\")) throw ebookError("EPUB_INVALID_PATH", `EPUB 不支持外部资源：${href}`);
  const result = path.posix.normalize(path.posix.join(path.posix.dirname(basePath), decoded));
  if (result === ".." || result.startsWith("../")) throw ebookError("EPUB_INVALID_PATH", `EPUB 资源路径越界：${href}`);
  return result;
}

async function epubSpineXhtml(entries) {
  if (entries.has("META-INF/encryption.xml")) {
    const encryption = entries.get("META-INF/encryption.xml").toString("utf8");
    if (/<(?:\w+:)?EncryptedData\b/i.test(encryption)) throw ebookError("EPUB_ENCRYPTED_UNSUPPORTED", "EPUB 含加密或混淆资源，当前版本不支持转换此文件。");
  }
  const container = entries.get("META-INF/container.xml");
  if (!container) throw new Error("EPUB 解析失败：缺少 META-INF/container.xml。");
  const root = xmlChildren(xmlToJson(container.toString("utf8")), "container")[0];
  const rootfile = xmlChildren(xmlChildren(root, "rootfiles")[0], "rootfile")[0];
  if (!rootfile) throw new Error("EPUB 解析失败：container.xml 缺少 rootfile。");
  const opfPath = packagePath("root", rootfile["@full-path"]);
  const opf = entries.get(opfPath);
  if (!opf) throw new Error(`EPUB 解析失败：找不到 ${opfPath}。`);
  const document = xmlChildren(xmlToJson(opf.toString("utf8")), "package")[0];
  const spineIds = xmlChildren(xmlChildren(document, "spine")[0], "itemref").map((item) => item["@idref"]);
  const idHref = new Map();
  for (const item of xmlChildren(xmlChildren(document, "manifest")[0], "item")) {
    if (item["@id"] && item["@href"]) idHref.set(item["@id"], item["@href"]);
  }
  const xhtml = [];
  for (const id of spineIds) {
    const href = idHref.get(id);
    if (!href) throw ebookError("EPUB_CHAPTER_MISSING", `EPUB 目录引用了不存在的章节：${id}`);
    const normalized = packagePath(opfPath, href);
    const entry = entries.get(normalized);
    if (!entry) throw ebookError("EPUB_CHAPTER_MISSING", `EPUB 章节文件缺失：${normalized}`);
    xhtml.push({ html: entry.toString("utf8"), path: normalized });
  }
  if (!xhtml.length) throw new Error("EPUB 解析失败：spine 中没有可读内容。");
  return xhtml;
}

async function convertEpubToText(inputPath, outputPath) {
  const entries = await readZipEntries(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const text = xhtmls.map(({ html }) => htmlToText(html)).filter(Boolean).join("\n\n");
  if (!text.trim()) throw new Error("EPUB 解析失败：未提取到任何文本。");
  await fsp.writeFile(outputPath, `${text.trim()}\n`, "utf8");
}

async function convertEpubToMarkdown(inputPath, outputPath) {
  const entries = await readZipEntries(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const markdown = xhtmls.map((chapter) => htmlToMarkdown(prepareChapterHtml(chapter, entries))).filter(Boolean).join("\n\n");
  if (!markdown.trim()) throw new Error("EPUB 解析失败：未提取到任何内容。");
  await fsp.writeFile(outputPath, `${markdown.trim()}\n`, "utf8");
}

// 合并 spine xhtml → 单页 html；栅格图片嵌入成 data URI，复杂 SVG 明确拒绝。
function prepareChapterHtml(chapter, entries) {
  let html = chapter.html;
  if (/<svg\b/i.test(html)) throw ebookError("EPUB_SVG_UNSUPPORTED", "EPUB 章节包含 SVG 排版，当前版本无法可靠保留；请使用原电子书阅读器导出。");
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const match = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (!match) throw ebookError("EPUB_IMAGE_MISSING", "EPUB 图片缺少 src 地址。");
    const resourcePath = packagePath(chapter.path, match[2]);
    const image = entries.get(resourcePath);
    if (!image) throw ebookError("EPUB_IMAGE_MISSING", `EPUB 图片文件缺失：${resourcePath}`);
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }[path.posix.extname(resourcePath).toLowerCase()];
    if (!mime) throw ebookError("EPUB_IMAGE_UNSUPPORTED", `EPUB 图片格式暂不支持：${resourcePath}`);
    return tag.replace(match[0], `src="data:${mime};base64,${image.toString("base64")}"`);
  });
  return html;
}

// Parse before filtering: deleting tag-shaped strings can turn malformed source
// such as <scr<script>ipt> into a newly executable script in the saved HTML.
// Keep document structure and mathematical text, with inert attributes only.
const EPUB_HTML_TAGS = new Set(("a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup "
  + "dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav "
  + "ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr "
  + "math mi mn mo mrow mfrac msup msub msubsup munder mover munderover msqrt mroot mtable mtr mtd mtext mspace semantics").split(" "));
const EPUB_DROP_CONTENT = new Set("script style iframe object embed base link meta template noscript form input button select textarea audio video source track canvas applet frame frameset".split(" "));
const EPUB_INERT_ATTRIBUTES = new Set(("id class title lang dir alt width height colspan rowspan scope headers start reversed type value open "
  + "align valign border cellpadding cellspacing datetime cite display mathvariant stretchy fence form").split(" "));

function sanitizeEpubHtml(html) {
  const fragment = parse5.parseFragment(html);
  function clean(parent, depth) {
    if (depth > 128) throw ebookError("EPUB_HTML_TOO_DEEP", "EPUB 章节嵌套过深，无法安全导出 HTML。");
    const kept = [];
    for (const node of parent.childNodes || []) {
      if (node.nodeName === "#text") { kept.push(node); continue; }
      if (!node.tagName || EPUB_DROP_CONTENT.has(node.tagName)) continue;
      clean(node, depth + 1);
      if (!EPUB_HTML_TAGS.has(node.tagName)) {
        kept.push(...(node.childNodes || []));
        continue;
      }
      node.attrs = (node.attrs || []).filter(attr => {
        if (attr.namespace || attr.prefix) return false;
        if (attr.name === "href") {
          if (node.tagName !== "a") return false;
          // HTML parsing has decoded character references. URL parsing also
          // ignores ASCII tabs/newlines, so normalize those before checking.
          attr.value = attr.value.trim().replace(/[\t\r\n]/g, "");
          return /^(?:https?:|mailto:|#)/i.test(attr.value);
        }
        if (attr.name === "src") {
          if (node.tagName !== "img") return false;
          if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z0-9+/]*={0,2}$/i.test(attr.value)) {
            throw ebookError("EPUB_IMAGE_UNSUPPORTED", "EPUB 图片未能转换为安全的内嵌资源。");
          }
          return true;
        }
        return EPUB_INERT_ATTRIBUTES.has(attr.name);
      });
      kept.push(node);
    }
    parent.childNodes = kept;
    for (const child of kept) child.parentNode = parent;
  }
  clean(fragment, 0);
  return parse5.serialize(fragment);
}

function mergeEpubHtml(xhtmls, entries) {
  const bodies = xhtmls.map((chapter) => {
    const html = prepareChapterHtml(chapter, entries);
    const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return match ? match[1] : html;
  }).join("\n");
  const cleaned = sanitizeEpubHtml(bodies);
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>book</title></head>\n<body>\n${cleaned}\n</body></html>`;
}

async function convertEpubToHtml(inputPath, outputPath) {
  const entries = await readZipEntries(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const html = mergeEpubHtml(xhtmls, entries);
  if (!/<body[\s\S]*<\/body>/i.test(html)) throw new Error("EPUB 解析失败：未提取到任何内容。");
  await fsp.writeFile(outputPath, html, "utf8");
  return { warnings: epubStyleWarnings(xhtmls) };
}

function epubStyleWarnings(chapters) {
  if (!chapters.some(({ html }) => /<style\b|<link\b|\sstyle\s*=/i.test(html))) return [];
  return [{ code: "EPUB_STYLES_SIMPLIFIED", messages: {
    zhCN: "EPUB 的文字顺序和栅格图片已保留；原 CSS 样式及固定版面已简化。",
    enUS: "EPUB reading order and raster images were preserved; original CSS and fixed layout were simplified."
  } }];
}

// epub → pdf/docx：合并 html 后交给 LibreOffice（html→pdf/docx 管线实测可靠）。
// 惰性 require office-convert 避免模块循环。
async function convertEpubViaLibreOffice(inputPath, outputPath, target) {
  const { convertWithLibreOffice } = require("./office-convert");
  const entries = await readZipEntries(inputPath);
  const xhtmls = await epubSpineXhtml(entries);
  const html = mergeEpubHtml(xhtmls, entries);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-epub-"));
  const htmlPath = path.join(tempDir, "book.html");
  try {
    await fsp.writeFile(htmlPath, html, "utf8");
    await convertWithLibreOffice(htmlPath, outputPath, "book.html", target);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  return { warnings: epubStyleWarnings(xhtmls) };
}

// ---- MOBI 解析（PalmDOC 1/2；KF8/HUFF-CDIC/加密/附加记录明确拒绝） ----

function decompressPalmDoc(chunk) {
  const output = [];
  for (let index = 0; index < chunk.length; index++) {
    const byte = chunk[index];
    if (byte >= 1 && byte <= 8) {
      if (index + byte >= chunk.length) throw ebookError("MOBI_INVALID_RECORD", "MOBI PalmDOC 字面量记录不完整。");
      for (let length = 0; length < byte; length++) output.push(chunk[++index]);
    } else if (byte >= 0x80 && byte <= 0xbf) {
      if (++index >= chunk.length) throw ebookError("MOBI_INVALID_RECORD", "MOBI PalmDOC 回溯记录不完整。");
      const pair = ((byte & 0x3f) << 8) | chunk[index];
      const distance = pair >> 3;
      const length = (pair & 7) + 3;
      if (!distance || distance > output.length) throw ebookError("MOBI_INVALID_RECORD", "MOBI PalmDOC 回溯距离无效。");
      for (let copy = 0; copy < length; copy++) output.push(output[output.length - distance]);
    } else if (byte >= 0xc0) output.push(0x20, byte ^ 0x80);
    else output.push(byte);
    if (output.length > 65536) throw ebookError("MOBI_INVALID_RECORD", "MOBI 文本记录超过允许长度。");
  }
  return Buffer.from(output);
}

function parseMobiText(buffer) {
  // MOBI 文件是 PDB 容器：PalmDB header(78 字节) + 记录表(每条 8 字节) + 记录数据。
  // 记录 0 = MOBI header（其前 16 字节是 PalmDOC header：compression/textLength/recordCount），
  // 文本记录从记录 1 开始。
  if (buffer.length < 78) throw new Error("MOBI 解析失败：文件头不完整。");
  const numRecords = buffer.readUInt16BE(76);
  const recordListOffset = 78;
  if (recordListOffset + numRecords * 8 > buffer.length || numRecords < 2 || numRecords > 20000) {
    throw new Error("MOBI 解析失败：记录数不合法。");
  }
  const offsets = [];
  for (let index = 0; index < numRecords; index += 1) {
    offsets.push(buffer.readUInt32BE(recordListOffset + index * 8));
  }
  offsets.push(buffer.length);
  if (offsets[0] < recordListOffset + numRecords * 8 || offsets.some((offset, index) => index && offset <= offsets[index - 1])) {
    throw ebookError("MOBI_INVALID_RECORD", "MOBI 记录偏移越界或顺序无效。");
  }
  const record0 = offsets[0];
  if (record0 + 16 > offsets[1]) throw new Error("MOBI 解析失败：PalmDOC 头缺失。");
  const compression = buffer.readUInt16BE(record0);
  if (compression !== 1 && compression !== 2) throw ebookError("MOBI_COMPRESSION_UNSUPPORTED", `MOBI 压缩方式 ${compression} 暂不支持；当前支持未压缩和 PalmDOC，不支持 HUFF/CDIC。`);
  if (buffer.readUInt16BE(record0 + 12) !== 0) throw ebookError("MOBI_ENCRYPTED_UNSUPPORTED", "加密 MOBI 不支持转换。");
  const textLength = buffer.readUInt32BE(record0 + 4);
  const recordCount = buffer.readUInt16BE(record0 + 8);
  if (recordCount <= 0 || recordCount >= numRecords) throw new Error("MOBI 解析失败：文本记录数不合法。");
  let encoding = "windows-1252";
  if (buffer.toString("ascii", record0 + 16, record0 + 20) === "MOBI") {
    const headerLength = buffer.readUInt32BE(record0 + 20);
    if (headerLength < 24 || record0 + 16 + headerLength > offsets[1]) throw ebookError("MOBI_INVALID_RECORD", "MOBI 头长度无效。");
    const codepage = buffer.readUInt32BE(record0 + 28);
    if (codepage !== 1252 && codepage !== 65001) throw ebookError("MOBI_ENCODING_UNSUPPORTED", `MOBI 字符编码 ${codepage} 暂不支持。`);
    encoding = codepage === 65001 ? "utf-8" : "windows-1252";
    const version = buffer.readUInt32BE(record0 + 36);
    if (version >= 8) throw ebookError("MOBI_KF8_UNSUPPORTED", "KF8/AZW3 排版暂不支持，请先导出 EPUB。");
    if (headerLength >= 228 && buffer.readUInt16BE(record0 + 242) !== 0) throw ebookError("MOBI_EXTRA_DATA_UNSUPPORTED", "此 MOBI 含附加文本记录，当前版本尚不能可靠还原，请先导出 EPUB。");
  }

  const recordData = [];
  for (let index = 1; index <= recordCount && index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1] || buffer.length;
    const chunk = buffer.subarray(start, end);
    recordData.push(compression === 2 ? decompressPalmDoc(chunk) : chunk);
  }
  const textBytes = Buffer.concat(recordData);
  if (!textLength || textBytes.length < textLength) throw ebookError("MOBI_TEXT_INCOMPLETE", "MOBI 文本长度不符，拒绝输出残缺内容。");
  let html;
  try { html = new TextDecoder(encoding, { fatal: true }).decode(textBytes.subarray(0, textLength)); }
  catch { throw ebookError("MOBI_ENCODING_INVALID", "MOBI 字符编码无效，拒绝输出乱码。"); }
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
async function routeEbook(inputPath, outputPath, inputExt, target, originalName) {
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
      return await convertEpubToHtml(inputPath, outputPath);
    }
    if (target === "pdf" || target === "docx") {
      return await convertEpubViaLibreOffice(inputPath, outputPath, target);
    }
    throw new Error("EPUB 暂只支持转换为 TXT、Markdown、HTML、PDF 或 DOCX。");
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

async function convertEbook(inputPath, outputPath, inputExt, target, originalName) {
  try {
    return await routeEbook(inputPath, outputPath, inputExt, target, originalName);
  } catch (error) {
    if (!/^(?:EPUB|MOBI)_/.test(error.code || "")) error.code = inputExt === "mobi" ? "MOBI_PARSE_FAILED" : "EPUB_PARSE_FAILED";
    throw error;
  }
}

module.exports = {
  convertTextToEpub,
  convertEpubToText,
  convertEpubToMarkdown,
  convertEpubToHtml,
  convertEpubViaLibreOffice,
  convertMobiToText,
  convertMobiToEpub,
  convertEbook,
  parseMobiText,
  splitChapters
};
