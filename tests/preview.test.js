const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { registerDownload } = require("../utils");
const { downloads } = require("../config");

const root = path.join(__dirname, "..");

test("conversion results expose a registered inline preview without leaking paths", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const utils = fs.readFileSync(path.join(root, "utils.js"), "utf8");
  assert.match(server, /app\.get\("\/previews\/:id"/);
  assert.match(server, /Content-Disposition",\s*`inline/);
  assert.match(server, /X-Content-Type-Options",\s*"nosniff"/);
  assert.match(server, /frame-ancestors 'self'/);
  assert.match(utils, /previewUrl:\s*`\/previews\/\$\{id\}`/);
  assert.doesNotMatch(server, /previewUrl[^\n]*filePath/);
});

test("preview UI supports a responsive drawer and safe renderer kinds", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="previewDrawer"/);
  assert.match(html, /id="previewContent"/);
  assert.match(app, /previewKind === "image"/);
  assert.match(app, /previewKind === "pdf"/);
  assert.match(app, /previewKind === "text"/);
  assert.match(app, /previewKind === "audio"/);
  assert.match(app, /previewKind === "video"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(css, /\.preview-drawer/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.preview-drawer/);
  assert.match(css, /prefers-reduced-motion/);
});

test("download registration assigns preview kinds without exposing a file path", () => {
  const cases = [
    ["picture.png", "image/png", "image"],
    ["document.pdf", "application/pdf", "pdf"],
    ["notes.md", "text/markdown", "text"],
    ["sound.mp3", "audio/mpeg", "audio"],
    ["movie.mp4", "video/mp4", "video"],
    ["archive.zip", "application/zip", "unsupported"]
  ];
  for (const [name, mimeType, expected] of cases) {
    const registered = registerDownload("/tmp/private-output", name, mimeType);
    assert.equal(registered.previewKind, expected);
    assert.doesNotMatch(JSON.stringify(registered), /private-output/);
    const id = registered.downloadUrl.split("/").pop();
    downloads.delete(id);
  }
});
