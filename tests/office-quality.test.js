const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  OfficeQualityError,
  inspectXlsxForCsv,
  validatePresentationHtml,
  visibleBodyText
} = require("../office-quality");

test("presentation HTML accepts visible slide text inside a non-empty body", () => {
  const result = validatePresentationHtml(`<!doctype html><html><head><title>Deck</title></head>
    <body><section><h1>Quarterly results</h1><p>Revenue grew.</p></section></body></html>`);

  assert.equal(result.visibleText, "Quarterly results Revenue grew.");
});

test("presentation HTML rejects missing, empty, and non-visible bodies with a stable bilingual error", () => {
  for (const html of [
    "<html><head><title>Only a title</title></head></html>",
    "<html><body>  </body></html>",
    "<html><body><script>slideText = 'hidden';</script><style>.x{}</style><!-- note --></body></html>"
  ]) {
    assert.throws(
      () => validatePresentationHtml(html),
      (error) => error instanceof OfficeQualityError
        && error.code === "PRESENTATION_HTML_EMPTY"
        && /幻灯片/.test(error.messages.zhCN)
        && /slide text/i.test(error.messages.enUS)
    );
  }
});

test("XLSX to CSV follows LibreOffice CLI by exporting the first sheet, not activeTab", async () => {
  class Workbook {
    constructor() {
      this.views = [{ activeTab: 1 }];
      this.worksheets = [
        worksheet("Overview", [{ formula: "SUM(A1:A2)", result: 3 }, 3]),
        worksheet("Data", [1]),
        worksheet("Archive", ["old"])
      ];
      this.xlsx = { readFile: async (filePath) => { this.loadedPath = filePath; } };
    }
  }

  const result = await inspectXlsxForCsv("book.xlsx", { Workbook });

  assert.equal(result.exportedSheet, "Overview");
  assert.deepEqual(result.ignoredSheets, ["Data", "Archive"]);
  assert.equal(result.formulaCount, 1);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "XLSX_CSV_EXPORTED_SHEET",
    "XLSX_CSV_SHEETS_OMITTED",
    "XLSX_CSV_FORMULAS_AS_VALUES"
  ]);
  for (const warning of result.warnings) {
    assert.ok(warning.messages.zhCN);
    assert.ok(warning.messages.enUS);
  }
  assert.match(result.warnings[0].messages.zhCN, /第一张工作表/);
  assert.match(result.warnings[0].messages.enUS, /first worksheet/i);
  assert.deepEqual(result.warnings[1].details, {
    exportedSheet: "Overview",
    ignoredSheets: ["Data", "Archive"]
  });
});

test("XLSX to CSV falls back to the first sheet and emits no loss warning for a plain single-sheet book", async () => {
  class Workbook {
    constructor() {
      this.views = [];
      this.worksheets = [worksheet("Only", ["plain value"])];
      this.xlsx = { readFile: async () => {} };
    }
  }

  const result = await inspectXlsxForCsv("single.xlsx", { Workbook });

  assert.equal(result.exportedSheet, "Only");
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["XLSX_CSV_EXPORTED_SHEET"]);
});

test("server wires Office quality results into the existing warning and bilingual error contracts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /require\(["']\.\/office-quality["']\)/);
  assert.match(source, /inspectXlsxForCsv\(file\.path\)/);
  assert.match(source, /conversionResult\s*=\s*await inspectXlsxForCsv/);
  assert.match(source, /validatePresentationHtml\(await fsp\.readFile\(outputPath, ["']utf8["']\)\)/);
  assert.match(source, /payload\.messages\s*=\s*error\.messages/);
});

test("Win7 staging copies the Office quality runtime module", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "win7-build-profile.js"), "utf8");
  assert.match(source, /["']office-quality\.js["']/);
});

test("numeric HTML entities outside the Unicode range never crash text extraction", () => {
  assert.equal(
    visibleBodyText("<body><p>x &#99999999; y &#x110000; z</p></body>"),
    "x &#99999999; y &#x110000; z"
  );
  assert.equal(
    visibleBodyText("<body><p>ok &#65; &#x41; end</p></body>"),
    "ok A A end"
  );
});

function worksheet(name, values) {
  return {
    name,
    eachRow(callback) {
      callback({
        eachCell(cellCallback) {
          values.forEach((value) => cellCallback({ value }));
        }
      });
    }
  };
}
