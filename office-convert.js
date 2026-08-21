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
  // WPS/Word 自动编号前缀（docx 分支填充，见 computeDocxHeadingNumbers）
  let headingPrefixes = [];
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
    // WPS/Word 自动编号：标题的「第 X 章 / 1.1 / 1.1.1」是 numbering 渲染的，
    // 不写在标题文本里，mammoth 输出 hN 时编号直接消失。按 numbering.xml 计算
    // 各标题段落的编号前缀，稍后注入 md 标题行（computeDocxHeadingNumbers）。
    headingPrefixes = await computeDocxHeadingNumbers(inputPath);
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
  // WPS/Word 自动编号注入（纯函数，见 injectHeadingPrefixes）
  markdown = injectHeadingPrefixes(markdown, headingPrefixes);
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

// 判断样式名是否会被「输出为 md 标题」。
// ★ 两处必须用同一判定：mammoth 输出 hN（styleMap 生成 + 内置 Heading/标题 识别）
// 与自动编号前缀计算（computeDocxHeadingNumbers）按文档顺序一一对应。含单引号的
// 样式名无法写进 p[style-name='X'] 选择器，mammoth 不会输出 hN，编号计算也必须
// 跳过，否则两个数组长度不一致 → 编号整体错位。
function isHeadingStyleName(name) {
  return !name.includes("'") && headingLevelFromStyleName(name) > 0;
}

// 解析 styles.xml：styleId → { name, numId, ilvl }（numId/ilvl 仅带 numPr 的样式有，
// 其余为 null/0）。mammothHeadingStyleMap 与 computeDocxHeadingNumbers 共用同一
// 解析，避免两份实现各自维护一份正则提取而判定漂移。
function parseDocxStyles(stylesXml) {
  const styles = {};
  if (!stylesXml) return styles;
  for (const m of stylesXml.matchAll(/<w:style [^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = (m[2].match(/<w:name w:val="([^"]+)"/) || [])[1] || "";
    const numPr = numPrFromXml(m[2]);
    styles[m[1]] = {
      name,
      numId: numPr ? numPr.numId : null,
      ilvl: numPr ? numPr.ilvl : 0
    };
  }
  return styles;
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
  for (const [styleId, style] of Object.entries(parseDocxStyles(stylesXml))) {
    if (isHeadingStyleName(style.name)) {
      styleMap.push(`p[style-name='${style.name}'] => h${headingLevelFromStyleName(style.name)}:fresh`);
    }
  }
  return styleMap.length ? styleMap : undefined;
}

// ============ WPS/Word 自动编号（多级标题编号 → md 标题前缀）============
// WPS/Word 里标题的「第 X 章 / 1.1 / 1.1.1 / 1） / （1）」不是文本，而是
// numbering.xml 定义的自动编号，由渲染器按 numPr（numId + ilvl）计算。
// mammoth 输出 hN 时只保留文本，编号消失 → 这里按文档顺序重算前缀，
// 与 mammoth 输出的标题行一一对应注入。

// 从 XML 片段提取 numPr 引用（ilvl/numId 顺序不定，WPS 常把 ilvl 放前面）
function numPrFromXml(xml) {
  const numPr = (xml.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/) || [])[1];
  if (!numPr) return null;
  const numId = (numPr.match(/<w:numId w:val="(\d+)"/) || [])[1];
  if (!numId) return null;
  const ilvl = (numPr.match(/<w:ilvl w:val="(\d+)"/) || [])[1];
  return { numId, ilvl: ilvl ? parseInt(ilvl, 10) : 0 };
}

// numFmt 值 → 编号文本（decimal/罗马/字母/中文计数；bullet 等返回数字占位，
// 由调用方按 lvlText 是否为纯符号判断是否无编号）。
const ROMAN_NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"];
function numberingValueText(fmt, n) {
  switch (fmt) {
    case "decimal":
    case "decimalZero":
      return String(n);
    case "lowerRoman":
    case "upperRoman": {
      const r = ROMAN_NUMERALS[((n - 1) % 15 + 15) % 15];
      return fmt === "upperRoman" ? r.toUpperCase() : r;
    }
    case "lowerLetter":
    case "upperLetter": {
      const c = String.fromCharCode(97 + (((n - 1) % 26) + 26) % 26);
      return fmt === "upperLetter" ? c.toUpperCase() : c;
    }
    case "chineseCounting":
    case "chineseCountingThousand": {
      const CN = "一二三四五六七八九十";
      // 0 = 引用了未激活的级别（如 %1.%3 但从未出现 3 级标题），
      // 必须输出「零」而不是误落入 n<20 分支变成「十」
      if (n === 0) return "零";
      if (n >= 1 && n <= 10) return CN[n - 1];
      if (n < 20) return `十${CN[(n % 10) - 1] || ""}`;
      if (n < 100) {
        const tens = Math.floor(n / 10);
        const ones = n % 10;
        return `${CN[tens - 1]}十${ones ? CN[ones - 1] : ""}`;
      }
      return String(n);
    }
    case "bullet":
    default:
      return String(n);
  }
}

// 解析 numbering.xml：numId→abstractNumId、abstractNumId→各级 lvl 定义、
// numId→lvlOverride 的 startOverride（WPS「重新开始编号」会生成）。
function parseDocxNumbering(numberingXml) {
  const numToAbstract = {};
  const abstractDefs = {};
  const numOverrides = {};
  for (const m of numberingXml.matchAll(/<w:num w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const numId = m[1];
    const am = m[2].match(/<w:abstractNumId w:val="(\d+)"/);
    if (am) numToAbstract[numId] = am[1];
    const overrides = {};
    for (const ov of m[2].matchAll(/<w:lvlOverride w:ilvl="(\d+)">([\s\S]*?)<\/w:lvlOverride>/g)) {
      const so = ov[2].match(/<w:startOverride w:val="(\d+)"/);
      if (so) overrides[parseInt(ov[1], 10)] = parseInt(so[1], 10);
    }
    if (Object.keys(overrides).length) numOverrides[numId] = overrides;
  }
  for (const m of numberingXml.matchAll(/<w:abstractNum w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const defs = {};
    for (const l of m[2].matchAll(/<w:lvl w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const ilvl = parseInt(l[1], 10);
      defs[ilvl] = {
        fmt: (l[2].match(/<w:numFmt w:val="([^"]+)"/) || [])[1] || "decimal",
        text: (l[2].match(/<w:lvlText w:val="([^"]*)"/) || [])[1] || "",
        start: parseInt((l[2].match(/<w:start w:val="(\d+)"/) || [])[1] || "1", 10)
      };
    }
    abstractDefs[m[1]] = defs;
  }
  return { numToAbstract, abstractDefs, numOverrides };
}

// 计算 docx 全部标题段落（含无编号的）的自动编号前缀，按文档顺序。
// 返回 [{ prefix: string }]；无编号的标题 prefix 为空串。
// 与 mammoth 输出顺序对齐（mammoth 也按文档顺序输出 hN）。
// ★ 计数器按 numId 分组（不同 numId 是独立编号实例；WPS「重新开始编号」
//   会生成带 startOverride 的新 numId）；低级别出现时高级别清零（Word 语义）。
async function computeDocxHeadingNumbers(docxPath) {
  const [numberingXml, stylesXml, documentXml] = await Promise.all([
    readDocxEntryString(docxPath, "word/numbering.xml"),
    readDocxEntryString(docxPath, "word/styles.xml"),
    readDocxEntryString(docxPath, "word/document.xml")
  ]);
  if (!documentXml) return [];
  const numbering = numberingXml ? parseDocxNumbering(numberingXml) : null;

  // 样式：styleId → { name, numId, ilvl }。记录所有样式（含无 numPr 的标准
  // heading 样式——mammoth 内置识别它们也会输出 hN，必须进数组保持对齐）。
  const styleInfo = parseDocxStyles(stylesXml);

  // 自闭合空段落（<w:p .../>）先剔除，避免正则吞内容
  const docWithoutSelfClosing = documentXml.replace(/<w:p\b[^>]*\/>/g, "");
  const counters = {}; // `${numId}:${ilvl}` -> 当前值
  const results = [];
  for (const m of docWithoutSelfClosing.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = m[1];
    const styleId = (body.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
    const style = styleInfo[styleId];
    // 与 mammoth 输出 hN 的判定必须一致（isHeadingStyleName）：
    // 非标题段落跳过；含 ' 的样式名 mammoth 不输出 hN，也必须跳过，否则编号错位
    if (!style || !isHeadingStyleName(style.name)) continue; // 非标题段落（正文列表编号由 mammoth 转 ol/ul）
    // 段落自身 numPr 优先于样式 numPr
    const ownNumPr = numPrFromXml(body);
    const numId = ownNumPr ? ownNumPr.numId : style?.numId;
    const ilvl = ownNumPr ? ownNumPr.ilvl : style?.ilvl;
    let prefix = "";
    if (numId && numbering) {
      const abstractId = numbering.numToAbstract[numId];
      const defs = abstractId ? numbering.abstractDefs[abstractId] : undefined;
      const def = defs && defs[ilvl];
      if (def && def.text && !/^[\uf0d8\uf06e\uf075\uf06c\u2022\u00b7*\-]+$/.test(def.text)) {
        const key = `${numId}:${ilvl}`;
        // start：lvlOverride 的 startOverride 优先（WPS 重新开始编号）
        const start = numbering.numOverrides?.[numId]?.[ilvl] ?? def.start;
        counters[key] = (counters[key] ?? (start - 1)) + 1;
        // Word 语义：更高级别（ilvl 更小）出现时，本级别以下的计数器清零；
        // 本级别出现时，其下所有级别也清零
        for (let l = ilvl + 1; l <= 9; l++) counters[`${numId}:${l}`] = 0;
        // lvlText 模板 %1..%9 → 各级计数（%1=ilvl0, %2=ilvl1, ...）
        prefix = def.text.replace(/%([0-9])/g, (_, d) => {
          const lvl = parseInt(d, 10) - 1;
          const value = counters[`${numId}:${lvl}`] ?? 0;
          // ★ 各级 %N 必须用各级自己的 numFmt（如「第%1章」是 chineseCounting、
          // %1.%2 的 %2 是 decimal）；统一用当前级 def.fmt 会在混排时输出错误格式。
          // 引用未定义级别时按 decimal 兜底。
          const lvlDef = defs && defs[lvl];
          return numberingValueText(lvlDef ? lvlDef.fmt : "decimal", value);
        });
      }
    }
    results.push({ prefix });
  }
  return results;
}

// 把 computeDocxHeadingNumbers 算出的标题编号前缀（第 X 章 / 1.1 / 1.1.1 /
// 1） / （1））按顺序拼到 md 标题行前。纯函数，便于单测。
// 顺序对齐依据：mammoth 按文档顺序输出标题，与计算数组一一对应；
// 数量不一致时取较短的（宁可少编号也不错位）。
// ★ fenced 代码块（Turndown codeBlockStyle:"fenced" 输出 ``` 围栏）内的 # 行
// 是代码不是标题：绝不能注入编号，也不能消耗对齐索引（否则围栏后所有标题
// 编号整体错位）。mammoth 1.12.0 目前不产出 <pre>，但任何来源的 ``` 行都必须安全。
function injectHeadingPrefixes(markdown, prefixes) {
  if (!prefixes || !prefixes.length) return markdown;
  let numberIndex = 0;
  let inFence = false;
  return markdown.split("\n").map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const m = line.match(/^(#{1,6})\s+(\S.*)$/);
    if (!m || numberIndex >= prefixes.length) return line;
    const prefix = prefixes[numberIndex++].prefix;
    if (!prefix) return line;
    // 标题文本已自带编号（手打「第一章/1.1/（1）」）则不重复注入
    if (/^第[\d一二三四五六七八九十百千]+[章节]/.test(m[2])) return line;
    if (/^[\d一二三四五六七八九十]+[.．、）)\-]/.test(m[2])) return line;
    if (/^[（(]\s*[\d一二三四五六七八九十]+\s*[）)]/.test(m[2])) return line;
    return `${m[1]} ${prefix} ${m[2]}`;
  }).join("\n");
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
  computeDocxHeadingNumbers,
  injectHeadingPrefixes,
  parseDocxNumbering,
  numberingValueText,
  numPrFromXml,
  readDocxEntryString,
  docxNeedsPdfRepair,
  repairDocxViaRoundtrip,
  findCrcBrokenZipEntries,
  repairZipCrcIfNeeded
};
