const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PDFDocument } = require("pdf-lib");
const { detectCajVariant, extractClassicCajPdfObjects, addMissingPageTree, rebuildPdf, convertCajToPdf } = require("../caj-convert");
const { categoryForExt, targetsForExt } = require("../utils");

function syntheticClassicCaj() {
  const objects = "1 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n";
  const pdfStart = 0x80;
  const pointerOffset = 0x40;
  const buffer = Buffer.alloc(pdfStart + Buffer.byteLength(objects, "latin1"));
  buffer.write("CAJ", 0, "ascii");
  buffer.writeInt32LE(1, 0x10);
  buffer.writeInt32LE(pointerOffset, 0x14);
  buffer.writeInt32LE(pdfStart, pointerOffset);
  buffer.write(objects, pdfStart, "latin1");
  return buffer;
}

test("detects CAJ container variants", () => {
  assert.equal(detectCajVariant(Buffer.from("%PDF-1.7")), "pdf");
  assert.equal(detectCajVariant(Buffer.from("CAJ\0data", "latin1")), "caj");
  assert.equal(detectCajVariant(Buffer.from("HN\0\0data", "latin1")), "hn");
  assert.equal(detectCajVariant(Buffer.from([0xc8, 0, 0, 0])), "c8");
  assert.equal(detectCajVariant(Buffer.from("nope")), "unknown");
});

test("rebuilds classic CAJ PDF objects and missing page tree", async () => {
  const extracted = extractClassicCajPdfObjects(syntheticClassicCaj());
  const root = addMissingPageTree(extracted.objects, extracted.pageCount);
  const pdf = rebuildPdf(extracted.objects, root);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
});

test("converts PDF-backed CAJ and rejects unsupported variants", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-caj-"));
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const input = path.join(root, "paper.caj");
  const output = path.join(root, "paper.pdf");
  await fsp.writeFile(input, await document.save());
  assert.equal((await convertCajToPdf(input, output)).variant, "pdf");
  assert.equal((await PDFDocument.load(await fsp.readFile(output))).getPageCount(), 1);
  await fsp.writeFile(input, Buffer.from("HN\0\0unsupported", "latin1"));
  await assert.rejects(convertCajToPdf(input, output), (error) => error.code === "CAJ_VARIANT_UNSUPPORTED");
});

test("CAJ is exposed only as a PDF source conversion", () => {
  assert.equal(categoryForExt("caj"), "caj");
  assert.deepEqual(new Set(targetsForExt("caj", {})), new Set(["zip", "pdf"]));
});
