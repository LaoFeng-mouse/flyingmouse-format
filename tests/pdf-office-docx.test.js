const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const yazl = require("yazl");
const { openZipEntries } = require("../zip-util");
const {
  writePdfOfficeDocx,
  validatePdfOfficeDocx
} = require("../pdf-office-docx");

async function png(filePath, width, height, color) {
  await sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toFile(filePath);
}

async function readEntries(zipPath) {
  const zipfile = await openZipEntries(zipPath);
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zipfile.on("entry", (entry) => {
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
      });
    });
    zipfile.on("end", () => {
      zipfile.close();
      resolve(entries);
    });
    zipfile.on("error", reject);
    zipfile.readEntry();
  });
}

async function writeZip(zipPath, entries) {
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = fsSync.createWriteStream(zipPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const [name, data] of Object.entries(entries)) archive.addBuffer(Buffer.from(data), name);
    archive.end();
  });
}

function manifest() {
  return {
    schemaVersion: 1,
    engine: { name: "anonymous-fixture", version: "1.0.0" },
    pages: [{
      pageNumber: 1,
      width: 1653,
      height: 2339,
      rotation: 0,
      referenceImage: "page-001.png",
      blocks: [
        { type: "heading", bbox: [100, 100, 1550, 220], text: "Anonymous heading", confidence: 0.99 },
        { type: "paragraph", bbox: [100, 260, 1550, 360], text: "Review this editable paragraph", confidence: 0.72 },
        { type: "table", bbox: [100, 420, 1550, 1150], tableId: "table-001", confidence: 0.96 },
        { type: "seal", bbox: [1250, 1200, 1450, 1400], asset: "seal.png", confidence: 0.94 }
      ],
      tables: [{
        id: "table-001",
        rowCount: 3,
        columnCount: 3,
        bbox: [100, 420, 1550, 1150],
        confidence: 0.96,
        cells: [
          { row: 0, column: 0, rowSpan: 1, columnSpan: 2, bbox: [100, 420, 1066, 660], text: "Merged title", confidence: 0.99 },
          { row: 0, column: 2, rowSpan: 1, columnSpan: 1, bbox: [1066, 420, 1550, 660], text: "Status", confidence: 0.98 },
          { row: 1, column: 0, rowSpan: 2, columnSpan: 1, bbox: [100, 660, 583, 1150], text: "Row span", confidence: 0.97 },
          { row: 1, column: 1, rowSpan: 1, columnSpan: 1, bbox: [583, 660, 1066, 905], text: "A-001", confidence: 0.99 },
          { row: 1, column: 2, rowSpan: 1, columnSpan: 1, bbox: [1066, 660, 1550, 905], text: "Needs review", confidence: 0.63 },
          { row: 2, column: 1, rowSpan: 1, columnSpan: 1, bbox: [583, 905, 1066, 1150], text: "2026-08", confidence: 0.98 },
          { row: 2, column: 2, rowSpan: 1, columnSpan: 1, bbox: [1066, 905, 1550, 1150], text: "Confirmed", confidence: 0.95 }
        ]
      }],
      warnings: [],
      elapsedMs: 1
    }]
  };
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-docx-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await png(path.join(root, "page-001.png"), 827, 1169, "#ffffff");
  await png(path.join(root, "seal.png"), 160, 160, "#cc2233");
  await png(path.join(root, "signature.png"), 240, 80, "#2255aa");
  await png(path.join(root, "figure.png"), 320, 180, "#44aa66");
  return root;
}

function outputInvalid(error, privateValue = "") {
  return error && error.code === "PDF_OFFICE_OUTPUT_INVALID"
    && typeof error.messages?.zhCN === "string"
    && typeof error.messages?.enUS === "string"
    && error.messages.zhCN.length > 0
    && error.messages.enUS.length > 0
    && (!privateValue || !JSON.stringify(error).includes(privateValue));
}

test("writes editable source-order content, merged tables, supported images and page references", async (t) => {
  const root = await workspace(t);
  const input = manifest();
  input.pages[0].blocks.splice(4, 0,
    { type: "signature", bbox: [1080, 1420, 1480, 1560], asset: "signature.png", confidence: 0.93 },
    { type: "figure", bbox: [180, 1580, 900, 1980], asset: "figure.png", confidence: 0.92 }
  );
  const outputPath = path.join(root, "result.docx");
  const result = await writePdfOfficeDocx({ manifest: input, assetRoot: root, outputPath });
  assert.equal(result.referenceImageCount, 1);

  const entries = await readEntries(outputPath);
  const documentXml = entries.get("word/document.xml").toString("utf8");
  const stylesXml = entries.get("word/styles.xml").toString("utf8");
  const relsXml = entries.get("word/_rels/document.xml.rels").toString("utf8");
  const media = [...entries.keys()].filter((name) => name.startsWith("word/media/"));

  assert.match(documentXml, /<w:t[^>]*>Anonymous heading<\/w:t>/);
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /<w:tblW w:type="dxa" w:w="8906"\/>/);
  assert.match(documentXml, /<w:tblInd w:type="dxa" w:w="120"\/>/);
  assert.match(documentXml, /<w:tblLayout w:type="fixed"\/>/);
  const gridWidths = [...documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  assert.equal(gridWidths.reduce((sum, width) => sum + width, 0), 8906);
  assert.ok(120 + gridWidths.reduce((sum, width) => sum + width, 0) <= 9026);
  assert.match(documentXml, /<w:gridSpan w:val="2"\/>/);
  assert.match(documentXml, /<w:vMerge w:val="restart"\/>/);
  assert.match(documentXml, /<w:vMerge w:val="continue"\/>/);
  assert.match(documentXml, /<w:shd[^>]*w:fill="FFF2CC"/);
  assert.match(documentXml, /<w:t[^>]*>原件对照 \/ Original reference<\/w:t>/);
  assert.ok(media.length >= 4, "seal, signature, figure and page reference must all be embedded");
  assert.match(documentXml, /descr="Seal from source page"/);
  assert.match(documentXml, /descr="Signature from source page"/);
  assert.match(documentXml, /descr="Figure from source page"/);
  const imageOrder = ["Seal from source page", "Signature from source page", "Figure from source page"]
    .map((description) => documentXml.indexOf(description));
  assert.deepEqual([...imageOrder].sort((a, b) => a - b), imageOrder, "source images must preserve block reading order");
  assert.match(relsXml, /Target="media\/[^\"]+"/);

  const order = ["Anonymous heading", "Review this editable paragraph", "Merged title", "A-001", "原件对照 / Original reference"]
    .map((text) => documentXml.indexOf(text));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "content must follow source reading order");

  assert.match(documentXml, /<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
  assert.match(documentXml, /<w:pgMar[^>]*w:top="1440"[^>]*w:right="1440"[^>]*w:bottom="1440"[^>]*w:left="1440"/);
  assert.match(stylesXml, /<w:docDefaults>[\s\S]*?<w:rFonts[^>]*w:ascii="Calibri"[\s\S]*?<w:sz w:val="22"/);
  assert.match(stylesXml, /<w:pPrDefault>[\s\S]*?<w:spacing w:after="120" w:line="264" w:lineRule="auto"/);
  assert.match(stylesXml, /w:styleId="Heading1"[\s\S]*?<w:color w:val="2E74B5"/);

  const validation = await validatePdfOfficeDocx(outputPath, {
    expectedReferenceImages: 1,
    expectedTables: [{ rows: 3, columns: 3 }]
  });
  assert.equal(validation.referenceImageCount, 1);
  assert.equal(validation.hasEditableContent, true);
});

test("writes one original-reference image for every source page", async (t) => {
  const root = await workspace(t);
  await png(path.join(root, "page-002.png"), 827, 1169, "#eeeeee");
  const input = manifest();
  input.pages.push({
    pageNumber: 2,
    width: 1653,
    height: 2339,
    rotation: 0,
    referenceImage: "page-002.png",
    blocks: [{ type: "paragraph", bbox: [100, 100, 1500, 220], text: "Second page text", confidence: 0.98 }],
    tables: [], warnings: [], elapsedMs: 1
  });
  const outputPath = path.join(root, "two-pages.docx");
  await writePdfOfficeDocx({ manifest: input, assetRoot: root, outputPath });
  const validation = await validatePdfOfficeDocx(outputPath, { expectedReferenceImages: 2 });
  assert.equal(validation.referenceImageCount, 2);
});

test("fails closed and deletes output when the manifest has images but no editable content", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "must-not-exist.docx");
  const imageOnly = manifest();
  imageOnly.pages[0].blocks = [{ type: "seal", bbox: [100, 100, 300, 300], asset: "seal.png", confidence: 0.99 }];
  imageOnly.pages[0].tables = [];

  await assert.rejects(
    writePdfOfficeDocx({ manifest: imageOnly, assetRoot: root, outputPath }),
    (error) => error && error.code === "PDF_DOCX_NO_EDITABLE_CONTENT" && !JSON.stringify(error).includes(root)
  );
  await assert.rejects(fs.access(outputPath));
  assert.equal((await fs.readdir(root)).some((name) => name.includes(".tmp-")), false);
});

test("fails closed on missing media without leaking paths or leaving output", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "broken.docx");
  const input = manifest();
  input.pages[0].blocks.at(-1).asset = "missing-private-seal.png";
  await assert.rejects(
    writePdfOfficeDocx({ manifest: input, assetRoot: root, outputPath }),
    (error) => outputInvalid(error, root)
  );
  await assert.rejects(fs.access(outputPath));
});

test("maps output write failures to the bilingual redacted Office error", async (t) => {
  const root = await workspace(t);
  const outputPath = path.join(root, "missing-parent", "private-output.docx");
  await assert.rejects(
    writePdfOfficeDocx({ manifest: manifest(), assetRoot: root, outputPath }),
    (error) => outputInvalid(error, "private-output.docx")
  );
  await assert.rejects(fs.access(outputPath));
});

test("validator rejects an image-only reference package even when its media relationship is valid", async (t) => {
  const root = await workspace(t);
  const packagePath = path.join(root, "image-only.docx");
  await writeZip(packagePath, referencePackageXml());
  await assert.rejects(
    validatePdfOfficeDocx(packagePath, { expectedReferenceImages: 1 }),
    (error) => error && error.code === "PDF_DOCX_NO_EDITABLE_CONTENT"
  );
});

test("validator rejects broken or escaping image relationships with a redacted error", async (t) => {
  const root = await workspace(t);
  const packagePath = path.join(root, "broken-relationship.docx");
  await writeZip(packagePath, {
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Editable</w:t></w:r></w:p><a:blip r:embed="rId9"/></w:body></w:document>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../private.png"/></Relationships>`
  });
  await assert.rejects(
    validatePdfOfficeDocx(packagePath),
    (error) => outputInvalid(error, root)
  );
});

test("validator rejects empty or decorative tables as editable content", async (t) => {
  const root = await workspace(t);
  for (const [name, tableXml] of [
    ["empty", "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>"],
    ["decorative", "<w:tbl><w:tr><w:tc><w:p><w:r><w:t> </w:t></w:r></w:p></w:tc></w:tr></w:tbl>"]
  ]) {
    const packagePath = path.join(root, `${name}.docx`);
    await writeZip(packagePath, referencePackageXml({ bodyBeforeReference: tableXml }));
    await assert.rejects(
      validatePdfOfficeDocx(packagePath, { expectedReferenceImages: 1 }),
      (error) => error && error.code === "PDF_DOCX_NO_EDITABLE_CONTENT"
    );
  }
});

test("validator requires manifest table dimensions and populated editable cells", async (t) => {
  const root = await workspace(t);
  const packagePath = path.join(root, "table-dimensions.docx");
  const table = `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>A-001</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr><w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>Confirmed</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  await writeZip(packagePath, referencePackageXml({ bodyBeforeReference: table }));
  await assert.rejects(
    validatePdfOfficeDocx(packagePath, { expectedReferenceImages: 1, expectedTables: [{ rows: 3, columns: 2 }] }),
    (error) => outputInvalid(error)
  );
  const result = await validatePdfOfficeDocx(packagePath, {
    expectedReferenceImages: 1,
    expectedTables: [{ rows: 2, columns: 2 }]
  });
  assert.equal(result.hasEditableContent, true);
});

function referencePackageXml({
  bodyBeforeReference = "",
  heading = "原件对照 / Original reference",
  markers = [{ number: 1, relationshipId: "rId1" }],
  extraDocumentXml = ""
} = {}) {
  const drawings = markers.map(({ number, relationshipId }) => `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="${number}" name="Original reference page ${number}" descr="Original reference page ${number}"/><a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`).join("");
  const relationships = [...new Set(markers.map((marker) => marker.relationshipId))]
    .map((id, index) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page-${index + 1}.png"/>`).join("");
  const media = Object.fromEntries([...new Set(markers.map((marker) => marker.relationshipId))]
    .map((id, index) => [`word/media/page-${index + 1}.png`, Buffer.from("png")]));
  return {
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyBeforeReference}<w:p><w:r><w:t>${heading}</w:t></w:r></w:p>${drawings}${extraDocumentXml}</w:body></w:document>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships>${relationships}</Relationships>`,
    ...media
  };
}

test("validator requires the exact reference heading", async (t) => {
  const root = await workspace(t);
  const packagePath = path.join(root, "missing-heading.docx");
  await writeZip(packagePath, referencePackageXml({ bodyBeforeReference: "<w:p><w:r><w:t>Editable body</w:t></w:r></w:p>", heading: "Original reference" }));
  await assert.rejects(validatePdfOfficeDocx(packagePath, { expectedReferenceImages: 1 }), outputInvalid);
});

test("validator rejects spoofed, duplicate or gapped reference markers", async (t) => {
  const root = await workspace(t);
  const cases = [
    ["spoofed", [], `<w:p descr="Original reference page 1"><w:r><w:t>fake</w:t></w:r></w:p>`],
    ["duplicate", [{ number: 1, relationshipId: "rId1" }, { number: 1, relationshipId: "rId2" }], ""],
    ["gap", [{ number: 1, relationshipId: "rId1" }, { number: 3, relationshipId: "rId3" }], ""]
  ];
  for (const [name, markers, extraDocumentXml] of cases) {
    const packagePath = path.join(root, `${name}-reference.docx`);
    await writeZip(packagePath, referencePackageXml({
      bodyBeforeReference: "<w:p><w:r><w:t>Editable body</w:t></w:r></w:p>",
      markers,
      extraDocumentXml
    }));
    await assert.rejects(validatePdfOfficeDocx(packagePath, { expectedReferenceImages: name === "spoofed" ? 1 : 2 }), outputInvalid);
  }
});
