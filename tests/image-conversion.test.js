const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");

const { convertRasterImage } = require("../image-conversion");

async function removeScratch(scratch) {
  sharp.cache(false);
  await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function createAnimatedGif(filePath) {
  const width = 4;
  const height = 3;
  const pages = 2;
  const raw = Buffer.alloc(width * height * pages * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    raw[pixel * 4] = 255;
    raw[pixel * 4 + 3] = 255;
  }
  for (let pixel = width * height; pixel < width * height * pages; pixel += 1) {
    raw[pixel * 4 + 2] = 255;
    raw[pixel * 4 + 3] = 255;
  }
  await sharp(raw, { raw: { width, height: height * pages, channels: 4, pageHeight: height } })
    .gif({ loop: 0, delay: [120, 240] })
    .toFile(filePath);
}

test("animated GIF to PNG uses the first composited frame instead of a vertical sprite", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-image-static-"));
  t.after(() => removeScratch(scratch));
  const input = path.join(scratch, "animated.gif");
  const output = path.join(scratch, "first-frame.png");
  await createAnimatedGif(input);

  const result = await convertRasterImage(input, output, "png", { maxPixels: 50_000_000 });
  const metadata = await sharp(output).metadata();
  const pixel = await sharp(output).ensureAlpha().raw().toBuffer();
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);
  assert.deepEqual([...pixel.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["ANIMATION_FLATTENED"]);
});

test("animated GIF to WebP preserves frame count and timing", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-image-webp-"));
  t.after(() => removeScratch(scratch));
  const input = path.join(scratch, "animated.gif");
  const output = path.join(scratch, "animated.webp");
  await createAnimatedGif(input);

  const result = await convertRasterImage(input, output, "webp", { maxPixels: 50_000_000 });
  const metadata = await sharp(output, { animated: true }).metadata();
  assert.equal(metadata.pages, 2);
  assert.deepEqual(metadata.delay, [120, 240]);
  assert.deepEqual(result.warnings, []);
});

test("transparent input uses an explicit white JPEG background", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-image-jpeg-"));
  t.after(() => removeScratch(scratch));
  const input = path.join(scratch, "transparent.png");
  const output = path.join(scratch, "opaque.jpg");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(input);

  const result = await convertRasterImage(input, output, "jpg", { maxPixels: 50_000_000 });
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.ok([...data.subarray(0, 3)].every((value) => value >= 250), `expected white, got ${[...data.subarray(0, 3)]}`);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["ALPHA_COMPOSITED_WHITE"]);
});

test("alpha-capable PNG output preserves transparency", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-image-alpha-"));
  t.after(() => removeScratch(scratch));
  const input = path.join(scratch, "transparent.png");
  const output = path.join(scratch, "transparent-output.png");
  await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().toFile(input);
  await convertRasterImage(input, output, "png", { maxPixels: 50_000_000 });
  const pixel = await sharp(output).ensureAlpha().raw().toBuffer();
  assert.equal(pixel[3], 0);
});
