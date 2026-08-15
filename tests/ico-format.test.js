const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");

const {
  isIcoBuffer,
  isIcoFileSync,
  parseIco,
  extractBestFrame,
  extractAllFrames,
  encodeIco
} = require("../ico-format");
const { isBmpFileSync, decodeBmpToRaw } = require("../bmp-input");

function buildIcoDir(count) {
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  return dir;
}

function writeIcoEntry(dir, index, size, bytes, offset, bitCount = 32) {
  const base = 6 + index * 16;
  dir[base] = size >= 256 ? 0 : size;
  dir[base + 1] = size >= 256 ? 0 : size;
  dir[base + 2] = 0;
  dir[base + 3] = 0;
  dir.writeUInt16LE(1, base + 4);
  dir.writeUInt16LE(bitCount, base + 6);
  dir.writeUInt32LE(bytes, base + 8);
  dir.writeUInt32LE(offset, base + 12);
}

async function makePng(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    raw[i * 4] = 255;
    raw[i * 4 + 3] = 255;
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test("isIcoBuffer / isIcoFileSync recognize the ICO container magic", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ico-detect-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));

  const dir = buildIcoDir(0);
  assert.equal(isIcoBuffer(dir), true);

  assert.equal(isIcoBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), false);

  const icoPath = path.join(scratch, "empty.ico");
  await fsp.writeFile(icoPath, dir);
  assert.equal(isIcoFileSync(icoPath), true);

  const pngPath = path.join(scratch, "not.ico");
  await fsp.writeFile(pngPath, await makePng(8, 8));
  assert.equal(isIcoFileSync(pngPath), false);
});

test("parseIco reads directory entries and flags PNG frames", async () => {
  const pngA = await makePng(32, 32);
  const pngB = await makePng(16, 16);
  const dir = buildIcoDir(2);
  writeIcoEntry(dir, 0, 32, pngA.length, 6 + 2 * 16);
  writeIcoEntry(dir, 1, 16, pngB.length, 6 + 2 * 16 + pngA.length);
  const ico = Buffer.concat([dir, pngA, pngB]);

  const parsed = parseIco(ico);
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.entries.map((e) => [e.width, e.height, e.png]), [[32, 32, true], [16, 16, true]]);
});

test("extractBestFrame picks the largest PNG frame", async () => {
  const small = await makePng(16, 16);
  const large = await makePng(64, 64);
  const dir = buildIcoDir(2);
  writeIcoEntry(dir, 0, 16, small.length, 6 + 2 * 16);
  writeIcoEntry(dir, 1, 64, large.length, 6 + 2 * 16 + small.length);
  const ico = Buffer.concat([dir, small, large]);

  const frame = extractBestFrame(ico);
  assert.equal(frame.png, true);
  assert.equal(frame.width, 64);
  assert.equal(frame.height, 64);
  assert.equal(frame.data.readUInt32BE(0), 0x89504e47);
});

test("extractBestFrame prefers a PNG frame over a larger BMP frame", async () => {
  const png = await makePng(48, 48);
  // 构造一个 64x64 的 BMP DIB 帧（biHeight 含 AND mask 双倍）
  const dibW = 64, dibH = 64;
  const rowSize = Math.ceil((dibW * 24) / 8 / 4) * 4;
  const dib = Buffer.alloc(40 + rowSize * dibH * 2);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(dibW, 4);
  dib.writeInt32LE(dibH * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16);

  const dir = buildIcoDir(2);
  writeIcoEntry(dir, 0, 48, png.length, 6 + 2 * 16);
  writeIcoEntry(dir, 1, 64, dib.length, 6 + 2 * 16 + png.length, 24);
  const ico = Buffer.concat([dir, png, dib]);

  const frame = extractBestFrame(ico);
  assert.equal(frame.png, true, "PNG frame must be preferred even if smaller");
  assert.equal(frame.width, 48);
});

test("extractBestFrame decodes a BMP DIB frame (no PNG frame present)", async () => {
  const dibW = 16, dibH = 16;
  const rowSize = Math.ceil((dibW * 24) / 8 / 4) * 4;
  const dib = Buffer.alloc(40 + rowSize * dibH * 2);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(dibW, 4);
  dib.writeInt32LE(dibH * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16);
  for (let r = 0; r < dibH; r += 1) {
    for (let c = 0; c < dibW; c += 1) {
      const off = 40 + r * rowSize + c * 3;
      dib[off] = 0;
      dib[off + 1] = 0;
      dib[off + 2] = 255;
    }
  }

  const dir = buildIcoDir(1);
  writeIcoEntry(dir, 0, 16, dib.length, 22, 24);
  const ico = Buffer.concat([dir, dib]);

  const frame = extractBestFrame(ico);
  assert.equal(frame.png, false);
  assert.equal(frame.width, 16);
  assert.equal(frame.height, 16);
  // 已补 BMP 文件头，可被 bmp-input 解码，且高度减半（去掉 AND mask）
  assert.equal(frame.data.toString("latin1", 0, 2), "BM");
  const raw = decodeBmpToRaw(frame.data);
  assert.equal(raw.width, 16);
  assert.equal(raw.height, 16);
  assert.equal(raw.channels, 3);
});

test("encodeIco assembles multi-size PNG frames into a valid ICO container", async () => {
  const frames = [];
  for (const size of [16, 32, 256]) {
    frames.push({ size, data: await makePng(size, size) });
  }
  const ico = encodeIco(frames);

  assert.equal(isIcoBuffer(ico), true);
  const parsed = parseIco(ico);
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.entries.map((e) => e.width), [16, 32, 256]);
  assert.ok(parsed.entries.every((e) => e.png));

  // roundtrip：挑出的最大帧是 256，且是 PNG
  const best = extractBestFrame(ico);
  assert.equal(best.width, 256);
  assert.equal(best.png, true);
});

test("encodeIco encodes 256 as byte 0 (Windows convention)", async () => {
  const ico = encodeIco([{ size: 256, data: await makePng(256, 256) }]);
  assert.equal(ico[6], 0, "256px entry width must be stored as 0");
  assert.equal(ico[7], 0, "256px entry height must be stored as 0");
});

test("extractAllFrames returns every frame sorted by area (multi-size ICO)", async () => {
  const frames = [];
  for (const size of [16, 48, 256]) {
    frames.push({ size, data: await makePng(size, size) });
  }
  const ico = encodeIco(frames);

  const all = extractAllFrames(ico);
  assert.equal(all.length, 3);
  // 按面积降序：256 最大在前
  assert.deepEqual(all.map((f) => f.width), [256, 48, 16]);
  assert.ok(all.every((f) => f.png));
  assert.ok(all.every((f) => Buffer.isBuffer(f.data) && f.data.length > 0));
});

test("extractAllFrames decodes BMP DIB frames too", async () => {
  const dibW = 16, dibH = 16;
  const rowSize = Math.ceil((dibW * 24) / 8 / 4) * 4;
  const dib = Buffer.alloc(40 + rowSize * dibH * 2);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(dibW, 4);
  dib.writeInt32LE(dibH * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16);

  const dir = buildIcoDir(2);
  const png16 = await makePng(16, 16);
  writeIcoEntry(dir, 0, 16, png16.length, 6 + 2 * 16);
  writeIcoEntry(dir, 1, 16, dib.length, 6 + 2 * 16 + png16.length, 24);
  const ico = Buffer.concat([dir, png16, dib]);

  const all = extractAllFrames(ico);
  assert.equal(all.length, 2);
  const bmpFrame = all.find((f) => !f.png);
  assert.ok(bmpFrame, "BMP DIB frame must be included");
  assert.equal(bmpFrame.data.toString("latin1", 0, 2), "BM");
});
