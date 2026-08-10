class OfficeQualityError extends Error {
  constructor(code, messages, details = {}) {
    super(messages.zhCN);
    this.name = "OfficeQualityError";
    this.code = code;
    this.messages = messages;
    this.details = details;
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function visibleBodyText(html) {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(String(html || ""));
  if (!body) return "";
  return decodeHtmlEntities(body[1]
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function validatePresentationHtml(html) {
  const visibleText = visibleBodyText(html);
  if (!visibleText) {
    throw new OfficeQualityError("PRESENTATION_HTML_EMPTY", {
      zhCN: "演示文稿 HTML 导出失败：未在页面正文中找到可见的幻灯片文字。",
      enUS: "Presentation HTML export failed: no visible slide text was found in the page body."
    });
  }
  return { visibleText };
}

function warning(code, messages, details, level = "warning") {
  return { code, level, messages, details };
}

function firstWorksheet(workbook) {
  const sheets = Array.isArray(workbook.worksheets) ? workbook.worksheets : [];
  return sheets[0];
}

function countFormulaCells(worksheets) {
  let count = 0;
  for (const sheet of worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell?.value && typeof cell.value === "object" && typeof cell.value.formula === "string") count += 1;
    }));
  }
  return count;
}

async function inspectXlsxForCsv(inputPath, options = {}) {
  const Workbook = options.Workbook || require("exceljs").Workbook;
  const workbook = new Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheets = Array.isArray(workbook.worksheets) ? workbook.worksheets : [];
  const exported = firstWorksheet(workbook);
  if (!exported) {
    throw new OfficeQualityError("XLSX_CSV_NO_SHEET", {
      zhCN: "XLSX 转 CSV 失败：工作簿中没有可导出的工作表。",
      enUS: "XLSX to CSV failed: the workbook contains no exportable worksheet."
    });
  }

  const exportedSheet = String(exported.name || "Sheet1");
  const ignoredSheets = worksheets.filter((sheet) => sheet !== exported).map((sheet) => String(sheet.name));
  const formulaCount = countFormulaCells(worksheets);
  const warnings = [warning(
    "XLSX_CSV_EXPORTED_SHEET",
    {
      zhCN: `LibreOffice 默认将第一张工作表“${exportedSheet}”导出为 CSV。`,
      enUS: `By default, LibreOffice exports the first worksheet, "${exportedSheet}", to CSV.`
    },
    { exportedSheet },
    "info"
  )];

  if (ignoredSheets.length) {
    warnings.push(warning("XLSX_CSV_SHEETS_OMITTED", {
      zhCN: `CSV 仅导出第一张工作表“${exportedSheet}”；其余 ${ignoredSheets.length} 个工作表不会保留。`,
      enUS: `CSV exports only the first worksheet, "${exportedSheet}"; ${ignoredSheets.length} other worksheet(s) will not be preserved.`
    }, { exportedSheet, ignoredSheets }));
  }

  if (formulaCount) {
    warnings.push(warning("XLSX_CSV_FORMULAS_AS_VALUES", {
      zhCN: `检测到 ${formulaCount} 个公式；CSV 不保留公式表达式，只保留导出时的值。`,
      enUS: `${formulaCount} formula(s) were detected; CSV preserves exported values, not formula expressions.`
    }, { formulaCount }));
  }

  return { exportedSheet, ignoredSheets, formulaCount, warnings };
}

module.exports = {
  OfficeQualityError,
  inspectXlsxForCsv,
  validatePresentationHtml,
  visibleBodyText
};
