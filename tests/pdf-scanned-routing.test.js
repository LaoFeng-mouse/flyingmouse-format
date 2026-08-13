const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { test } = require("node:test");

const { convertPdf } = require("../pdf");
const { createScannedTablePdf } = require("./helpers/scanned-pdf-fixture");

test("routes scanned DOCX through the structure converter", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-scanned-route-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = await createScannedTablePdf(path.join(scratch, "scan.pdf"));
  const outputPath = path.join(scratch, "scan.docx");
  const calls = [];
  await convertPdf(inputPath, outputPath, "docx", {
    classifyPdf: async () => ({ kind: "scanned", pages: [{ pageNumber: 1, kind: "scanned" }] }),
    convertStructuredPdf: async ({ target }) => {
      calls.push(target);
      await fsp.writeFile(outputPath, "fake");
    }
  });
  assert.deepEqual(calls, ["docx"]);
});
