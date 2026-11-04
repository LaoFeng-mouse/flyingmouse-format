const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
process.env.FLYINGMOUSE_RUNTIME_DIR = path.join(os.tmpdir(), `flyingmouse-ico-tests-${process.pid}`);

const {
  isIcoBuffer,
  isIcoFileSync,
  parseIco,
  selectBestEntry,
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

test("extractBestFrame prefers the larger frame even when it is a BMP DIB (2026-09-04 fix)", async () => {
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

  // 历史缺陷：无条件 PNG 优先 → 混合 ICO（小 PNG + 大 BMP）只取 16/48px 小帧，
  // 转出结果必然模糊。修复后按面积优先：64x64 BMP DIB 帧胜出。
  const frame = extractBestFrame(ico);
  assert.equal(frame.png, false, "larger BMP frame must win over smaller PNG frame");
  assert.equal(frame.width, 64);
});

test("selectBestEntry breaks same-size ties in favor of PNG frames", () => {
  // 同尺寸时 PNG 优先（带 alpha、免 DIB 转换）
  const mk = (png, size, len) => ({ width: size, height: size, png, bytes: len, offset: 0, data: Buffer.alloc(len) });
  const entries = [mk(false, 32, 100), mk(true, 32, 50)];
  const best = selectBestEntry(entries);
  assert.equal(best.png, true);
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

function maskedDibIcon({ bits = 24, core = false, alpha = 0 } = {}) {
  const size = 2;
  const headerSize = core ? 12 : 40;
  const paletteSize = bits === 1 ? (core ? 6 : 8) : 0;
  const rowBytes = Math.ceil(size * bits / 32) * 4;
  const dib = Buffer.alloc(headerSize + paletteSize + rowBytes * size + 4 * size);
  dib.writeUInt32LE(headerSize);
  if (core) {
    dib.writeUInt16LE(size, 4); dib.writeUInt16LE(size * 2, 6);
    dib.writeUInt16LE(1, 8); dib.writeUInt16LE(bits, 10);
  } else {
    dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(bits, 14);
  }
  if (bits === 1) dib.fill(255, headerSize + (core ? 3 : 4), headerSize + (core ? 3 : 4) + 3);
  else for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const p = headerSize + paletteSize + row * rowBytes + col * (bits / 8);
    dib[p + 2] = 255;
    if (bits === 32) dib[p + 3] = alpha;
  }
  // DIB rows are bottom-up: only the top-left pixel is masked out.
  dib[headerSize + paletteSize + rowBytes * size + 4] = 0x80;
  const dir = buildIcoDir(1);
  writeIcoEntry(dir, 0, size, dib.length, 22, bits);
  return Buffer.concat([dir, dib]);
}

test("ICO conversion preserves legacy AND-mask transparency including zero-alpha 32-bit icons", async (t) => {
  const { convertImage } = require("../image");
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ico-mask-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  for (const bits of [1, 24, 32]) {
    const input = path.join(scratch, `mask-${bits}.ico`);
    const output = path.join(scratch, `mask-${bits}.png`);
    await fsp.writeFile(input, maskedDibIcon({ bits }));
    await convertImage(input, output, "png");
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    assert.deepEqual([pixels[3], pixels[7], pixels[11], pixels[15]], [0, 255, 255, 255], `${bits}-bit mask`);
  }
});

test("ICO conversion reads three-byte CORE palettes and keeps modern alpha", async (t) => {
  const { convertImage } = require("../image");
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ico-core-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  for (const [name, options, expected] of [
    ["core", { core: true, bits: 1 }, [0, 255, 255, 255]],
    ["alpha", { bits: 32, alpha: 128 }, [128, 128, 128, 128]]
  ]) {
    const input = path.join(scratch, `${name}.ico`), output = path.join(scratch, `${name}.png`);
    await fsp.writeFile(input, maskedDibIcon(options));
    await convertImage(input, output, "png");
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    assert.deepEqual([pixels[3], pixels[7], pixels[11], pixels[15]], expected);
  }
});

test("ICO rejects directory overlap, truncated DIB and mismatched PNG dimensions with a stable error", async () => {
  const valid = encodeIco([{ size: 16, data: await makePng(16, 16) }]);
  const overlap = Buffer.from(valid); overlap.writeUInt32LE(6, 18);
  const mismatch = Buffer.from(valid); mismatch[6] = 32;
  const tiny = buildIcoDir(1); writeIcoEntry(tiny, 0, 16, 1, 22);
  for (const bad of [overlap, mismatch, Buffer.concat([tiny, Buffer.from([40])])]) {
    assert.throws(() => extractBestFrame(bad), { code: "ICO_UNSUPPORTED_VARIANT" });
  }
});

test("ICO output uses RGBA PNG frames and pads tiny sources without enlarging them", async (t) => {
  const { convertImage } = require("../image");
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ico-output-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const input = path.join(scratch, "tiny.png"), output = path.join(scratch, "tiny.ico");
  await sharp({ create: { width: 4, height: 2, channels: 3, background: "red" } }).png().toFile(input);
  await convertImage(input, output, "ico");
  for (const frame of parseIco(await fsp.readFile(output)).entries) {
    assert.equal(frame.data[25], 6, "PNG color type must be RGBA");
    const raw = await sharp(frame.data).ensureAlpha().raw().toBuffer();
    let visible = 0;
    for (let i = 3; i < raw.length; i += 4) if (raw[i]) visible++;
    assert.equal(visible, 8, "tiny source must not be enlarged");
  }
});

test("ICO HTTP roundtrip exposes targets, preserves Unicode names, previews and merges icons into PDF", async (t) => {
  const { startServer, purgeRuntimeDirs } = require("../server");
  const { downloads } = require("../config");
  const { server, url } = await startServer(0);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    downloads.clear();
    await purgeRuntimeDirs();
  });
  const original = await makePng(256, 256);
  for (const extension of ["png", "jpg", "webp", "bmp", "svg", "gif", "ico"]) {
    const response = await fetch(`${url}/api/targets`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extension })
    });
    const body = await response.json();
    assert.ok(body.targets.includes(extension === "ico" ? "png" : "ico"));
  }
  async function convert(data, name, target) {
    const form = new FormData();
    form.append("file", new Blob([data]), name);
    form.append("targetFormat", target);
    const response = await fetch(`${url}/api/convert`, { method: "POST", body: form });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const result = await fetch(`${url}${body.downloadUrl}`);
    return { body, data: Buffer.from(await result.arrayBuffer()) };
  }
  const icon = await convert(original, "鼠鼠头像.png", "ico");
  assert.equal(icon.body.fileName, "鼠鼠头像.ico");
  assert.equal(icon.body.previewKind, "image");
  assert.deepEqual(parseIco(icon.data).entries.map(frame => frame.width), [16, 24, 32, 48, 64, 128, 256]);
  const preview = await fetch(`${url}${icon.body.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), icon.data);
  const restored = await convert(icon.data, "鼠鼠头像.ico", "png");
  assert.equal(restored.body.fileName, "鼠鼠头像.png");
  assert.equal((await sharp(restored.data).metadata()).width, 256);
  const { PDFDocument } = require("pdf-lib");
  const form = new FormData();
  form.append("files", new Blob([icon.data]), "图标.ico");
  form.append("files", new Blob([original]), "图片.png");
  const response = await fetch(`${url}/api/convert-images-to-pdf`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const pdf = await fetch(`${url}${body.downloadUrl}`);
  assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount(), 2);
});
