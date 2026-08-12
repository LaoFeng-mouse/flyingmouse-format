// text-docx.js — 飞鼠格式文本转换域：txt/md/html/json/csv/tsv/xml/yaml 互转、文本→DOCX、CSV/TSV 真实现。
// 第四批抽取自 server.js（零逻辑改动，纯搬移）。
// 依赖 office-convert.js 的 convertWithLibreOffice（LO html->pdf 管线），单向 require 无循环。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const ExcelJS = require("exceljs");
const yaml = require("js-yaml");
const {
  createTurndownService,
  htmlToMarkdown,
  markdownToHtml,
  csvToJsonObjects,
  jsonToCsv,
  csvToMarkdown,
  csvToHtmlTable
} = require("./text-conversion");
const { xmlToJson } = require("./xml-json");
const { normalizeExt, escapeHtml } = require("./utils");
const { convertWithLibreOffice } = require("./office-convert");

function htmlToText(html) {
  return html
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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdInlineRuns(text) {
  const runs = [];
  const pattern = /(\*\*.+?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push({ t: text.slice(lastIndex, match.index) });
    const token = match[0];
    if (token.startsWith("**")) runs.push({ t: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ t: token.slice(1, -1), code: true });
    else runs.push({ t: token.slice(1, -1), italic: true });
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) runs.push({ t: text.slice(lastIndex) });
  return runs.length ? runs : [{ t: text }];
}

function docxRunXml(runs, base = {}) {
  return runs.map((run) => {
    const props = [];
    if (run.bold || base.bold) props.push("<w:b/>");
    if (run.italic || base.italic) props.push("<w:i/>");
    if (run.code) {
      props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      props.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
    }
    if (base.size) props.push(`<w:sz w:val="${base.size}"/><w:szCs w:val="${base.size}"/>`);
    const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
    return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.t)}</w:t></w:r>`;
  }).join("");
}

function docxParagraphXml(runs, options = {}) {
  const pPr = [];
  if (options.indent) pPr.push(`<w:ind w:left="${options.indent}"/>`);
  if (options.after) pPr.push(`<w:spacing w:after="${options.after}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${pPrXml}${docxRunXml(runs, options)}</w:p>`;
}

// 把 HTML 按块级结构拆成逻辑行，供 convertTextToDocx 逐行识别标题/列表。
function splitHtmlIntoLines(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|table|tr|section|article)\s*>/gi, "</$1>\n")
    .replace(/<li\b[^>]*>/gi, "\n$&")
    .split("\n");
}

async function convertTextToDocx(raw, source, outputPath) {
  let lines;
  if (source === "html" || source === "htm") {
    lines = splitHtmlIntoLines(raw);
  } else {
    const CR = String.fromCharCode(13);
    lines = String(raw).split(CR + "\n").join("\n").split("\n");
  }
  const paragraphs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push(docxParagraphXml([{ t: "" }]));
      continue;
    }
    if (source === "md") {
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = Number(heading[1].length);
        const size = [36, 32, 28, 26, 24, 24][level - 1];
        paragraphs.push(docxParagraphXml(mdInlineRuns(heading[2]), { size, bold: true, after: 120 }));
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        paragraphs.push(docxParagraphXml([{ t: "• " }, ...mdInlineRuns(bullet[1])], { indent: 360 }));
        continue;
      }
      paragraphs.push(docxParagraphXml(mdInlineRuns(trimmed)));
      continue;
    }
    if (source === "html" || source === "htm") {
      // 纯结构标签行（<ul>/</div>/<table> 等）不产生空段落。
      if (/^<\/?(ul|ol|div|table|thead|tbody|tfoot|tr|section|article)\s*>$/i.test(trimmed)) continue;
      const heading = /^<h([1-6])\b[^>]*>([\s\S]*)<\/h\1\s*>$/i.exec(trimmed);
      if (heading) {
        const level = Number(heading[1]);
        const size = [36, 32, 28, 26, 24, 24][level - 1];
        paragraphs.push(docxParagraphXml([{ t: htmlToText(heading[2]) }], { size, bold: true, after: 120 }));
        continue;
      }
      const listItem = /^<li\b[^>]*>([\s\S]*)<\/li\s*>$/i.exec(trimmed);
      if (listItem) {
        paragraphs.push(docxParagraphXml([{ t: "• " }, ...mdInlineRuns(htmlToText(listItem[1]))], { indent: 360 }));
        continue;
      }
      paragraphs.push(docxParagraphXml([{ t: htmlToText(trimmed) }]));
      continue;
    }
    paragraphs.push(docxParagraphXml([{ t: trimmed }]));
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr/></w:body></w:document>`;

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(contentTypes), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(rels), "_rels/.rels");
  zip.addBuffer(Buffer.from(documentXml), "word/document.xml");
  await new Promise((resolve, reject) => {
    const stream = zip.outputStream.pipe(fs.createWriteStream(outputPath));
    stream.on("finish", resolve);
    stream.on("error", reject);
    zip.end();
  });
}

function parseJsonText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON 解析失败：文件内容不是有效的 JSON。");
  }
}

async function convertText(inputPath, outputPath, inputExt, target, originalName = `converted.${normalizeExt(inputExt) || "txt"}`) {
  let raw = await fsp.readFile(inputPath, "utf8");
  let source = normalizeExt(inputExt);
  const warnings = [];
  let converted = raw;

  // TSV 与 CSV 同源：归一化为逗号 CSV 后按 csv 分支处理（json/md 真解析）
  if (source === "tsv") {
    raw = await readTabularText(inputPath, inputExt);
    source = "csv";
  }

  if (target === "pdf") {
    if (source === "md") {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-textpdf-"));
      const htmlPath = path.join(tempDir, "converted.html");
      await fsp.writeFile(htmlPath, markdownToHtml(raw), "utf8");
      try {
        await convertWithLibreOffice(htmlPath, outputPath, "converted.html", "pdf");
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      await convertWithLibreOffice(inputPath, outputPath, originalName, "pdf");
    }
    return;
  }

  if (target === "docx") {
    await convertTextToDocx(raw, source, outputPath);
    return;
  }

  if (target === "txt") {
    if (source === "html") converted = htmlToText(raw);
    else if (source === "json") converted = JSON.stringify(parseJsonText(raw), null, 2);
  } else if (target === "html") {
    if (source === "md") converted = markdownToHtml(raw);
    else if (source === "html") converted = raw;
    else converted = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Converted text</title></head>
<body><pre>${escapeHtml(raw)}</pre></body>
</html>`;
  } else if (target === "md") {
    if (source === "html") converted = htmlToMarkdown(raw);
    else if (source === "json") converted = `\`\`\`json\n${JSON.stringify(parseJsonText(raw), null, 2)}\n\`\`\`\n`;
    else if (source === "csv") converted = csvToMarkdown(raw);
  } else if (target === "json") {
    if (source === "json") converted = JSON.stringify(parseJsonText(raw), null, 2);
    else if (source === "csv") converted = JSON.stringify(csvToJsonObjects(raw), null, 2);
    else if (source === "xml") converted = JSON.stringify(xmlToJson(raw), null, 2);
    else if (source === "yaml" || source === "yml") {
      let parsed;
      try {
        parsed = yaml.load(raw);
      } catch (error) {
        const wrapped = new Error(`YAML 解析失败：${String(error?.message || "未知错误")}`);
        wrapped.code = "YAML_JSON_PARSE_FAILED";
        wrapped.cause = error;
        throw wrapped;
      }
      if (parsed === undefined) {
        const wrapped = new Error("YAML 解析失败：内容为空或格式不合法。");
        wrapped.code = "YAML_JSON_PARSE_FAILED";
        throw wrapped;
      }
      converted = JSON.stringify(parsed, null, 2);
    } else {
      // 无结构文本（txt/md/log 等）没有可解析的结构，JSON 输出只能是原文包装——
      // 明确给出警告，避免用户误以为是真解析（v0.3.5 假实现教训）。
      converted = JSON.stringify({ text: raw }, null, 2);
      warnings.push({
        code: "TEXT_JSON_WRAPPED",
        messages: {
          zhCN: "这个文本没有可识别的结构（JSON/CSV/XML/YAML），JSON 输出仅为原文包装。",
          enUS: "This text has no detectable structure (JSON/CSV/XML/YAML); the JSON output wraps the raw text."
        }
      });
    }
  } else if (target === "csv") {
    if (source === "json") converted = jsonToCsv(raw);
    else converted = raw.split(/\r?\n/).map((line) => `"${line.replaceAll('"', '""')}"`).join("\n");
  }

  await fsp.writeFile(outputPath, converted, "utf8");
  return { warnings };
}

// CSV/TSV -> XLSX：exceljs 直接生成（LibreOffice 的 csv/tsv 导入过滤器在 headless
// 下是假成功——exit 0 但零输出，v0.3.6 实测确认；原路径全部 500）。
async function convertCsvToXlsx(csvText, outputPath) {
  const records = parseCsvRecords(csvText);
  if (!records.length) throw new Error("CSV 内容为空，无法生成表格。");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRows(records);
  await workbook.xlsx.writeFile(outputPath);
}

// CSV/TSV -> PDF：自生成 HTML 表格后交给 LibreOffice html->pdf（该路径实测可靠，
// 同 md->pdf 管线；LO 对 html 输入支持良好）。
async function convertCsvToPdf(csvText, outputPath) {
  const html = csvToHtmlTable(csvText);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-csvpdf-"));
  const htmlPath = path.join(tempDir, "table.html");
  try {
    await fsp.writeFile(htmlPath, html, "utf8");
    await convertWithLibreOffice(htmlPath, outputPath, "table.html", "pdf");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseCsvRecords(csv) {
  // 与 csvToJsonObjects/csvToMarkdown 相同的严格解析（共享 csv-parse 选项）
  const { parse } = require("csv-parse/sync");
  try {
    return parse(String(csv || ""), {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false
    });
  } catch (error) {
    const wrapped = new Error(`CSV 解析失败：列数或引号格式不合法。${error?.message ? ` ${error.message}` : ""}`);
    wrapped.code = "CSV_PARSE_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

// TSV -> 逗号分隔 CSV 文本（tab 解析后重新引号转义）。TSV 与 CSV 同源，
// 统一归一化后走同一套自有实现；避免 LO 的假成功路径。
async function readTabularText(inputPath, inputExt) {
  const raw = await fsp.readFile(inputPath, "utf8");
  if (normalizeExt(inputExt) !== "tsv") return raw;
  const { parse } = require("csv-parse/sync");
  let records;
  try {
    records = parse(raw, {
      bom: true,
      delimiter: "\t",
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false
    });
  } catch (error) {
    const wrapped = new Error(`TSV 解析失败：列数或引号格式不合法。${error?.message ? ` ${error.message}` : ""}`);
    wrapped.code = "CSV_PARSE_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return records.map((row) => row.map(quote).join(",")).join("\n");
}

module.exports = {
  htmlToText,
  escapeXml,
  mdInlineRuns,
  docxRunXml,
  docxParagraphXml,
  splitHtmlIntoLines,
  convertTextToDocx,
  parseJsonText,
  convertText,
  convertCsvToXlsx,
  convertCsvToPdf,
  parseCsvRecords,
  readTabularText
};
