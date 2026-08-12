const { parse } = require("csv-parse/sync");
const { marked } = require("marked");
const TurndownService = require("turndown");

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });

  service.addRule("tables", {
    filter: "table",
    replacement(content, node) {
      if (isComplexTable(node)) return `\n\n${serializeSafeTable(node)}\n\n`;
      return `\n\n${simpleTableToMarkdown(node)}\n\n`;
    }
  });

  return service;
}

let sharedTurndownService = null;
function sharedTurndown() {
  if (!sharedTurndownService) sharedTurndownService = createTurndownService();
  return sharedTurndownService;
}

function isComplexTable(table) {
  if (table.querySelector("table")) return true;
  return Array.from(table.querySelectorAll("th, td"))
    .some((cell) => cell.hasAttribute("rowspan") || cell.hasAttribute("colspan"));
}

function markdownTableCell(cell) {
  const html = cell.innerHTML.replace(/\r?\n/g, "<br>");
  return sharedTurndown()
    .turndown(html)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/(?:\s*\n\s*)+/g, "<br>");
}

function simpleTableToMarkdown(table) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children)
      .filter((cell) => cell.nodeName === "TH" || cell.nodeName === "TD")
      .map(markdownTableCell)
  ).filter((row) => row.length > 0);

  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const formatRow = (row) => `| ${row.join(" | ")} |`;
  return [
    formatRow(normalized[0]),
    formatRow(Array(width).fill("---")),
    ...normalized.slice(1).map(formatRow)
  ].join("\n");
}

function escapeHtmlText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function isSafeMarkdownLink(href) {
  const value = String(href || "").trim();
  if (!value) return false;
  if (/^(?:https?:|mailto:)/i.test(value)) return true;
  return /^(?:#|\/|\.\/|\.\.\/)/.test(value);
}

function isSafeMarkdownImage(href) {
  const value = String(href || "").trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith("//")) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function markdownToHtml(markdown) {
  const renderer = new marked.Renderer();
  renderer.html = (html) => escapeHtmlText(html);
  renderer.link = (href, title, text) => {
    if (!isSafeMarkdownLink(href)) return text;
    const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return `<a href="${escapeHtmlAttribute(href)}"${titleAttribute}>${text}</a>`;
  };
  renderer.image = (href, title, text) => {
    if (!isSafeMarkdownImage(href)) return escapeHtmlText(text);
    const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return `<img src="${escapeHtmlAttribute(href)}" alt="${escapeHtmlAttribute(text)}"${titleAttribute}>`;
  };
  const body = marked.parse(String(markdown || ""), {
    async: false,
    gfm: true,
    mangle: false,
    headerIds: false,
    renderer
  });
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Converted document</title></head>
<body>
${body.trim()}
</body>
</html>`;
}

function serializeSafeTable(node) {
  if (node.nodeType === 3) return escapeHtmlText(node.nodeValue || "");
  if (node.nodeType !== 1) return "";

  const tag = node.nodeName.toLowerCase();
  if (["script", "style", "iframe", "object", "embed"].includes(tag)) return "";
  const allowed = new Set([
    "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
    "strong", "b", "em", "i", "code", "br", "p", "ul", "ol", "li"
  ]);
  const children = Array.from(node.childNodes).map(serializeSafeTable).join("");
  if (!allowed.has(tag)) return children;
  if (tag === "br") return "<br>";

  let attributes = "";
  if (tag === "th" || tag === "td") {
    for (const name of ["rowspan", "colspan"]) {
      const raw = node.getAttribute(name);
      if (/^[1-9]\d*$/.test(raw || "")) attributes += ` ${name}="${raw}"`;
    }
  }
  return `<${tag}${attributes}>${children}</${tag}>`;
}

function htmlToMarkdown(html) {
  return createTurndownService().turndown(String(html || "")).trim();
}

function csvToJsonObjects(csv) {
  try {
    return parse(String(csv || ""), {
      bom: true,
      columns: (headers) => {
        const normalized = headers.map((header, index) => String(header || `column_${index + 1}`));
        const seen = new Set();
        const forbidden = new Set(["__proto__", "prototype", "constructor"]);
        for (const header of normalized) {
          const key = header.toLowerCase();
          if (forbidden.has(key)) throw new Error(`CSV 表头不安全：${header}`);
          if (seen.has(key)) throw new Error(`CSV 表头重复：${header}`);
          seen.add(key);
        }
        return normalized;
      },
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

// CSV -> Markdown 表格：用严格 CSV 解析（同 csvToJsonObjects），避免把原始 CSV 文本
// 原样当作 Markdown 输出（v0.3.5 的假实现）。单元格内的 | 与换行做转义。
function csvToMarkdown(csv) {
  let records;
  try {
    records = parse(String(csv || ""), {
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
  if (!records.length) return "";
  const width = Math.max(...records.map((row) => row.length));
  const normalized = records.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const escapeCell = (value) => {
    const CR = String.fromCharCode(13);
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .split(CR + "\n").join("\n")
      .replace(/\n/g, "<br>");
  };
  const formatRow = (row) => `| ${row.map(escapeCell).join(" | ")} |`;
  return [
    formatRow(normalized[0]),
    formatRow(Array(width).fill("---")),
    ...normalized.slice(1).map(formatRow)
  ].join("\n");
}

// CSV -> HTML 表格：严格解析（同 csvToMarkdown），生成带边框的 HTML 表格。
// 用于 csv->html 直接输出与 csv->pdf（HTML 中转 LibreOffice）——LibreOffice 的
// csv 导入过滤器在 headless 下是假成功（exit 0 但零输出），不能直接转。
function csvToHtmlTable(csv) {
  let records;
  try {
    records = parse(String(csv || ""), {
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
  if (!records.length) return "<p>（空 CSV）</p>";
  const width = Math.max(...records.map((row) => row.length));
  const normalized = records.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const cell = (value) => `<td>${escapeHtmlText(String(value ?? ""))}</td>`;
  const rows = normalized.map((row) => `<tr>${row.map(cell).join("")}</tr>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>CSV table</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top}
tr:first-child{font-weight:bold;background:#f5f5f5}
</style>
</head>
<body>
<table>
${rows}
</table>
</body>
</html>`;
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function flattenJsonObject(value, prefix = "", output = Object.create(null)) {
  for (const key of Object.keys(value || {}).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = value[key];
    if (Array.isArray(nested)) setFlattenedValue(output, path, stableJsonStringify(nested));
    else if (nested && typeof nested === "object") flattenJsonObject(nested, path, output);
    else setFlattenedValue(output, path, nested);
  }
  return output;
}

function setFlattenedValue(output, path, value) {
  if (Object.prototype.hasOwnProperty.call(output, path)) {
    const error = new Error(`JSON 转 CSV 失败：字段路径冲突：${path}`);
    error.code = "JSON_CSV_PATH_COLLISION";
    error.path = path;
    throw error;
  }
  output[path] = value;
}

function jsonToCsv(jsonText) {
  const data = JSON.parse(String(jsonText || ""));
  const rows = (Array.isArray(data) ? data : [data]).map((row) => flattenJsonObject(row));
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [
    headers.map(quote).join(","),
    ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))
  ].join("\n");
}

module.exports = { createTurndownService, htmlToMarkdown, markdownToHtml, csvToJsonObjects, csvToMarkdown, csvToHtmlTable, jsonToCsv };
