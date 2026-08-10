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

function isComplexTable(table) {
  if (table.querySelector("table")) return true;
  return Array.from(table.querySelectorAll("th, td"))
    .some((cell) => cell.hasAttribute("rowspan") || cell.hasAttribute("colspan"));
}

function markdownTableCell(cell) {
  const html = cell.innerHTML.replace(/\r?\n/g, "<br>");
  return createTurndownService()
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

function markdownToHtml(markdown) {
  const renderer = new marked.Renderer();
  renderer.html = (html) => escapeHtmlText(html);
  renderer.link = (href, title, text) => {
    if (!isSafeMarkdownLink(href)) return text;
    const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return `<a href="${escapeHtmlAttribute(href)}"${titleAttribute}>${text}</a>`;
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
    if (Array.isArray(nested)) output[path] = stableJsonStringify(nested);
    else if (nested && typeof nested === "object") flattenJsonObject(nested, path, output);
    else output[path] = nested;
  }
  return output;
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

module.exports = { createTurndownService, htmlToMarkdown, markdownToHtml, csvToJsonObjects, jsonToCsv };
