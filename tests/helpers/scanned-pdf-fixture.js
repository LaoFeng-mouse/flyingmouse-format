const fsp = require("fs/promises");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");

const PAGE_WIDTH = 1653;
const PAGE_HEIGHT = 2339;
const TABLE_HEIGHT = Math.round(PAGE_HEIGHT * 0.32);

async function createScannedTablePdf(outputPath) {
  const tableLeft = 120;
  const tableRight = PAGE_WIDTH - 120;
  const tableTop = 690;
  const tableBottom = tableTop + TABLE_HEIGHT;
  const columnWidth = (tableRight - tableLeft) / 4;
  const rowHeight = TABLE_HEIGHT / 4;

  const verticalRules = Array.from({ length: 5 }, (_, index) => {
    const x = Math.round(tableLeft + index * columnWidth);
    return `<line x1="${x}" y1="${tableTop}" x2="${x}" y2="${tableBottom}"/>`;
  }).join("");
  const horizontalRules = Array.from({ length: 5 }, (_, index) => {
    const y = Math.round(tableTop + index * rowHeight);
    return `<line x1="${tableLeft}" y1="${y}" x2="${tableRight}" y2="${y}"/>`;
  }).join("");

  const svg = `<svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <g stroke="black" stroke-width="5">${verticalRules}${horizontalRules}</g>
    <g font-family="Arial, sans-serif" fill="black">
      <text x="${PAGE_WIDTH / 2}" y="520" font-size="68" text-anchor="middle">ANONYMOUS CONFIRMATION</text>
      <text x="170" y="${tableTop + rowHeight * 1.65}" font-size="48">A-001</text>
      <text x="${tableLeft + columnWidth + 45}" y="${tableTop + rowHeight * 1.65}" font-size="48">2026-08</text>
      <text x="${tableLeft + columnWidth * 2 + 45}" y="${tableTop + rowHeight * 1.65}" font-size="48">0.00</text>
      <text x="${tableLeft + columnWidth * 3 + 35}" y="${tableTop + rowHeight * 1.65}" font-size="44">Confirmed</text>
    </g>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  const document = await PDFDocument.create();
  const page = document.addPage([595.28, 841.89]);
  const image = await document.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  await fsp.writeFile(outputPath, await document.save());
  return outputPath;
}

module.exports = { createScannedTablePdf };
