const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const assetRoot = path.join(root, "public", "assets");
const themeRoot = path.join(assetRoot, "mahiro-format");

async function normalizedPixels(input, size) {
  return sharp(input)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: "lanczos3"
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function calculateMae(actual, expected) {
  assert.strictEqual(actual.length, expected.length);
  let error = 0;
  for (let index = 0; index < actual.length; index += 1) {
    error += Math.abs(actual[index] - expected[index]);
  }
  return error / actual.length;
}

test("Mahiro app icon assets are present and branded", () => {
  const svgPath = path.join(assetRoot, "app-icon.svg");
  const noticePath = path.join(themeRoot, "ASSET-NOTICE.md");
  assert.ok(fs.statSync(svgPath).size > 200, "app-icon.svg looks like a placeholder");
  assert.ok(fs.statSync(noticePath).size > 200, "Mahiro artwork notice is missing");

  const svg = fs.readFileSync(svgPath, "utf8");
  const notice = fs.readFileSync(noticePath, "utf8");
  assert.match(svg, /<svg/);
  assert.match(svg, /viewBox/);
  assert.match(svg, /Mahiro Format pastel avatar icon/);
  assert.match(notice, /AI-generated fan artwork/);
  assert.match(notice, /not official/i);
});

test("packaging icon matches the Mahiro avatar at multiple scales", async () => {
  const avatarPath = path.join(themeRoot, "mahiro-avatar.png");
  const iconPath = path.join(root, "build", "icon.png");
  const [avatarMetadata, iconMetadata] = await Promise.all([
    sharp(avatarPath).metadata(),
    sharp(iconPath).metadata()
  ]);

  assert.strictEqual(avatarMetadata.width, 512);
  assert.strictEqual(avatarMetadata.height, 512);
  assert.strictEqual(iconMetadata.format, "png");
  assert.strictEqual(iconMetadata.width, 512);
  assert.strictEqual(iconMetadata.height, 512);
  assert.strictEqual(iconMetadata.channels, 4);

  for (const size of [64, 512]) {
    const [avatar, icon] = await Promise.all([
      normalizedPixels(avatarPath, size),
      normalizedPixels(iconPath, size)
    ]);
    assert.strictEqual(calculateMae(icon.data, avatar.data), 0, `build/icon.png diverged from Mahiro avatar at ${size}px`);
  }
});

test("renderer exposes all nine Mahiro action states", async () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="mahiroMascot"/);
  assert.match(html, /mahiro-format\/mahiro-upload\.png/);
  assert.match(app, /const mahiroAssets/);
  assert.match(app, /function setMahiroState/);
  assert.doesNotMatch(app, /mouseAssets|setMouseState|mouseMascot/);

  for (const name of ["idle", "upload", "analyzing", "converting", "pdf-pages", "ocr", "batch", "success", "error"]) {
    const filePath = path.join(themeRoot, `mahiro-${name}.png`);
    assert.ok(fs.statSync(filePath).size > 1000, `${name} Mahiro asset looks like a placeholder`);
    const metadata = await sharp(filePath).metadata();
    assert.strictEqual(metadata.format, "png", `${name} Mahiro asset must be PNG`);
    assert.ok(metadata.width >= 300 && metadata.height >= 500, `${name} Mahiro asset is unexpectedly small`);
    assert.strictEqual(metadata.channels, 4, `${name} Mahiro asset must preserve alpha`);
  }
});

test("Microsoft Store logos are regenerated from the Mahiro icon", async () => {
  const expected = new Map([
    ["Square44x44Logo.png", [44, 44]],
    ["Square150x150Logo.png", [150, 150]],
    ["StoreLogo.png", [50, 50]],
    ["Wide310x150Logo.png", [310, 150]]
  ]);

  for (const [fileName, [width, height]] of expected) {
    const metadata = await sharp(path.join(root, "build", "appx", fileName)).metadata();
    assert.strictEqual(metadata.width, width, `${fileName} width mismatch`);
    assert.strictEqual(metadata.height, height, `${fileName} height mismatch`);
    assert.strictEqual(metadata.channels, 4, `${fileName} must preserve transparency`);
  }
});
