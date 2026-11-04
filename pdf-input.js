// Reject files renamed to .pdf before dispatching them to a conversion engine.
// This checks the signature only; a PDF body still needs the normal parser checks.
const fsp = require("fs/promises");
const path = require("path");

async function assertPdfInputHeader(inputPath, originalName) {
  const input = await fsp.open(inputPath, "r");
  try {
    // pdf-lib can find a header after leading bytes. Preserve that compatibility
    // without loading a potentially large, invalid upload into memory twice.
    const buffer = Buffer.alloc(64 * 1024);
    let previous = "";
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = previous + buffer.toString("latin1", 0, bytesRead);
      if (/%PDF-\d\.\d/.test(chunk)) return;
      previous = chunk.slice(-7);
    }
  } finally {
    await input.close();
  }
  const name = path.basename(String(originalName || inputPath)).replace(/[\r\n]/g, " ");
  const messages = {
    zhCN: `“${name}”不是有效的 PDF：未找到 PDF 文件头。请重新获取原始 PDF 后重试；仅修改扩展名不能转换文件。`,
    enUS: `"${name}" is not a valid PDF: no PDF header was found. Obtain the original PDF and try again; changing a file extension does not convert its contents.`
  };
  throw Object.assign(new Error(messages.zhCN), { code: "PDF_INVALID_INPUT", messages });
}

module.exports = { assertPdfInputHeader };
