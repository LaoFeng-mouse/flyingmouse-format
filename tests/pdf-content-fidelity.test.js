const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");
const { extractPdfRowsByPage, groupPdfItemsIntoRows } = require("../pdf-table");
const { convertPdf, convertPdfToDocx, convertStructuredPdf, validateNativePdfDocx,
  writeDocxZip, xmlDocxParagraph, fillMissingPdfPageText } = require("../pdf");
const { openZipEntriesFromBuffer } = require("../zip-util");

async function scratch(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-pdf-fidelity-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pdfFixture(output, kind = "prose", rotation = 0) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  if (kind === "glyphs") {
    page.setRotation(degrees(rotation));
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const r = rotation * Math.PI / 180;
    [..."HORIZONTALTEXT"].forEach((text, index) => page.drawText(text, {
      x: 300 + Math.cos(r) * index * 14, y: 400 + Math.sin(r) * index * 14,
      font: index % 2 ? font : bold, size: 14, rotate: degrees(rotation)
    }));
  } else {
    page.drawText("Title before body", { font, size: 18, x: 40, y: 780 });
    if (kind === "table") {
      [["Name", "Count", "Unit"], ["Mouse", "42", "pcs"], ["Paper", "12", "kg"]].forEach((row, rowIndex) =>
        row.forEach((text, col) => page.drawText(text, { font, size: 12, x: 40 + col * 150, y: 730 - rowIndex * 24 })));
    } else {
      ["Normal", "prose", "has", "words", "on", "a", "single", "line."].forEach((text, index) =>
        page.drawText(text, { font, size: 12, x: 40 + index * 63, y: 730 }));
    }
    page.drawText("Conclusion after body", { font, size: 12, x: 40, y: 600 });
    if (kind === "mixed") pdf.addPage([595, 842]);
  }
  await fsp.writeFile(output, await pdf.save());
  return output;
}

async function documentXml(docx) {
  const archive = await openZipEntriesFromBuffer(await fsp.readFile(docx));
  return new Promise((resolve, reject) => {
    archive.on("entry", (entry) => {
      if (entry.fileName !== "word/document.xml") return archive.readEntry();
      archive.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => { archive.close(); resolve(Buffer.concat(chunks).toString()); });
      });
    });
    archive.on("error", reject);
    archive.readEntry();
  });
}

for (const rotation of [0, 90, 180, 270]) {
  test(`displayed horizontal PDF glyphs stay on one line at rotation ${rotation}`, async (t) => {
    const dir = await scratch(t);
    const input = await pdfFixture(path.join(dir, "glyphs.pdf"), "glyphs", rotation);
    const pages = await extractPdfRowsByPage(input);
    assert.deepEqual(pages[0].rows, [["HORIZONTALTEXT"]]);
    const output = path.join(dir, "glyphs.docx");
    const result = await convertPdfToDocx(input, output, pages, { docenginePath: null });
    const xml = await documentXml(output);
    assert.match(xml, />HORIZONTALTEXT<\/w:t>/);
    assert.equal((xml.match(/<w:p>/g) || []).length, 1);
    assert.equal(result.warnings[0].code, "PDF_DOCX_LAYOUT_FALLBACK");
  });
}

test("Chinese fragments do not gain spaces", () => {
  const items = [..."这是中文"].map((str, index) => ({ str, transform: [12, 0, 0, 12, 40 + index * 12, 700], width: 12, height: 12 }));
  assert.deepEqual(groupPdfItemsIntoRows(items), [["这是中文"]]);
});

test("positioned prose remains paragraphs in original reading order", async (t) => {
  const dir = await scratch(t);
  const input = await pdfFixture(path.join(dir, "prose.pdf"));
  const output = path.join(dir, "prose.docx");
  await convertPdfToDocx(input, output, null, { docenginePath: null });
  const xml = await documentXml(output);
  assert.doesNotMatch(xml, /<w:tbl>/);
  assert.match(xml, /Normal prose has words on a single line\./);
  assert.ok(xml.indexOf("Title before body") < xml.indexOf("Normal prose"));
  assert.ok(xml.indexOf("Normal prose") < xml.indexOf("Conclusion after body"));
});

test("repeated table columns stay editable between heading and conclusion", async (t) => {
  const dir = await scratch(t);
  const input = await pdfFixture(path.join(dir, "table.pdf"), "table");
  const output = path.join(dir, "table.docx");
  await convertPdfToDocx(input, output, null, { docenginePath: null });
  const xml = await documentXml(output);
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 1);
  assert.equal((xml.match(/<w:tr>/g) || []).length, 3);
  assert.equal((xml.match(/<w:tc>/g) || []).length, 9);
  assert.ok(xml.indexOf("Title before body") < xml.indexOf("<w:tbl>"));
  assert.ok(xml.indexOf("</w:tbl>") < xml.indexOf("Conclusion after body"));
  assert.equal((await validateNativePdfDocx(output)).hasEditableContent, true);
});

async function nativeDocx(output, text) {
  await writeDocxZip(output, [
    { path: "[Content_Types].xml", content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { path: "_rels/.rels", content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { path: "word/document.xml", content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlDocxParagraph(text)}</w:body></w:document>` }
  ]);
}

test("valid native DOCX missing I/L is replaced by complete editable source text", async (t) => {
  const dir = await scratch(t);
  const input = await pdfFixture(path.join(dir, "glyphs.pdf"), "glyphs", 90);
  const output = path.join(dir, "out.docx");
  const result = await convertPdfToDocx(input, output, null, {
    docenginePath: "test-engine", run: async (_engine, args) => nativeDocx(args[2], "HORZONTATEXT"),
    convertStructuredPdf: () => { throw new Error("content recovery should use the reliable text layer"); }
  });
  assert.match((await validateNativePdfDocx(output)).editableText, /HORIZONTALTEXT/);
  assert.equal(result.warnings[0].code, "PDF_DOCX_LAYOUT_FALLBACK");
});

for (const target of ["txt", "html"]) {
  test(`mixed PDF ${target} retains native pages and OCRs only missing page 2`, async (t) => {
    const dir = await scratch(t);
    const input = await pdfFixture(path.join(dir, "mixed.pdf"), "mixed");
    const output = path.join(dir, `out.${target}`);
    const rendered = [];
    let terminated = false;
    await convertPdf(input, output, target, {
      ocrAvailable: () => true,
      createOcrWorker: async () => ({ terminate: async () => { terminated = true; } }),
      renderPdfTablePage: async (_input, pageNumber, tempDir) => { rendered.push(pageNumber); return { outputPath: path.join(tempDir, "page.png") }; },
      recognizeImageTextWithWorker: async () => "SCAN_BODY_42"
    });
    const text = await fsp.readFile(output, "utf8");
    assert.match(text, /Title before body/);
    assert.match(text, /SCAN_BODY_42/);
    assert.deepEqual(rendered, [2]);
    assert.equal(terminated, true);
    assert.ok(text.indexOf("Conclusion after body") < text.indexOf("SCAN_BODY_42"));
  });
}

test("missing OCR rejects an incomplete mixed output and preserves the destination", async (t) => {
  const dir = await scratch(t);
  const input = await pdfFixture(path.join(dir, "mixed.pdf"), "mixed");
  const output = path.join(dir, "out.txt");
  await fsp.writeFile(output, "KEEP");
  await assert.rejects(convertPdf(input, output, "txt", { ocrAvailable: () => false }), { code: "PDF_OCR_REQUIRED" });
  assert.equal(await fsp.readFile(output, "utf8"), "KEEP");
});

test("OCR failures terminate workers and remove their scratch directory", async (t) => {
  let tempDirectory;
  let terminated = false;
  await assert.rejects(fillMissingPdfPageText("input.pdf", [{ pageNumber: 1, rows: [] }], {
    ocrAvailable: () => true,
    createOcrWorker: async () => ({ terminate: async () => { terminated = true; } }),
    renderPdfTablePage: async (_input, _page, dir) => { tempDirectory = dir; throw new Error("render failed"); }
  }), /render failed/);
  assert.equal(terminated, true);
  await assert.rejects(fsp.stat(tempDirectory), { code: "ENOENT" });
});

test("structured DOCX restores omitted native title and keeps scanned content editable", async (t) => {
  const dir = await scratch(t);
  const input = await pdfFixture(path.join(dir, "mixed.pdf"), "mixed");
  const pages = await extractPdfRowsByPage(input);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await fsp.writeFile(path.join(dir, "page.png"), Buffer.from(image, "base64"));
  const manifest = { schemaVersion: 1, engine: { name: "fixture", version: "1" }, pages: [
    { pageNumber: 1, width: 595, height: 842, rotation: 0, referenceImage: "page.png", tableLike: false,
      tables: [], warnings: [], blocks: [{ type: "paragraph", bbox: [40, 100, 550, 114], text: "Normal prose has words on a single line.", confidence: 0.99 }] },
    { pageNumber: 2, width: 595, height: 842, rotation: 0, referenceImage: "page.png", tableLike: false,
      tables: [], warnings: [], blocks: [{ type: "paragraph", bbox: [40, 100, 550, 132], text: "SCAN_BODY_42", confidence: 0.99 }] }
  ] };
  const before = JSON.stringify(manifest);
  const output = path.join(dir, "structured.docx");
  const result = await convertStructuredPdf({ inputPath: input, outputPath: output, target: "docx", options: {
    pdfTextPages: pages, withStructuredPdf: async (_input, _options, consume) => consume(manifest, dir)
  } });
  const xml = await documentXml(output);
  const text = (await validateNativePdfDocx(output)).editableText;
  for (const required of ["Title before body", "Normal prose", "Conclusion after body", "SCAN_BODY_42"]) assert.ok(text.includes(required), required);
  assert.ok(xml.indexOf("Title before body") < xml.indexOf("Normal prose"));
  assert.equal(JSON.stringify(manifest), before);
  assert.equal(result.warnings[0].code, "PDF_NATIVE_TEXT_RESTORED");
});
