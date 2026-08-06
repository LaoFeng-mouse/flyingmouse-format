const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const sharp = require("sharp");

const assetRoot = path.join(__dirname, "..", "public", "assets", "mouse-format");
const expectedAssets = [
  "mouse-idle.png",
  "mouse-upload.png",
  "mouse-analyzing.png",
  "mouse-converting.png",
  "mouse-pdf-pages.png",
  "mouse-ocr.png",
  "mouse-batch.png",
  "mouse-success.png",
  "mouse-error.png"
];

test("mouse action assets are generated transparent PNGs", async () => {
  for (const fileName of expectedAssets) {
    const filePath = path.join(assetRoot, fileName);
    assert.ok(fs.existsSync(filePath), `${fileName} is missing`);
    assert.ok(fs.statSync(filePath).size > 12_000, `${fileName} looks like a placeholder`);

    const metadata = await sharp(filePath).metadata();
    assert.strictEqual(metadata.format, "png", `${fileName} must be PNG`);
    assert.strictEqual(metadata.hasAlpha, true, `${fileName} must have transparency`);
    assert.ok(metadata.width >= 480, `${fileName} width is too small`);
    assert.ok(metadata.height >= 360, `${fileName} height is too small`);
  }
});
