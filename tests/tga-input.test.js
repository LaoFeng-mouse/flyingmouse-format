const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");

const { isTgaFileSync } = require("../image");
const { FFMPEG_PATH } = require("../config");

function makeTga(width, height) {
  const header = Buffer.alloc(18);
  header.writeUInt8(0, 0); // id length
  header.writeUInt8(0, 1); // color map type = none
  header.writeUInt8(2, 2); // image type = uncompressed truecolor
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header.writeUInt8(24, 16); // 24-bit
  header.writeUInt8(0, 17);  // bottom-left origin, no alpha
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      pixels[i] = 0;
      pixels[i + 1] = Math.round((x / Math.max(1, width - 1)) * 255);
      pixels[i + 2] = 255;
    }
  }
  return Buffer.concat([header, pixels]);
}

const engineAvailable = Boolean(FFMPEG_PATH);

test("isTgaFileSync recognizes .tga and rejects other extensions", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-tga-detect-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const tga = path.join(scratch, "a.tga");
  const png = path.join(scratch, "b.png");
  fs.writeFileSync(tga, makeTga(4, 4));
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.equal(isTgaFileSync(tga), true);
  assert.equal(isTgaFileSync(path.join(scratch, "a.TGA")), true);
  assert.equal(isTgaFileSync(png), false);
  assert.equal(isTgaFileSync(path.join(scratch, "c.ico")), false);
});

test("TGA converts to PNG through the ffmpeg transcode path", { skip: !engineAvailable }, async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-tga-png-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const tgaPath = path.join(scratch, "test.tga");
  const outPng = path.join(scratch, "out.png");
  fs.writeFileSync(tgaPath, makeTga(16, 16));

  const { convertImage } = require("../image");
  const result = await convertImage(tgaPath, outPng, "png");
  assert.deepEqual(result.warnings, []);
  const meta = await sharp(outPng).metadata();
  assert.equal(meta.width, 16);
  assert.equal(meta.height, 16);
  assert.equal(meta.format, "png");
});

test("TGA is classified as image and exposes the full image target set", () => {
  const { categoryForExt, targetsForExt } = require("../utils");
  const { imageInput } = require("../config");
  assert.equal(imageInput.has("tga"), true);
  assert.equal(categoryForExt("tga"), "image");
  const targets = targetsForExt("tga", { ffmpeg: true, libreoffice: true, poppler: true, ocr: true });
  assert.ok(targets.includes("png"));
  assert.ok(targets.includes("jpg"));
  assert.ok(targets.includes("ico"));
});
