const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const assetRoot = path.join(__dirname, "..", "public", "assets");

test("app icon asset exists and is a real SVG", () => {
  const filePath = path.join(assetRoot, "app-icon.svg");
  assert.ok(fs.existsSync(filePath), "app-icon.svg is missing");
  assert.ok(fs.statSync(filePath).size > 200, "app-icon.svg looks like a placeholder");

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /<svg/, "app-icon.svg must be an SVG document");
  assert.match(content, /viewBox/, "app-icon.svg must declare a viewBox");
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
