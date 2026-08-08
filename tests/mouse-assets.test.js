const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const sharp = require("sharp");

const assetRoot = path.join(__dirname, "..", "public", "assets");
const visualMaeThresholds = new Map([
  // MAE uses premultiplied RGBA channels in 0..255 units. Calibration:
  // Sharp/libvips 0.35.3/8.18.3: 64px 0.28253, 512px 0;
  // Sharp/libvips 0.32.6/8.14.5: 64px 0.28992, 512px 0.03975.
  [64, 0.35],
  [512, 0.1]
]);

async function normalizeVisualPixels(input, size, inputOptions) {
  return sharp(input, inputOptions)
    .resize(size, size, {
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

async function createCheckerboardPerturbation(iconPath) {
  const decoded = await sharp(iconPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const perturbed = Buffer.from(decoded.data);

  for (let y = 0; y < decoded.info.height; y += 1) {
    for (let x = 0; x < decoded.info.width; x += 1) {
      const index = (y * decoded.info.width + x) * 4;
      if (perturbed[index + 3] < 128) continue;
      const delta = (x + y) % 2 === 0 ? -20 : 20;
      for (let channel = 0; channel < 3; channel += 1) {
        perturbed[index + channel] = Math.max(0, Math.min(255, perturbed[index + channel] + delta));
      }
    }
  }

  return {
    input: perturbed,
    options: {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: 4
      }
    }
  };
}

test("app icon asset exists and is a real SVG", () => {
  const filePath = path.join(assetRoot, "app-icon.svg");
  assert.ok(fs.existsSync(filePath), "app-icon.svg is missing");
  assert.ok(fs.statSync(filePath).size > 200, "app-icon.svg looks like a placeholder");

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /<svg/, "app-icon.svg must be an SVG document");
  assert.match(content, /viewBox/, "app-icon.svg must declare a viewBox");
});

test("packaging icon uses encoder-independent multiscale visual metrics for the original mouse identity", async () => {
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
  assert.strictEqual(iconMetadata.format, "png", "build/icon.png must decode as PNG, not a renamed image format");
  assert.strictEqual(iconMetadata.width, 512, "build/icon.png must be 512px wide");
  assert.strictEqual(iconMetadata.height, 512, "build/icon.png must be 512px high");
  assert.strictEqual(iconMetadata.channels, 4, "build/icon.png must decode as RGBA");

  const checkerboardControl = await createCheckerboardPerturbation(iconPath);
  const solidOrangeControl = {
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 255, g: 128, b: 0, alpha: 1 }
    }
  };
  const metrics = new Map();

  for (const [size, threshold] of visualMaeThresholds) {
    const [expected, actual, checkerboard, solidOrange] = await Promise.all([
      normalizeVisualPixels(mousePath, size),
      normalizeVisualPixels(iconPath, size),
      normalizeVisualPixels(checkerboardControl.input, size, checkerboardControl.options),
      normalizeVisualPixels(solidOrangeControl, size)
    ]);

    for (const [label, normalized] of [["original mouse identity", expected], ["build/icon.png", actual]]) {
      assert.strictEqual(normalized.info.width, size, `${label} normalized visual pixels must be ${size}px wide`);
      assert.strictEqual(normalized.info.height, size, `${label} normalized visual pixels must be ${size}px high`);
      assert.strictEqual(normalized.info.channels, 4, `${label} normalized visual pixels must be RGBA`);
    }

    assert.ok(
      countNonTransparentPixels(actual.data) > 0,
      `build/icon.png must contain non-transparent mouse identity pixels at ${size}px`
    );
    assert.ok(
      countNonTransparentPixels(checkerboard.data) > 0,
      `checkerboard negative control must remain non-transparent at ${size}px`
    );
    assert.ok(
      countNonTransparentPixels(solidOrange.data) > 0,
      `solid-orange negative control must remain non-transparent at ${size}px`
    );
    metrics.set(size, {
      actual: calculateVisualMae(actual.data, expected.data),
      checkerboard: calculateVisualMae(checkerboard.data, expected.data),
      solidOrange: calculateVisualMae(solidOrange.data, expected.data),
      threshold
    });
  }

  const overview = metrics.get(64);
  const fullResolution = metrics.get(512);
  assert.ok(
    overview.actual <= overview.threshold,
    `build/icon.png must pass the 64px encoder-independent visual gate (MAE ${overview.actual} > ${overview.threshold})`
  );
  assert.ok(
    fullResolution.actual <= fullResolution.threshold,
    `build/icon.png must pass the 512px encoder-independent detail gate (MAE ${fullResolution.actual} > ${fullResolution.threshold})`
  );
  assert.ok(
    overview.checkerboard <= overview.threshold,
    `checkerboard calibration must demonstrate that 64px downsampling can hide high-frequency damage (MAE ${overview.checkerboard})`
  );
  assert.ok(
    fullResolution.checkerboard > fullResolution.threshold,
    `512px detail gate must reject the opaque-region +/-20 checkerboard control (MAE ${fullResolution.checkerboard})`
  );
  assert.ok(
    overview.solidOrange > overview.threshold,
    `64px visual gate must reject the solid-orange non-transparent icon control (MAE ${overview.solidOrange})`
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
