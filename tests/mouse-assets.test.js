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

test("renderer no longer references mouse action assets", () => {
  const html = fs.readFileSync(path.join(assetRoot, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(assetRoot, "..", "app.js"), "utf8");

  assert.doesNotMatch(html, /mouse-format/, "index.html must not reference mouse assets");
  assert.doesNotMatch(app, /mouse-format/, "app.js must not reference mouse assets");
});
