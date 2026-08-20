// office-convert.js — 飞鼠格式 LibreOffice 转换域：Office 文档（doc/docx/odt/rtf/wps 等）互转与转文本/Markdown。
// 第四批抽取自 server.js（零逻辑改动，纯搬移）。

const fsp = require("fs/promises");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { randomUUID } = require("crypto");
const mammoth = require("mammoth");
const { RUNTIME_DIR, LIBREOFFICE_PATH } = require("./config");
const { normalizeExt, extFromName, outputNameFor } = require("./utils");
const { createTurndownService } = require("./text-conversion");
const { OfficeEngineError, runLibreOffice } = require("./office-engine");
// 注意：htmlToText 从 text-docx.js 延迟 require（convertDocumentToText 内），
// 避免与 text-docx.js 顶层 require 本模块形成循环依赖。
const sanitize = require("sanitize-filename");
const yazl = require("yazl");

// WPS 生成的 docx 常带 wpsCustomData 命名空间；LibreOffice 的 PDF 导出对
// WPS 公式（OMML oMath）+ 交叉引用域（fldChar）组合会静默截断（exit 0 但
// 只输出前几页，txt/html 导出不受影响）。转 PDF 前探测这类结构，命中则
// 先经 LibreOffice roundtrip（docx→docx）规范化修复再导出。
//
// 注意：zip 解析用手动实现（conversion.test.js 的 readZipEntry 同模式），
// 不用 yauzl 的 openReadStream——微信传输的 docx 会让 yauzl 流卡在 end
// 事件不触发（2026-08-12 实测，普通 zip 正常）。
const WPS_NAMESPACE_RE = /wpsCustomData|xmlns:wps=|wps:w14/;
const O_MATH_RE = /<m:oMath[ >]/g;
const FIELD_CHAR_RE = /<w:fldChar[ >]/g;

function findEocd(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function inflateZipEntry(buf, entry) {
  const localOffset = entry.localOffset;
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compData = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compData;
  if (entry.method === 8) return zlib.inflateRawSync(compData);
  return null;
}

function readDocxEntryString(docxPath, entryName) {
  return new Promise((resolve, reject) => {
    fs.readFile(docxPath, (readError, buf) => {
      if (readError) {
        reject(readError);
        return;
      }
      try {
        const eocd = findEocd(buf);
        if (eocd === -1) {
          resolve(null);
          return;
        }
        const cdCount = buf.readUInt16LE(eocd + 10);
        const cdOffset = buf.readUInt32LE(eocd + 16);
        let off = cdOffset;
        let target = null;
        for (let i = 0; i < cdCount; i++) {
          if (buf.readUInt32LE(off) !== 0x02014b50) break;
          const method = buf.readUInt16LE(off + 10);
          const compSize = buf.readUInt32LE(off + 20);
          const nameLen = buf.readUInt16LE(off + 28);
          const extraLen = buf.readUInt16LE(off + 30);
          const commentLen = buf.readUInt16LE(off + 32);
          const localOffset = buf.readUInt32LE(off + 42);
          const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
          if (name === entryName) {
            target = { method, compSize, localOffset };
            break;
          }
          off += 46 + nameLen + extraLen + commentLen;
        }
        if (!target) {
          resolve(null);
          return;
        }
        const data = inflateZipEntry(buf, target);
        resolve(data ? data.toString("utf8") : null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function docxNeedsPdfRepair(docxPath) {
  try {
    const xml = await readDocxEntryString(docxPath, "word/document.xml");
    if (!xml) return false;
    const hasWps = WPS_NAMESPACE_RE.test(xml);
    const oMathCount = (xml.match(O_MATH_RE) || []).length;
    const fieldCount = (xml.match(FIELD_CHAR_RE) || []).length;
    return hasWps || (oMathCount >= 5 && fieldCount >= 5);
  } catch {
    return false;
  }
}

async function repairDocxViaRoundtrip(inputPath, originalName, tempDir) {
  const repairDir = path.join(tempDir, "repair");
  await fsp.mkdir(repairDir, { recursive: true });
  const args = [
    "--convert-to",
    "docx:MS Word 2007 XML",
    "--outdir",
    repairDir,
    inputPath
  ];
  await runLibreOffice(LIBREOFFICE_PATH, args, { runtimeDir: RUNTIME_DIR, timeout: 1000 * 60 * 10 });
  return findConvertedFile(repairDir, "docx");
}

// 微信传输 / 某些生成工具打包 docx/xlsx/pptx 时，media 图片用 store + data descriptor
// 存储，却把 CRC 字段写成 0（偷懒未计算）。LibreOffice 严格校验 zip CRC，遇到这种
// entry 会整体拒绝加载（报 "Error: source file could not be loaded"），而 MS Word 容错
// 所以能打开。这里扫描 central directory，找出 CRC=0 且数据非空的损坏 entry。
function findCrcBrokenZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null; // central directory 异常，放弃修复
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, localOffset, crc });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 若 zip 容器存在 CRC 损坏（CRC=0 但数据非空），读取所有 entry 并重新打包重算 CRC。
// 返回修复后的文件路径；无损坏或非 zip 容器时返回 null。
async function repairZipCrcIfNeeded(inputPath, tempDir, originalExt) {
  let buf;
  try {
    buf = await fsp.readFile(inputPath);
  } catch {
    return null;
  }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return null;

  const entries = findCrcBrokenZipEntries(buf);
  if (!entries) return null;
  const brokenCount = entries.filter((e) => e.crc === 0 && e.compSize > 0).length;
  if (brokenCount === 0) return null;

  const ext = originalExt || "docx";
  const repairedPath = path.join(tempDir, `crc-fixed-${randomUUID()}.${ext}`);
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = fs.createWriteStream(repairedPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    try {
      for (const entry of entries) {
        if (entry.name.endsWith("/")) continue; // 跳过目录项
        const data = inflateZipEntry(buf, entry);
        if (data == null) {
          reject(new Error(`无法读取 zip entry: ${entry.name}`));
          return;
        }
        archive.addBuffer(data, entry.name, { compress: entry.method !== 0 });
      }
    } catch (error) {
      reject(error);
      return;
    }
    archive.end();
  });
  return repairedPath;
}

function libreOfficeFilterFor(target) {
  const filters = {
    txt: "txt:Text",
    csv: "csv:Text - txt - csv (StarCalc)"
  };
  return filters[target] || target;
}

async function findConvertedFile(outDir, target) {
  const files = await fsp.readdir(outDir).catch(() => []);
  const normalizedTarget = target.toLowerCase();
  const matches = [];

  for (const fileName of files) {
    const filePath = path.join(outDir, fileName);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isFile() && normalizeExt(extFromName(fileName)) === normalizedTarget) {
      matches.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath || null;
}

async function convertWithLibreOffice(inputPath, outputPath, originalName, target) {
  const tempDir = path.join(RUNTIME_DIR, `lo-${randomUUID()}`);
  const outDir = path.join(tempDir, "out");
  await fsp.mkdir(outDir, { recursive: true });

  const originalExt = extFromName(originalName) || "bin";
  const safeName = sanitize(originalName || `input.${originalExt}`) || `input.${originalExt}`;
  const workingInput = path.join(tempDir, safeName.includes(".") ? safeName : `${safeName}.${originalExt}`);

  try {
    await fsp.copyFile(inputPath, workingInput);
    const targetExt = normalizeExt(target);
    let effectiveInput = workingInput;
    // 先修复 zip CRC 损坏：微信传输 / 某些工具生成的 docx 会把 media 图片 CRC 写成 0，
    // LibreOffice 严格校验会拒绝加载（"source file could not be loaded"）。重打包重算 CRC。
    const crcFixed = await repairZipCrcIfNeeded(workingInput, tempDir, normalizeExt(originalExt));
    if (crcFixed) effectiveInput = crcFixed;
    // WPS 生成的 docx（OMML 公式 + 交叉引用域）转 PDF 会被 LibreOffice 静默截断：
    // exit 0 但只输出前几页。命中特征时先 roundtrip 规范化修复再导出。
    if (targetExt === "pdf" && normalizeExt(originalExt) === "docx" && await docxNeedsPdfRepair(effectiveInput)) {
      const repaired = await repairDocxViaRoundtrip(effectiveInput, safeName, tempDir);
      if (repaired) effectiveInput = repaired;
    }
    const args = [
      "--convert-to",
      libreOfficeFilterFor(target),
      "--outdir",
      outDir,
      effectiveInput
    ];

    await runLibreOffice(LIBREOFFICE_PATH, args, { runtimeDir: RUNTIME_DIR, timeout: 1000 * 60 * 10 });
    const convertedPath = await findConvertedFile(outDir, target);
    if (!convertedPath) {
      throw new OfficeEngineError("OFFICE_CONVERSION_FAILED", {
        exitCode: null,
        signal: null,
        reason: "no-output-file"
      });
    }
    await fsp.copyFile(convertedPath, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertDocumentToMarkdown(inputPath, outputPath, inputExt, originalName) {
  const ext = normalizeExt(inputExt);
  let html;
  // 图片外置目录：md 同目录的 `<下载名>.assets/`，md 里用相对路径引用，
  // 避免 mammoth 把 docx 图片 base64 内嵌成超长单行导致 Typora 拒渲染
  // （实测 37 张图单行 263KB → doEnterOversize）。
  // 注意：目录名必须基于 downloadName（outputNameFor(originalName, "md")）
  // 而不是 outputPath（带时间戳-uuid 前缀），否则用户保存后相对引用断裂。
  const mdBasename = path.basename(outputNameFor(originalName, "md"), ".md") || "document";
  const assetsDir = path.join(path.dirname(outputPath), `${mdBasename}.assets`);

  if (ext === "docx") {
    // 注意：mammoth 1.12.0 的 convertImage 选项实测失效（回调从不被调用，
    // 输出仍是 data URI），因此不传图片钩子，统一在下方 externalizeMarkdownImages
    // 对最终 md 里的 data:image base64 做外置（不依赖 mammoth 内部行为，各来源通用）。
    // 自定义中文标题样式（一级标题/二级标题…）mammoth 默认不识别会退化成普通段落，
    // 导致 md 丢失大纲——按 styles.xml 动态生成 styleMap 映射回 h1-h6。
    const styleMap = await mammothHeadingStyleMap(inputPath);
    const result = await mammoth.convertToHtml(
      { path: inputPath },
      styleMap ? { styleMap } : undefined
    );
    html = result.value || "";
  } else {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-docmd-"));
    const htmlPath = path.join(tempDir, "converted.html");
    try {
      await convertWithLibreOffice(inputPath, htmlPath, originalName, "html");
      html = await fsp.readFile(htmlPath, "utf8");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const turndown = createTurndownService();
  let markdown = turndown.turndown(html).trim();
  // 图片外置：把 md 里所有 data:image base64 解码写入 <下载名>.assets/，
  // md 引用改为相对路径 ./<下载名>.assets/image-N.ext。任何来源（mammoth /
  // LibreOffice html 导出）产出的内嵌图都在这统一处理，保证不再出现超长单行。
  const externalized = await externalizeMarkdownImages(markdown, assetsDir, `${mdBasename}.assets`);
  markdown = externalized.markdown;
  // 兜底：若仍有超长 base64 单行（如带 charset 参数的非常规 data URI 未被上面
  // 正则捕获），整行替换为占位符，保证任何来源的 md 都不会再触发 Typora oversize。
  markdown = markdown.split("\n").map((line) => {
    if (line.length > 200 * 1024 && /data:image\/[a-z+]+;base64,/i.test(line)) {
      const altMatch = line.match(/!\[([^\]]*)\]/);
      return `![${altMatch ? altMatch[1] : "图片"}](已移除超大内嵌图片)`;
    }
    return line;
  }).join("\n");
  if (!markdown) {
    throw new Error("文档转 Markdown 失败，未提取到任何内容。");
  }
  await fsp.writeFile(outputPath, `${markdown}\n`, "utf8");
  return {
    assetsDir: externalized.count ? assetsDir : null,
    assetsCount: externalized.count
  };
}

// 从样式名推断标题级别（1-6），不是标题返回 0。
// 覆盖：Heading N / 标题 N / 一级标题…六级标题 / 标题一…标题六 /
// 半括号标题（五级）/ 圆括号标题（六级标题） 等自定义中文命名。
// 只有样式名含「标题」才参与映射，避免「参数列表一级子列表样式」这类
// 含级数但不是标题的样式被误判。
function headingLevelFromStyleName(name) {
  if (!name || !/标题|Heading/i.test(name)) return 0;
  const cn = "一二三四五六";
  let m = name.match(/Heading\s*([1-6])/i);
  if (m) return Number(m[1]);
  m = name.match(/标题\s*([1-6])/);
  if (m) return Number(m[1]);
  m = name.match(/^([一二三四五六])级?标题/);
  if (m) return cn.indexOf(m[1]) + 1;
  m = name.match(/标题([一二三四五六])/);
  if (m) return cn.indexOf(m[1]) + 1;
  m = name.match(/[（(]([一二三四五六])级/);
  if (m) return cn.indexOf(m[1]) + 1;
  return 0;
}

// 读 docx 的 word/styles.xml，把自定义标题样式（mammoth 默认不识别）生成
// styleMap：p[style-name='X'] => hN:fresh。mammoth 只认标准 Heading/标题 样式名，
// 「一级标题」「半括号标题（五级）」等中文自定义名会退化成普通段落 → md 丢大纲。
// ★ 注意必须用 style-name 形式：mammoth 1.12.0 实测 p[style-id='N'] 形式不生效
// （与 convertImage 同类的选项处理问题），style-name 形式实测有效。
async function mammothHeadingStyleMap(docxPath) {
  const stylesXml = await readDocxEntryString(docxPath, "word/styles.xml");
  if (!stylesXml) return undefined;
  const styleMap = [];
  const styleRe = /<w:style [^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = styleRe.exec(stylesXml)) !== null) {
    const name = (m[2].match(/<w:name w:val="([^"]+)"/) || [])[1] || "";
    const level = headingLevelFromStyleName(name);
    if (level && !name.includes("'")) {
      styleMap.push(`p[style-name='${name}'] => h${level}:fresh`);
    }
  }
  return styleMap.length ? styleMap : undefined;
}

// data:image URI → 文件扩展名（用于 md 图片外置）。
const MARKDOWN_IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/tif": "tif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/emf": "emf",
  "image/x-emf": "emf",
  "image/wmf": "wmf"
};

// 把 markdown 中所有 data:image/<type>;base64,<payload> 外置写入 assetsDir，
// 引用替换为相对路径 <assetsBaseName>/image-N.ext；返回新 md 与替换数量。
// 采用「先收集 → 并行写盘 → 从后往前替换」避免异步与索引错位。
// 与 mammoth convertImage 钩子无关：直接解析最终产物，docx/LibreOffice 各来源通用。
async function externalizeMarkdownImages(markdown, assetsDir, assetsBaseName) {
  const regex = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
  const found = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const mimeSub = match[1].toLowerCase();
    const ext = MARKDOWN_IMAGE_EXT[`image/${mimeSub}`] || mimeSub.replace(/[^a-z0-9]/g, "");
    const safeExt = ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : "png";
    found.push({ index: match.index, length: match[0].length, b64: match[2], safeExt });
  }
  if (!found.length) return { markdown, count: 0 };
  await fsp.mkdir(assetsDir, { recursive: true });
  await Promise.all(found.map((item, i) => {
    const name = `image-${i + 1}.${item.safeExt}`;
    return fsp.writeFile(path.join(assetsDir, name), Buffer.from(item.b64, "base64"));
  }));
  let out = markdown;
  for (let i = found.length - 1; i >= 0; i--) {
    const name = `image-${i + 1}.${found[i].safeExt}`;
    const replacement = `${assetsBaseName}/${name}`;
    out = out.slice(0, found[i].index) + replacement + out.slice(found[i].index + found[i].length);
  }
  return { markdown: out, count: found.length };
}

async function convertDocumentToText(inputPath, outputPath, inputExt, originalName) {
  const ext = normalizeExt(inputExt);
  let text;
  if (ext === "docx") {
    // LibreOffice 的 txt 导出过滤器在本便携版不可用（报错/卡死），docx 直接用 mammoth 提取纯文本
    const result = await mammoth.extractRawText({ path: inputPath });
    text = (result.value || "").trim();
  } else {
    // doc/odt/rtf/wps 等走 LibreOffice html 导出（探测可用）再转纯文本
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-doctxt-"));
    const htmlPath = path.join(tempDir, "converted.html");
    try {
      await convertWithLibreOffice(inputPath, htmlPath, originalName, "html");
      const { htmlToText } = require("./text-docx");
      text = htmlToText(await fsp.readFile(htmlPath, "utf8")).trim();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!text) {
    throw new Error("文档转文本失败，未提取到任何内容。");
  }
  await fsp.writeFile(outputPath, `${text}\n`, "utf8");
}

module.exports = {
  libreOfficeFilterFor,
  findConvertedFile,
  convertWithLibreOffice,
  convertDocumentToMarkdown,
  convertDocumentToText,
  externalizeMarkdownImages,
  mammothHeadingStyleMap,
  headingLevelFromStyleName,
  readDocxEntryString,
  docxNeedsPdfRepair,
  repairDocxViaRoundtrip,
  findCrcBrokenZipEntries,
  repairZipCrcIfNeeded
};
