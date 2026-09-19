const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fm-merge-regression-"));
process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(scratch, "runtime");
const { startServer } = require("../server");
const { convertImagesToPdf } = require("../image");
let running, png, input;
before(async () => {
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#e0f2fe" } }).png().toBuffer();
  input = path.join(scratch, "image.png");
  await fsp.writeFile(input, png);
  running = await startServer(0);
});
after(async () => {
  if (running) await new Promise(resolve => running.server.close(resolve));
  if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith("fm-merge-regression-")) throw Error("Unexpected cleanup root");
  await fsp.rm(scratch, { recursive: true, force: true });
});
test("image PDF upload preserves repeated blank pages at the beginning, middle and end", async () => {
  for (const blanks of ["0,0", "1,1", "2,2"]) {
    const body = new FormData();
    body.append("files", new Blob([png]), "first.png");
    body.append("files", new Blob([png]), "second.png");
    body.append("blanks", blanks);
    const response = await fetch(running.url + "/api/convert-images-to-pdf", { method: "POST", body });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const download = await fetch(running.url + result.downloadUrl);
    const pdf = await PDFDocument.load(await download.arrayBuffer());
    assert.equal(pdf.getPageCount(), 4, "both requested blank pages must remain in the downloaded PDF: " + blanks);
  }
});
test("image PDF merge stops after cancellation at the first completed page", async () => {
  const controller = new AbortController();
  const output = path.join(scratch, "canceled.pdf");
  const progress = [];
  await assert.rejects(convertImagesToPdf(Array.from({ length: 8 }, () => ({ inputPath: input })), output, {
    signal: controller.signal,
    onProgress(event) { progress.push(event); if (event.completedPages === 1) controller.abort(); }
  }), error => error.code === "CONVERSION_CANCELED");
  assert.equal(progress.at(-1).completedPages, 1);
});
