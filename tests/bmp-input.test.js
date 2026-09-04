const assert = require("node:assert/strict");
const { test } = require("node:test");

const { isBmpBuffer, decodeBmpToRaw } = require("../bmp-input");

// 构造未压缩 BMP：fileHeader(14) + BITMAPINFOHEADER(40) + 可选调色板 + 像素。
function makeBmp({ width, height, bitCount = 24, palette = [], pixels, topDown = false }) {
  const paletteBytes = palette.length * 4;
  const rowBytes = Math.ceil((width * bitCount) / 8 / 4) * 4;
  const pixelBytes = rowBytes * Math.abs(height);
  const offset = 14 + 40 + paletteBytes;
  const out = Buffer.alloc(offset + pixelBytes);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(offset, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(topDown ? -Math.abs(height) : Math.abs(height), 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bitCount, 28);
  out.writeUInt32LE(pixelBytes, 34);
  // 调色板位于 DIB header 之后（14+40 处），每项 4 字节 BGR(A)
  const paletteStart = 14 + 40;
  for (let index = 0; index < palette.length; index += 1) {
    const [r, g, b] = palette[index];
    out[paletteStart + index * 4] = b;
    out[paletteStart + index * 4 + 1] = g;
    out[paletteStart + index * 4 + 2] = r;
    out[paletteStart + index * 4 + 3] = 0;
  }
  Buffer.from(pixels).copy(out, offset);
  return out;
}

function pixelAt(data, width, x, y) {
  const start = (y * width + x) * 3;
  return [data[start], data[start + 1], data[start + 2]];
}

test("BMP magic detection distinguishes BMP from other files", () => {
  assert.equal(isBmpBuffer(Buffer.from("BM\x00\x00")), true);
  assert.equal(isBmpBuffer(Buffer.from("GIF89a")), false);
  assert.equal(isBmpBuffer(Buffer.from("")), false);
  assert.equal(isBmpBuffer(Buffer.from("BM")), true);
});

test("24-bit BMP decodes bottom-up rows with BGR to RGB conversion", () => {
  // 2x2, rowBytes = 8: bottom row first in file (red, green), top row (blue, white)
  const rowBytes = 8;
  const pixels = Buffer.alloc(rowBytes * 2);
  // bottom row: red, green (BGR: 00 00 FF | 00 FF 00) + 2 pad
  Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]).copy(pixels, 0);
  // top row: blue, white (BGR: FF 00 00 | FF FF FF) + 2 pad
  Buffer.from([255, 0, 0, 255, 255, 255, 0, 0]).copy(pixels, rowBytes);
  const bmp = makeBmp({ width: 2, height: 2, bitCount: 24, pixels });

  const raw = decodeBmpToRaw(bmp);
  assert.equal(raw.width, 2);
  assert.equal(raw.height, 2);
  assert.equal(raw.channels, 3);
  assert.equal(raw.data.length, 2 * 2 * 3);
  // 文件底部行 -> 图像底部（y=1），文件顶部行 -> 图像顶部（y=0）
  // 文件顶部行字节 [255,0,0] 为 BGR -> RGB 蓝
  assert.deepEqual(pixelAt(raw.data, 2, 0, 0), [0, 0, 255]); // blue
  assert.deepEqual(pixelAt(raw.data, 2, 1, 0), [255, 255, 255]); // white
  assert.deepEqual(pixelAt(raw.data, 2, 0, 1), [255, 0, 0]); // red
  assert.deepEqual(pixelAt(raw.data, 2, 1, 1), [0, 255, 0]); // green
});

test("24-bit BMP with odd width pads rows to 4 bytes", () => {
  // width=3 -> rowBytes=12
  const rowBytes = 12;
  const pixels = Buffer.alloc(rowBytes);
  Buffer.from([0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0]).copy(pixels); // BGR,BGR,BGR,pad
  const bmp = makeBmp({ width: 3, height: 1, bitCount: 24, pixels });

  const raw = decodeBmpToRaw(bmp);
  assert.equal(raw.width, 3);
  assert.equal(raw.data.length, 9);
  assert.deepEqual(pixelAt(raw.data, 3, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixelAt(raw.data, 3, 1, 0), [0, 255, 0]);
  assert.deepEqual(pixelAt(raw.data, 3, 2, 0), [0, 0, 255]);
});

test("negative height BMP is top-down and keeps row order", () => {
  const rowBytes = 8;
  const pixels = Buffer.alloc(rowBytes * 2);
  Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]).copy(pixels, 0);
  Buffer.from([255, 0, 0, 255, 255, 255, 0, 0]).copy(pixels, rowBytes);
  const bmp = makeBmp({ width: 2, height: 2, bitCount: 24, pixels, topDown: true });

  const raw = decodeBmpToRaw(bmp);
  assert.deepEqual(pixelAt(raw.data, 2, 0, 0), [255, 0, 0]); // 文件第一行即顶部
  assert.deepEqual(pixelAt(raw.data, 2, 1, 0), [0, 255, 0]);
});

test("32-bit BMP with non-zero alpha decodes as RGBA (4 channels)", () => {
  const rowBytes = 8; // 2 pixels x 4 bytes
  const pixels = Buffer.alloc(rowBytes * 2);
  Buffer.from([0, 0, 255, 128, 0, 255, 0, 255]).copy(pixels, 0);
  Buffer.from([255, 0, 0, 255, 255, 255, 255, 64]).copy(pixels, rowBytes);
  const bmp = makeBmp({ width: 2, height: 2, bitCount: 32, pixels });

  const raw = decodeBmpToRaw(bmp);
  assert.equal(raw.channels, 4, "non-zero alpha must switch to 4 channels");
  const px = (x, y) => {
    const start = (y * 2 + x) * 4;
    return [raw.data[start], raw.data[start + 1], raw.data[start + 2], raw.data[start + 3]];
  };
  // 文件底行在前（bottom-up）：底行 = 红(a=128)/绿(a=255)，顶行 = 蓝(a=255)/白(a=64)
  assert.deepEqual(px(0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(1, 0), [255, 255, 255, 64]);
  assert.deepEqual(px(0, 1), [255, 0, 0, 128]);
  assert.deepEqual(px(1, 1), [0, 255, 0, 255]);
});

test("32-bit BMP with all-zero alpha stays RGB (legacy files unaffected)", () => {
  const rowBytes = 8; // 2 pixels x 4 bytes
  const pixels = Buffer.alloc(rowBytes * 2);
  Buffer.from([0, 0, 255, 0, 0, 255, 0, 0]).copy(pixels, 0);
  Buffer.from([255, 0, 0, 0, 255, 255, 255, 0]).copy(pixels, rowBytes);
  const bmp = makeBmp({ width: 2, height: 2, bitCount: 32, pixels });

  const raw = decodeBmpToRaw(bmp);
  assert.equal(raw.channels, 3, "all-zero alpha must stay 3 channels");
  assert.deepEqual(pixelAt(raw.data, 2, 0, 1), [255, 0, 0]);
  assert.deepEqual(pixelAt(raw.data, 2, 1, 1), [0, 255, 0]);
  assert.deepEqual(pixelAt(raw.data, 2, 0, 0), [0, 0, 255]);
  assert.deepEqual(pixelAt(raw.data, 2, 1, 0), [255, 255, 255]);
});

test("8-bit palette BMP resolves palette indices", () => {
  const rowBytes = 4; // width=3, 3 bytes + 1 pad
  const pixels = Buffer.from([0, 1, 2, 0]);
  const palette = [
    [255, 0, 0], // index 0 -> red
    [0, 255, 0], // index 1 -> green
    [0, 0, 255]  // index 2 -> blue
  ];
  const bmp = makeBmp({ width: 3, height: 1, bitCount: 8, palette, pixels });

  const raw = decodeBmpToRaw(bmp);
  assert.deepEqual(pixelAt(raw.data, 3, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixelAt(raw.data, 3, 1, 0), [0, 255, 0]);
  assert.deepEqual(pixelAt(raw.data, 3, 2, 0), [0, 0, 255]);
});

test("RLE-compressed BMP is rejected with a stable code instead of garbage output", () => {
  const bmp = makeBmp({ width: 2, height: 2, bitCount: 24, pixels: Buffer.alloc(16) });
  bmp.writeUInt32LE(1, 30); // BI_RLE8
  assert.throws(
    () => decodeBmpToRaw(bmp),
    (error) => error.code === "BMP_UNSUPPORTED_VARIANT" && /压缩/.test(error.message)
  );
});

test("truncated and invalid BMP buffers are rejected", () => {
  assert.throws(() => decodeBmpToRaw(Buffer.from("BM\x00\x00\x00")), /文件头不完整/);
  assert.throws(() => decodeBmpToRaw(Buffer.from("GIF89a")), /不是有效的 BMP/);
});
