// office-convert.js — 飞鼠格式 LibreOffice 转换域：Office 文档（doc/docx/odt/rtf/wps 等）互转与转文本/Markdown。
// 第四批抽取自 server.js（零逻辑改动，纯搬移）。

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const mammoth = require("mammoth");
const { RUNTIME_DIR, LIBREOFFICE_PATH } = require("./config");
const { normalizeExt, extFromName } = require("./utils");
const { createTurndownService } = require("./text-conversion");
const { OfficeEngineError, runLibreOffice } = require("./office-engine");
// 注意：htmlToText 从 text-docx.js 延迟 require（convertDocumentToText 内），
// 避免与 text-docx.js 顶层 require 本模块形成循环依赖。
const sanitize = require("sanitize-filename");

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
    const args = [
      "--convert-to",
      libreOfficeFilterFor(target),
      "--outdir",
      outDir,
      workingInput
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
  convertDocumentToText
};
