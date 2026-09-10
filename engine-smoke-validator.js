// Separate process used by the synchronous Store engine bootstrap. Resolve only
// this application's PDF.js, including when this file resides inside app.asar.
const fs = require("fs");
const { loadPdfjs } = require("./pdfjs");

async function validateSmokePdf(pdfPath) {
  const bytes = fs.readFileSync(pdfPath);
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  let document;
  try {
    document = await task.promise;
    if (document.numPages !== 1) throw new Error("冒烟 PDF 页数不正确");
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    if (!/\bflyingmouse\b/i.test(text) || !/\b42\b/.test(text)) {
      throw new Error("冒烟 PDF 缺少预期转换文字");
    }
    return { pages: document.numPages, text };
  } finally {
    await task.destroy();
  }
}

if (require.main === module) {
  validateSmokePdf(process.argv[2]).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  );
}

module.exports = { validateSmokePdf };
