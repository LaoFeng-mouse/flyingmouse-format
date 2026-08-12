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
const { normalizeExt, extFromName } = require("./utils");
const { createTurndownService } = require("./text-conversion");
const { OfficeEngineError, runLibreOffice } = require("./office-engine");
// 注意：htmlToText 从 text-docx.js 延迟 require（convertDocumentToText 内），
// 避免与 text-docx.js 顶层 require 本模块形成循环依赖。
const sanitize = require("sanitize-filename");

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
    // WPS 生成的 docx（OMML 公式 + 交叉引用域）转 PDF 会被 LibreOffice 静默截断：
    // exit 0 但只输出前几页。命中特征时先 roundtrip 规范化修复再导出。
    const targetExt = normalizeExt(target);
    let effectiveInput = workingInput;
    if (targetExt === "pdf" && normalizeExt(originalExt) === "docx" && await docxNeedsPdfRepair(workingInput)) {
      const repaired = await repairDocxViaRoundtrip(workingInput, safeName, tempDir);
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
  if (ext === "docx") {
    const result = await mammoth.convertToHtml({ path: inputPath });
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
  const markdown = turndown.turndown(html).trim();
  if (!markdown) {
    throw new Error("文档转 Markdown 失败，未提取到任何内容。");
  }
  await fsp.writeFile(outputPath, `${markdown}\n`, "utf8");
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
  readDocxEntryString,
  docxNeedsPdfRepair,
  repairDocxViaRoundtrip
};
