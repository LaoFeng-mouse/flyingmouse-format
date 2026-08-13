const assert = require("assert/strict");
const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { test } = require("node:test");

const { convertPdf } = require("../pdf");
const { createScannedTablePdf } = require("./helpers/scanned-pdf-fixture");

test("creates deterministic scanned PDF fixtures", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-fixture-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const firstPath = await createScannedTablePdf(path.join(scratch, "first.pdf"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const secondPath = await createScannedTablePdf(path.join(scratch, "second.pdf"));
  const [first, second] = await Promise.all([fsp.readFile(firstPath), fsp.readFile(secondPath)]);
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(sha256(first), sha256(second));
});

test("routes scanned DOCX through the structure converter", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-route-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = await createScannedTablePdf(path.join(scratch, "scan.pdf"));
  const outputPath = path.join(scratch, "scan.docx");
  const calls = [];
  const classification = { kind: "scanned", pages: [{ pageNumber: 1, kind: "scanned" }] };
  await convertPdf(inputPath, outputPath, "docx", {
    classifyPdf: async () => classification,
    convertStructuredPdf: async (args) => {
      calls.push(args);
      await fsp.writeFile(args.outputPath, "fake");
    }
  });
  assert.equal(calls.length, 1, "expected one structured conversion call");
  assert.equal(calls[0].inputPath, inputPath);
  assert.equal(calls[0].outputPath, outputPath);
  assert.equal(calls[0].target, "docx");
  assert.deepEqual(calls[0].classification, classification);
});
