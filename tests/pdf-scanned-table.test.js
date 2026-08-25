const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const sharp = require("sharp");

const { detectTableGrid, detectHorizontalLines, detectVerticalLines, buildDocxTable } =
  require("../pdf-scanned-table");

// 用 sharp 生成一张带框表格 PNG（黑线白底 240x180，2行x3列）
async function makeGridPng(filePath, { rows = [40, 90, 140], cols = [20, 90, 160, 220] } = {}) {
  const width = 240, height = 180;
  // 白底
  let img = sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .raw().toBuffer();
  const buf = await img;
  const pixel = Buffer.from(buf);
  // 画线（黑色 30px 宽）
  for (const y of rows) for (let x = 0; x < width; x++) {
    for (let d = -2; d <= 2; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < height) { const i = (yy * width + x) * 3; pixel[i] = 0; pixel[i+1] = 0; pixel[i+2] = 0; }
    }
  }
  for (const x of cols) for (let y = 0; y < height; y++) {
    for (let d = -2; d <= 2; d++) {
      const xx = x + d;
      if (xx >= 0 && xx < width) { const i = (y * width + xx) * 3; pixel[i] = 0; pixel[i+1] = 0; pixel[i+2] = 0; }
    }
  }
  await sharp(pixel, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
  return { width, height };
}

// 纯白图（无表格）
async function makeBlankPng(filePath) {
  await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png().toFile(filePath);
}

test("detectTableGrid 检测带框表格网格", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-grid-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "table.png");
  // rows=[40,90,140] 3条横线 → 2行; cols=[20,90,160,220] 4条竖线 → 3列
  await makeGridPng(png);
  const grid = await detectTableGrid(png, { h: { minRun: 20, ratio: 0.3 }, v: { minRun: 20, ratio: 0.3 } });
  assert.ok(grid, "应检测到网格");
  assert.equal(grid.nRows, 2, "2 行（3条横线）");
  assert.equal(grid.nCols, 3, "3 列（4条竖线）");
});

test("detectTableGrid 对纯白图（无表格）返回 null", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-blank-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "blank.png");
  await makeBlankPng(png);
  const grid = await detectTableGrid(png);
  assert.equal(grid, null, "无表格线返回 null，触发回落");
});

test("buildDocxTable 生成有效 docx 且含表格结构", async () => {
  const cellTexts = [
    ["甲", "乙", "丙"],
    ["丁", "戊", "己"]
  ];
  const buf = await buildDocxTable(2, 3, cellTexts, { title: "测试表" });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "是 zip/docx");
  // 读 document.xml 检验含表格（yauzl.fromBuffer 标准读法）
  const yauzl = require("yauzl");
  const xml = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(buf), { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName === "word/document.xml") {
          zip.openReadStream(entry, (e, s) => {
            if (e) return reject(e);
            let txt = "";
            s.on("data", (d) => txt += d.toString("utf8"));
            s.on("end", () => resolve(txt));
          });
        } else zip.readEntry();
      });
      zip.on("error", reject);
    });
  });
  assert.match(xml, /<w:tbl>/, "含表格");
  assert.match(xml, /甲/, "含单元格文字");
  assert.doesNotMatch(xml, /<w:vMerge/, "不应产生跨行合并标记(无错误合并)");
});

test("detectHorizontalLines / detectVerticalLines 分别检出横竖线", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-lines-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "t.png");
  await makeGridPng(png, { rows: [60, 120], cols: [30, 90, 150] });
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const h = detectHorizontalLines(data, info.width, info.height, { minRun: 20, ratio: 0.3 });
  const v = detectVerticalLines(data, info.width, info.height, { minRun: 20, ratio: 0.3 });
  assert.ok(h.length >= 2, "横线>=2");
  assert.ok(v.length >= 3, "竖线>=3");
  // 横线应在 y≈60、120 附近；竖线在 x≈30、90、150 附近
  assert.ok(Math.abs(h[0] - 60) <= 5, `首横线近60, got ${h[0]}`);
  assert.ok(Math.abs(v[0] - 30) <= 5, `首竖线近30, got ${v[0]}`);
});

// 中灰线网格（线灰度 180，高于固定阈值 128）——用于验证 Otsu 自适应
async function makeGrayGridPng(filePath, { rows = [40, 90, 140], cols = [20, 90, 160, 220], gray = 180 } = {}) {
  const width = 240, height = 180;
  const buffer = Buffer.alloc(width * height * 3, 255); // 白底
  const setPix = (x, y) => { const i = (y * width + x) * 3; buffer[i] = gray; buffer[i + 1] = gray; buffer[i + 2] = gray; };
  for (const y of rows) for (let x = 0; x < width; x++)
    for (let d = -2; d <= 2; d++) { const yy = y + d; if (yy >= 0 && yy < height) setPix(x, yy); }
  for (const x of cols) for (let y = 0; y < height; y++)
    for (let d = -2; d <= 2; d++) { const xx = x + d; if (xx >= 0 && xx < width) setPix(xx, y); }
  await sharp(buffer, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
}

test("detectTableGrid 用 Otsu 自适应：中灰线(180>固定128)也能检出网格", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-graygrid-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "gray.png");
  await makeGrayGridPng(png);
  const grid = await detectTableGrid(png);
  assert.ok(grid, "Otsu 应检出中灰线网格（固定128会漏检）");
  assert.ok(grid.threshold > 128, `Otsu 阈值应大于固定128（自适应），got ${grid.threshold}`);
  assert.equal(grid.nRows, 2, "2 行（3条横线）");
  assert.equal(grid.nCols, 3, "3 列（4条竖线）");
});
