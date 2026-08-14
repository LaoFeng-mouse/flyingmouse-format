// pdf.js — 飞鼠格式 PDF 转换域：加密/拆分/合并/渲染图片/扫描 OCR/表格→Excel/DOCX/HTML。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。
// convertScannedPdfToOcrDocx 依赖 text-docx.js（第四批），convertPresentationTo* 依赖
// office-convert.js（第四批）——顶层不 require 以避免循环，函数内延迟 require。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const sanitize = require("sanitize-filename");
const { PDFDocument } = require("pdf-lib");
const { PDFTOPPM_PATH, DOCENGINE_PATH, QPDF_PATH, pdfImageTargets } = require("./config");
const { run, commandExists, escapeHtml, safeBaseName } = require("./utils");
const { zipFiles, openZipEntries, readZipEntryToFile } = require("./zip-util");
const { convertImagesToPdf } = require("./image");
const { ocrAvailable, createOcrWorker, recognizeImageTextWithWorker } = require("./ocr");
const { loadPdfjs } = require("./pdfjs");
const {
  extractPdfRowsByPage,
  extractComplexPdfTableModel,
  writePdfTableWorkbook
} = require("./pdf-table");
const { assertPdfPages } = require("./resource-policy");
const { OfficeQualityError } = require("./office-quality");

async function convertPdfDecrypt(inputPath, outputPath, password) {
  const pwd = String(password || "");
  // 优先用 qpdf（支持 RC4/AES-128/AES-256，含本应用 qpdf 加密的 AES-256 输出）；
  // qpdf 缺失时回退 pdf-lib（仅支持 RC4/AES-128，兜底）。
  if (await commandExists(QPDF_PATH, ["--version"])) {
    const args = pwd
      ? [`--password=${pwd}`, "--decrypt", "--", inputPath, outputPath]
      : ["--decrypt", "--", inputPath, outputPath];
    await run(QPDF_PATH, args, { timeout: 1000 * 60 * 5 });
    return;
  }
  const data = await fsp.readFile(inputPath);
  const pdf = await PDFDocument.load(data, { password: pwd, ignoreEncryption: false });
  await fsp.writeFile(outputPath, await pdf.save());
}

async function convertPdfEncrypt(inputPath, outputPath, password) {
  const pwd = String(password || "").trim();
  if (!pwd) {
    const error = new Error("加密 PDF 需要先设置密码。");
    error.code = "PDF_ENCRYPT_NO_PASSWORD";
    error.messages = {
      zhCN: "加密 PDF 需要先设置密码。",
      enUS: "A password is required to encrypt the PDF."
    };
    throw error;
  }
  if (!(await commandExists(QPDF_PATH, ["--version"]))) {
    const error = new Error("PDF 加密引擎（qpdf）不可用，请确认安装包完整。");
    error.code = "PDF_ENCRYPT_UNAVAILABLE";
    error.messages = {
      zhCN: "PDF 加密引擎（qpdf）不可用，请确认安装包完整。",
      enUS: "PDF encryption engine (qpdf) is unavailable. Verify the installation bundle is complete."
    };
    throw error;
  }
  await run(QPDF_PATH, ["--encrypt", pwd, pwd, "256", "--", inputPath, outputPath], { timeout: 1000 * 60 * 5 });
}

const OCR_QUALITY_THRESHOLD = 0.65;

function assertPdfTableOcrQuality(model) {
  const ocrPages = (model?.summary || []).filter((page) => page.source === "ocr" && page.tableCount > 0);
  if (!ocrPages.length) return;
  const worst = Math.min(...ocrPages.map((page) => page.confidence));
  if (worst >= OCR_QUALITY_THRESHOLD) return;
  const percent = Math.round(worst * 100);
  const error = new Error(
    `扫描件 OCR 识别质量过低（最低置信度 ${percent}%），无法准确转换表格。可能原因是图片模糊、倾斜、阴影或分辨率不足；请提供更清晰的扫描件后重试。`
  );
  error.code = "PDF_TABLE_OCR_LOW_QUALITY";
  error.messages = {
    zhCN: `扫描件 OCR 识别质量过低（置信度 ${percent}%），可能因模糊、倾斜或阴影导致，无法准确转换表格。`,
    enUS: `Scanned PDF OCR quality is too low (confidence ${percent}%). The page may be blurry, skewed, or shadowed, so the table cannot be converted accurately.`
  };
  throw error;
}

async function convertPdf(inputPath, outputPath, target, options = {}) {
  if (target === "pdf") {
    if (options.pdfAction === "encrypt") {
      await convertPdfEncrypt(inputPath, outputPath, options.password);
    } else if (options.pdfAction === "decrypt") {
      await convertPdfDecrypt(inputPath, outputPath, options.password || "");
    } else {
      await splitPdfToZip(inputPath, outputPath, options);
    }
    return;
  }

  if (pdfImageTargets.includes(target)) {
    await convertPdfPagesToImagesZip(inputPath, outputPath, target);
    return;
  }

  if (target === "xlsx") {
    const model = await extractComplexPdfTableModel(inputPath);
    assertPdfTableOcrQuality(model);
    await writePdfTableWorkbook(model, outputPath);
    return;
  }

  const pages = await extractPdfRowsByPage(inputPath);
  const hasExtractableRows = pages.some((page) => page.rows.length);

  if (!hasExtractableRows) {
    if (target === "txt") {
      await convertScannedPdfToOcrText(inputPath, outputPath);
      return;
    }
    if (target === "docx") {
      await convertScannedPdfToOcrDocx(inputPath, outputPath);
      return;
    }
    if (target === "html") {
      await convertScannedPdfToOcrHtml(inputPath, outputPath);
      return;
    }
    throw new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF。");
  }

  if (target === "txt") {
    const text = pages
      .map((page) => [`## ${page.name}`, ...page.rows.map((row) => row.join("\t"))].join("\n"))
      .join("\n\n");
    await fsp.writeFile(outputPath, text, "utf8");
    return;
  }

  if (target === "html") {
    const body = pages.map((page) => {
      const rows = page.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("\n");
      return `<h2>${escapeHtml(page.name)}</h2><table>${rows}</table>`;
    }).join("\n");
    await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PDF table export</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px}
table{border-collapse:collapse;margin-bottom:24px}
td{border:1px solid #999;padding:4px 8px;vertical-align:top}
</style>
</head>
<body>${body}</body>
</html>`, "utf8");
    return;
  }

  if (target === "docx") {
    await convertPdfToDocx(inputPath, outputPath, pages);
    return;
  }

  throw new Error("PDF 暂时只支持转换为 XLSX、TXT、HTML、DOCX、PNG、JPG，或拆分为单页 PDF。");
}

function xmlDocxText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlDocxParagraph(text, bold = false) {
  const run = bold ? `<w:rPr><w:b/></w:rPr>` : "";
  return `<w:p><w:r>${run}<w:t xml:space="preserve">${xmlDocxText(text)}</w:t></w:r></w:p>`;
}

function writeDocxZip(outputPath, entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const entry of entries) {
      archive.addBuffer(Buffer.from(entry.content, "utf8"), entry.path);
    }
    const output = fs.createWriteStream(outputPath);
    archive.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
    archive.end();
  });
}

async function convertPdfToDocx(inputPath, outputPath, pages) {
  // 优先用文档引擎（docengine convert）做版式还原（段落/表格/图片/字体）；引擎缺失或转换失败时回退到 PDF.js 文字提取。
  if (DOCENGINE_PATH) {
    try {
      await run(DOCENGINE_PATH, ["convert", inputPath, outputPath], { timeout: 1000 * 60 * 10 });
      return;
    } catch (error) {
      // 文档引擎转换失败（异常 PDF）→ 回退到文字提取，不中断转换。
    }
  }

  const source = pages || await extractPdfRowsByPage(inputPath);
  const hasExtractableRows = source.some((page) => page.rows.length);
  if (!hasExtractableRows) {
    throw new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF。扫描版需要 OCR 后才能转 Word。");
  }

  const body = [];
  for (const page of source) {
    body.push(xmlDocxParagraph(page.name, true));
    const multiColumnRows = page.rows.filter((row) => row.length > 1);
    const singleRows = page.rows.filter((row) => row.length <= 1);
    if (multiColumnRows.length) {
      body.push("<w:tbl>");
      for (const row of multiColumnRows) {
        body.push("<w:tr>");
        for (const cell of row) {
          body.push(`<w:tc><w:p><w:r><w:t xml:space="preserve">${xmlDocxText(cell)}</w:t></w:r></w:p></w:tc>`);
        }
        body.push("</w:tr>");
      }
      body.push("</w:tbl>");
    }
    for (const row of singleRows) {
      body.push(xmlDocxParagraph(row[0] || ""));
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join("\n")}
<w:sectPr/>
</w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  await writeDocxZip(outputPath, [
    { path: "[Content_Types].xml", content: contentTypes },
    { path: "_rels/.rels", content: rels },
    { path: "word/document.xml", content: documentXml }
  ]);
}

async function splitPdfToZip(inputPath, outputPath, options = {}) {
  const mode = String(options.splitMode || "page");
  const groupSize = Math.max(1, Math.floor(Number(options.groupSize) || 1));
  const splitPages = mode === "group" ? groupSize : 1;

  // qpdf 可用时用 --split-pages（支持逐页 / 每 N 页一组，速度快）；否则回退 pdf-lib 逐页拆分。
  if (await commandExists(QPDF_PATH, ["--version"])) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-split-"));
    try {
      const prefix = path.join(tempDir, "page-%d.pdf");
      await run(QPDF_PATH, [`--split-pages=${splitPages}`, inputPath, prefix], { timeout: 1000 * 60 * 5 });
      const entries = (await fsp.readdir(tempDir))
        .filter((name) => name.endsWith(".pdf"))
        .sort()
        .map((name) => {
          // qpdf 命名：逐页 = page-N.pdf，分组 = page-N-M.pdf（末组单页也是 page-N-N.pdf）。
          // 统一补零为 page-001.pdf / page-001-002.pdf，与 pdf-lib 回退路径命名一致，
          // 保证排序稳定、断言不因引擎而异。保留原始形态：单页不加范围后缀，分组保留 -M。
          const single = /^page-(\d+)\.pdf$/.exec(name);
          const ranged = /^page-(\d+)-(\d+)\.pdf$/.exec(name);
          let archiveName;
          if (single) {
            archiveName = `page-${String(Number(single[1])).padStart(3, "0")}.pdf`;
          } else if (ranged) {
            archiveName = `page-${String(Number(ranged[1])).padStart(3, "0")}-${String(Number(ranged[2])).padStart(3, "0")}.pdf`;
          } else {
            archiveName = name;
          }
          return { inputPath: path.join(tempDir, name), archiveName };
        });
      if (!entries.length) {
        throw new Error("PDF 拆分失败，未生成任何页面。");
      }
      await zipFiles(entries, outputPath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  // 回退：pdf-lib 逐页拆分（不依赖 qpdf）
  const src = await PDFDocument.load(await fsp.readFile(inputPath), { ignoreEncryption: true });
  assertPdfPages(src.getPageCount());
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-split-"));
  try {
    const entries = [];
    for (let index = 0; index < src.getPageCount(); index += 1) {
      const single = await PDFDocument.create();
      const [page] = await single.copyPages(src, [index]);
      single.addPage(page);
      const pagePath = path.join(tempDir, `page-${String(index + 1).padStart(3, "0")}.pdf`);
      await fsp.writeFile(pagePath, await single.save());
      entries.push({ inputPath: pagePath, archiveName: `page-${String(index + 1).padStart(3, "0")}.pdf` });
    }
    if (!entries.length) {
      throw new Error("PDF 拆分失败，未生成任何页面。");
    }
    await zipFiles(entries, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function mergePdfFiles(pdfFiles, outputPath) {
  const merged = await PDFDocument.create();
  let totalPages = 0;
  for (const file of pdfFiles) {
    const src = await PDFDocument.load(await fsp.readFile(file.inputPath), { ignoreEncryption: true });
    totalPages += src.getPageCount();
    assertPdfPages(totalPages);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  const bytes = await merged.save();
  if (!bytes.length) {
    throw new Error("PDF 合并失败，未生成任何内容。");
  }
  await fsp.writeFile(outputPath, bytes);
}

async function renderPdfPages(inputPath, target = "png", dpi = 150, { ocr = false } = {}) {
  const sourcePdf = await PDFDocument.load(await fsp.readFile(inputPath), { ignoreEncryption: true });
  assertPdfPages(sourcePdf.getPageCount(), { ocr });
  if (!(await commandExists(PDFTOPPM_PATH, ["-v"]))) {
    throw new Error("PDF 转图片引擎未启用。请确认安装包内置的 Poppler 文件完整。");
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-pdf-pages-"));
  try {
    const prefix = path.join(tempDir, "page");
    const formatArg = target === "jpg" ? "-jpeg" : "-png";
    await run(PDFTOPPM_PATH, [formatArg, "-cropbox", "-r", String(dpi), inputPath, prefix], { timeout: 1000 * 60 * 20 });
    const ext = target === "jpg" ? ".jpg" : ".png";
    const files = (await fsp.readdir(tempDir))
      .filter((file) => file.toLowerCase().endsWith(ext))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((file) => path.join(tempDir, file));

    if (!files.length) throw new Error("PDF 转图片失败，未生成任何页面图片。");
    return { tempDir, files };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function convertPdfPagesToImagesZip(inputPath, outputPath, target) {
  const rendered = await renderPdfPages(inputPath, target, 300);
  try {
    await zipFiles(
      rendered.files.map((file, index) => ({
        inputPath: file,
        archiveName: `page-${String(index + 1).padStart(3, "0")}.${target}`
      })),
      outputPath
    );
  } finally {
    await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertScannedPdfToOcrText(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const combined = pages.map((page) => `## ${page.name}\n${page.text || "[OCR 未识别出文字]"}`).join("\n\n").trim();
  await fsp.writeFile(outputPath, `${combined}\n`, "utf8");
}

// 扫描版 PDF -> Word：OCR 识别每页文字，生成可编辑 DOCX（纯文本段落）。
async function convertScannedPdfToOcrDocx(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const combined = pages.map((page) => `## ${page.name}\n${page.text || "[OCR 未识别出文字]"}`).join("\n\n");
  const { convertTextToDocx } = require("./text-docx");
  await convertTextToDocx(combined, "txt", outputPath);
}

// 扫描版 PDF -> HTML：OCR 识别每页文字，生成可读 HTML。
async function convertScannedPdfToOcrHtml(inputPath, outputPath) {
  const pages = await ocrScannedPdfPages(inputPath);
  const body = pages.map((page) =>
    `<h2>${escapeHtml(page.name)}</h2>\n<p>${escapeHtml(page.text || "[OCR 未识别出文字]").replace(/\n/g, "<br>\n")}</p>`
  ).join("\n");
  await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PDF OCR 文本</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6}
h2{color:#333;border-bottom:1px solid #ddd;padding-bottom:4px}
</style>
</head>
<body>
${body}
</body>
</html>`, "utf8");
}

// OCR 扫描版 PDF 的每一页，返回 [{ name, text }]；OCR 不可用或完全识别不出时抛明确错误。
async function ocrScannedPdfPages(inputPath) {
  if (!ocrAvailable()) {
    const error = new Error("这个 PDF 没有可提取的文字，可能是扫描版图片 PDF，需要 OCR 识别后才能转换，但 OCR 引擎未启用。");
    error.code = "PDF_OCR_REQUIRED";
    error.messages = {
      zhCN: "这个 PDF 没有可提取的文字，可能是扫描版图片 PDF，需要 OCR 识别后才能转换，但 OCR 引擎未启用。",
      enUS: "This PDF has no extractable text; it may be a scanned image PDF that requires OCR, but the OCR engine is not available."
    };
    throw error;
  }

  const rendered = await renderPdfPages(inputPath, "png", 300, { ocr: true });
  let worker = null;
  try {
    worker = await createOcrWorker();
    const pages = [];
    for (let index = 0; index < rendered.files.length; index += 1) {
      const text = await recognizeImageTextWithWorker(worker, rendered.files[index]);
      pages.push({ name: `Page ${index + 1}`, text: String(text || "").trim() });
    }
    if (!pages.some((page) => page.text)) {
      throw new Error("OCR 没有识别出文字。请确认 PDF 扫描页清晰、文字方向正确。");
    }
    return pages;
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await fsp.rm(rendered.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 演示文稿 -> 图片：LibreOffice 转 PDF 后按页渲染为 PNG/JPG（依赖第四批 office-convert.js）。
async function convertPresentationToImages(inputPath, outputPath, originalName, target) {
  const { convertWithLibreOffice } = require("./office-convert");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ppt-images-"));
  try {
    const pdfPath = path.join(tempDir, "slides.pdf");
    await convertWithLibreOffice(inputPath, pdfPath, originalName, "pdf");
    await convertPdfPagesToImagesZip(pdfPath, outputPath, target);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 演示文稿 -> HTML：LibreOffice 的 pptx->html 导出过滤器在本便携版只输出空页面框架，
// 因此改为 LO 转 PDF 后用 PDF.js 提取每页文字，生成带标题的可读 HTML。
async function convertPresentationToHtml(inputPath, outputPath, originalName) {
  const { convertWithLibreOffice } = require("./office-convert");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ppt-html-"));
  try {
    const pdfPath = path.join(tempDir, "slides.pdf");
    await convertWithLibreOffice(inputPath, pdfPath, originalName, "pdf");
    const pages = await extractPdfRowsByPage(pdfPath);
    const visibleText = pages.flatMap((page) => page.rows.flat()).join(" ").trim();
    if (!visibleText) {
      throw new OfficeQualityError("PRESENTATION_HTML_EMPTY", {
        zhCN: "演示文稿 HTML 导出失败：未提取到任何幻灯片文字。请确认幻灯片是文字版而不是纯图片。",
        enUS: "Presentation HTML export failed: no slide text was extracted. Make sure the slides contain text, not only images."
      });
    }
    const body = pages.map((page) =>
      `<h2>${escapeHtml(page.name)}</h2>\n${page.rows.map((row) => `<p>${escapeHtml(row.join(" "))}</p>`).join("\n")}`
    ).join("\n");
    await fsp.writeFile(outputPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(safeBaseName(originalName))}</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6}
h2{color:#333;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px}
</style>
</head>
<body>
${body}
</body>
</html>`, "utf8");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertZipImagesToPdf(inputPath, outputPath) {
  const zipfile = await openZipEntries(inputPath);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-zip-images-"));
  const imageExts = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tiff", "tif"]);
  try {
    const images = [];
    const pending = new Promise((resolve, reject) => {
      zipfile.on("entry", (entry) => {
        const baseName = path.posix.basename(entry.fileName);
        const ext = path.posix.extname(baseName).toLowerCase().replace(".", "");
        const safeName = sanitize(baseName) || `file-${images.length}`;
        if (imageExts.has(ext) && !entry.fileName.includes("..")) {
          const outPath = path.join(tempDir, `${images.length}-${safeName}`);
          readZipEntryToFile(zipfile, entry, outPath)
            .then(() => {
              images.push({ inputPath: outPath, originalName: safeName });
              zipfile.readEntry();
            })
            .catch(reject);
          return;
        }
        zipfile.readEntry();
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolve();
      });
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
    await pending;
    if (!images.length) {
      throw new Error("ZIP 内没有找到可合并为 PDF 的图片（支持 png/jpg/webp/gif/bmp/avif/tiff）。");
    }
    await convertImagesToPdf(images, outputPath);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  convertPdfDecrypt,
  assertPdfTableOcrQuality,
  convertPdf,
  xmlDocxText,
  xmlDocxParagraph,
  writeDocxZip,
  convertPdfToDocx,
  splitPdfToZip,
  mergePdfFiles,
  renderPdfPages,
  convertPdfPagesToImagesZip,
  convertScannedPdfToOcrText,
  convertScannedPdfToOcrDocx,
  convertScannedPdfToOcrHtml,
  ocrScannedPdfPages,
  convertPresentationToImages,
  convertPresentationToHtml,
  convertZipImagesToPdf
};
