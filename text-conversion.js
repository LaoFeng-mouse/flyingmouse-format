const { parse } = require("csv-parse/sync");
const TurndownService = require("turndown");

function createTurndownService() {
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });
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

module.exports = { createTurndownService, htmlToMarkdown, csvToJsonObjects };
