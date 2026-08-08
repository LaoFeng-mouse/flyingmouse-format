const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const sharp = require("sharp");

const assetRoot = path.join(__dirname, "..", "public", "assets");
const visualIconSize = 64;
const visualMaeThreshold = 0.35;

async function normalizeVisualPixels(input) {
  return sharp(input)
    .resize(visualIconSize, visualIconSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: "lanczos3"
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function calculateVisualMae(actual, expected) {
  assert.strictEqual(actual.length, expected.length, "normalized visual RGBA buffers must have equal lengths");

  let absoluteError = 0;
  for (let index = 0; index < actual.length; index += 4) {
    const actualAlpha = actual[index + 3];
    const expectedAlpha = expected[index + 3];
    for (let channel = 0; channel < 3; channel += 1) {
      const actualPremultiplied = Math.round((actual[index + channel] * actualAlpha) / 255);
      const expectedPremultiplied = Math.round((expected[index + channel] * expectedAlpha) / 255);
      absoluteError += Math.abs(actualPremultiplied - expectedPremultiplied);
    }
    absoluteError += Math.abs(actualAlpha - expectedAlpha);
  }

  return absoluteError / actual.length;
}

function countNonTransparentPixels(rgba) {
  let count = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] > 0) count += 1;
  }
  return count;
}

test("app icon asset exists and is a real SVG", () => {
  const filePath = path.join(assetRoot, "app-icon.svg");
  assert.ok(fs.existsSync(filePath), "app-icon.svg is missing");
  assert.ok(fs.statSync(filePath).size > 200, "app-icon.svg looks like a placeholder");

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /<svg/, "app-icon.svg must be an SVG document");
  assert.match(content, /viewBox/, "app-icon.svg must declare a viewBox");
});

test("packaging icon is visually equivalent to the original mouse identity across Sharp/libvips encoders", async () => {
  const mousePath = path.join(assetRoot, "mouse-format", "mouse-idle.png");
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  assert.ok(fs.existsSync(mousePath), "original mouse identity asset is missing");
  assert.ok(fs.existsSync(iconPath), "build/icon.png for the original mouse identity is missing");

  let mouseMetadata;
  let iconMetadata;
  await assert.doesNotReject(async () => {
    [mouseMetadata, iconMetadata] = await Promise.all([
      sharp(mousePath).metadata(),
      sharp(iconPath).metadata()
    ]);
  }, "original mouse identity and build/icon.png must both be decodable across Sharp/libvips encoders");

  assert.ok(mouseMetadata.width > 0 && mouseMetadata.height > 0, "original mouse identity must decode to visible dimensions");
  assert.strictEqual(iconMetadata.width, 512, "build/icon.png must be 512px wide");
  assert.strictEqual(iconMetadata.height, 512, "build/icon.png must be 512px high");
  assert.strictEqual(iconMetadata.channels, 4, "build/icon.png must decode as RGBA");

  const transparentControl = {
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  };
  const [expected, actual, negative] = await Promise.all([
    normalizeVisualPixels(mousePath),
    normalizeVisualPixels(iconPath),
    normalizeVisualPixels(transparentControl)
  ]);

  for (const [label, normalized] of [["original mouse identity", expected], ["build/icon.png", actual]]) {
    assert.strictEqual(normalized.info.width, visualIconSize, `${label} normalized visual pixels must be 64px wide`);
    assert.strictEqual(normalized.info.height, visualIconSize, `${label} normalized visual pixels must be 64px high`);
    assert.strictEqual(normalized.info.channels, 4, `${label} normalized visual pixels must be RGBA`);
  }

  assert.ok(
    countNonTransparentPixels(actual.data) > 0,
    "build/icon.png must contain non-transparent visual pixels from the original mouse identity"
  );
  const actualMae = calculateVisualMae(actual.data, expected.data);
  const negativeMae = calculateVisualMae(negative.data, expected.data);
  assert.ok(
    actualMae <= visualMaeThreshold,
    `build/icon.png must be visually equivalent across Sharp/libvips encoders (MAE ${actualMae} > ${visualMaeThreshold})`
  );
  assert.ok(
    negativeMae > visualMaeThreshold,
    `transparent negative control must not be visually equivalent to the original mouse identity (MAE ${negativeMae})`
  );
});

test("renderer uses the original mouse action assets", () => {
  const html = fs.readFileSync(path.join(assetRoot, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(assetRoot, "..", "app.js"), "utf8");

  assert.match(html, /id="mouseMascot"/, "mouse mascot is missing");
  assert.match(html, /mouse-format\/mouse-upload\.png/, "upload mouse is missing");
  assert.match(app, /const mouseAssets/, "mouse state assets are missing");
  assert.match(app, /function setMouseState/, "mouse state controller is missing");

  for (const name of ["idle", "upload", "analyzing", "converting", "pdf-pages", "ocr", "batch", "success", "error"]) {
    const filePath = path.join(assetRoot, "mouse-format", `mouse-${name}.png`);
    assert.ok(fs.existsSync(filePath), `${name} mouse asset is missing`);
    assert.ok(fs.statSync(filePath).size > 100, `${name} mouse asset looks like a placeholder`);
  }
});
