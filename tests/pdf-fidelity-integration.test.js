"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Document, Paragraph, Math: OfficeMath, MathFraction, MathRun, Packer } = require("docx");
const { validateNativePdfDocx, writeDocxZip, convertStructuredPdf, convertPdfToDocx } = require("../pdf");

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-pdf-fidelity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("native DOCX validation counts actual editable fraction numerator and denominator", async t => {
  const file = path.join(await temporary(t), "fraction.docx");
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new OfficeMath({ children: [
    new MathRun("x="), new MathFraction({ numerator: [new MathRun("a+b")], denominator: [new MathRun("c-d")] })
  ] })] })] }] });
  await fs.writeFile(file, await Packer.toBuffer(doc));
  const result = await validateNativePdfDocx(file);
  assert.equal(result.hasEditableContent, true);
  assert.match(result.editableText, /a\+b/);
  assert.match(result.editableText, /c-d/);
});

async function xmlPackage(file, body) {
  await writeDocxZip(file, [
    { path: "[Content_Types].xml", content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { path: "_rels/.rels", content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { path: "word/document.xml", content: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>' + body + '</w:body></w:document>' }
  ]);
}

test("math text outside a visible equation cannot satisfy native editable coverage", async t => {
  const root = await temporary(t);
  for (const [name, body] of [
    ["detached", '<w:p><m:t>fake formula</m:t></w:p>'],
    ["foreign", '<w:p><m:oMath xmlns:m="urn:fake"><m:r><m:t>fake formula</m:t></m:r></m:oMath></w:p>'],
    ["properties", '<w:p><w:pPr><m:oMath><m:r><m:t>fake formula</m:t></m:r></m:oMath></w:pPr></w:p>'],
    ["hidden", '<w:p><m:oMath><m:r><w:rPr><w:vanish/></w:rPr><m:t>hidden formula</m:t></m:r></m:oMath></w:p>']
  ]) {
    const file = path.join(root, name + '.docx');
    await xmlPackage(file, body);
    await assert.rejects(validateNativePdfDocx(file), { code: "PDF_DOCX_NO_EDITABLE_CONTENT" }, name);
  }
});

for (const target of ["docx", "xlsx"]) {
  test(`structured ${target} uses recovered cells and retains both repair and writer warnings`, async t => {
    const root = await temporary(t);
    await require("sharp")({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toFile(path.join(root, "page.png"));
    const manifest = { schemaVersion: 1, engine: { name: "fixture", version: "1" }, pages: [
      { pageNumber: 1, width: 100, height: 100, rotation: 0, referenceImage: "page.png", tableLike: false,
        blocks: [], tables: [], warnings: [] }
    ] };
    const cells = [["Item", "Value"], ["A", "0012.00"]].flatMap((row, r) => row.map((text, c) => ({
      row: r, column: c, rowSpan: 1, columnSpan: 1, bbox: [c*50, r*25, (c+1)*50, (r+1)*25], text, confidence: .99
    })));
    let recovered = false, written = false;
    const result = await convertStructuredPdf({ inputPath: "unused.pdf", outputPath: path.join(root, "output." + target), target, options: {
      pdfTextPages: [], withStructuredPdf: async (_input, _options, operation) => operation(manifest, root),
      repairScanColumnLayout: async (value, assetRoot) => {
        assert.equal(assetRoot, root); recovered = true;
        const copy = structuredClone(value);
        copy.pages[0].tableLike = true;
        copy.pages[0].tables = [{ id: "recovered", bbox: [0,0,100,50], rowCount: 2, columnCount: 2, cells, confidence: .99 }];
        return { manifest: copy, warnings: [{ code: "PDF_SCAN_COLUMNS_RECOVERED" }] };
      },
      [target === "docx" ? "writePdfOfficeDocx" : "writePdfOfficeXlsx"]: async ({ manifest: value, outputPath }) => {
        assert.ok(recovered); written = true;
        assert.deepEqual(value.pages[0].tables[0].cells.map(cell => cell.text), ["Item", "Value", "A", "0012.00"]);
        await fs.writeFile(outputPath, "writer test output");
        return { warnings: [{ code: "WRITER_REVIEW" }] };
      }
    } });
    assert.ok(written);
    assert.deepEqual(result.warnings.map(item => item.code), ["PDF_SCAN_COLUMNS_RECOVERED", "WRITER_REVIEW"]);
  });
}

test("engine-absent DOCX fallback preserves a native fraction or explicitly rejects it before publication", async t => {
  const root = await temporary(t);
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdf = await PDFDocument.create(), page = pdf.addPage([600,800]), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [text,x,y] of [['Before the equation.',40,720],['After the equation.',40,420],['x =',115,495],['a + b',160,507],['c - d',160,480]]) {
    page.drawText(text,{x,y,font,size:12});
  }
  page.drawLine({start:{x:150,y:500},end:{x:210,y:500},thickness:1});
  const input = path.join(root,'fraction.pdf'), output = path.join(root,'fraction.docx');
  await fs.writeFile(input,await pdf.save());
  let result;
  try { result = await convertPdfToDocx(input,output,null,{docenginePath:null}); }
  catch (error) {
    assert.equal(error.code, 'PDF_NATIVE_MATH_UNVERIFIED');
    await assert.rejects(fs.stat(output), {code:'ENOENT'});
    return;
  }
  assert.ok(result.warnings.some(w => w.code === 'PDF_NATIVE_FRACTIONS_RESTORED'));
  const validation = await validateNativePdfDocx(output);
  assert.match(validation.editableText, /a \+ b/);
  assert.match(validation.editableText, /c - d/);
});
