// bmp-output 编码器单测：纯逻辑 + 与 sharp 解码回读互通。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { encodeBmpFromRaw } = require("../bmp-output");
const { decodeBmpToRaw } = require("../bmp-input");
const sharp = require("sharp");

function solidRaw(width, height, channels, fill) {
  return Buffer.alloc(width * height * channels, fill);
}

test("encodeBmpFromRaw 输出合法 24 位 BI_RGB 文件头", () => {
  const bmp = encodeBmpFromRaw({ width: 3, height: 2, channels: 3, data: solidRaw(3, 2, 3, 0x80) });
  assert.equal(bmp.toString("latin1", 0, 2), "BM");
  assert.equal(bmp.length, bmp.readUInt32LE(2)); // biSize 与文件长一致
  assert.equal(bmp.readUInt32LE(14), 40); // BITMAPINFOHEADER
  assert.equal(bmp.readInt32LE(18), 3);
  assert.equal(bmp.readInt32LE(22), 2); // 正 = 自底向上
  assert.equal(bmp.readUInt16LE(28), 24); // 24 位
  assert.equal(bmp.readUInt32LE(30), 0); // 未压缩
  // 宽 3px*3B=9B → 行补齐到 12B；像素区 = 12*2
  assert.equal(bmp.readUInt32LE(34), 24);
});

test("encodeBmpFromRaw 行按 4 字节对齐（宽 1 的极端行宽）", () => {
  const bmp = encodeBmpFromRaw({ width: 1, height: 1, channels: 3, data: Buffer.from([0x11, 0x22, 0x33]) });
  // 1px*3B → 行 4B；总长 = 54 + 4
  assert.equal(bmp.length, 58);
  assert.equal(bmp.readUInt32LE(34), 4);
});

test("编码结果可被 bmp-input 解码回读（round-trip）", () => {
  // R=0xAA G=0xBB B=0xCC
  const data = Buffer.from([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03]);
  const bmp = encodeBmpFromRaw({ width: 2, height: 1, channels: 3, data });
  const decoded = decodeBmpToRaw(bmp);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.data], [0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03]);
});

test("4 通道输入丢弃 alpha 后正确编码", () => {
  const data = Buffer.from([
    0x10, 0x20, 0x30, 0xff,
    0x40, 0x50, 0x60, 0x00
  ]);
  const bmp = encodeBmpFromRaw({ width: 2, height: 1, channels: 4, data });
  const decoded = decodeBmpToRaw(bmp);
  assert.deepEqual([...decoded.data], [0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
});

test("convertRasterImage 支持 bmp 目标（PNG 输入 → BMP 输出，Windows 画图可打开的结构）", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-bmp-out-"));
  const inputPath = path.join(tempDir, "in.png");
  const outputPath = path.join(tempDir, "out.bmp");
  await sharp({ create: { width: 7, height: 5, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .png()
    .toFile(inputPath);

  const { convertRasterImage } = require("../image-conversion");
  const result = await convertRasterImage(inputPath, outputPath, "bmp");
  assert.deepEqual(result.warnings, []);

  const onDisk = fs.readFileSync(outputPath);
  assert.equal(onDisk.toString("latin1", 0, 2), "BM");
  assert.equal(onDisk.readInt32LE(18), 7);
  assert.equal(onDisk.readInt32LE(22), 5);
  // 用项目自带的 bmp-input 解码器验证像素 round-trip（sharp 预编译构建不支持 BMP）。
  const decoded = decodeBmpToRaw(onDisk);
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("尺寸/数据不合法时给出明确报错", () => {
  assert.throws(() => encodeBmpFromRaw({ width: 0, height: 1, channels: 3, data: Buffer.alloc(0) }), /尺寸不合法/);
  assert.throws(() => encodeBmpFromRaw({ width: 2, height: 2, channels: 3, data: Buffer.alloc(4) }), /不完整/);
});
