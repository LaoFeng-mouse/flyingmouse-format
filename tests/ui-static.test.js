const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const publicRoot = path.join(__dirname, "..", "public");

function readPublic(fileName) {
  return fs.readFileSync(path.join(publicRoot, fileName), "utf8");
}

test("renderer exposes workflow hooks and drop zone copy", () => {
  const html = readPublic("index.html");

  assert.match(html, /id="workflowSteps"/, "workflow steps container is missing");
  assert.match(html, /data-step="select"/, "select workflow step is missing");
  assert.match(html, /data-step="analyze"/, "analyze workflow step is missing");
  assert.match(html, /data-step="convert"/, "convert workflow step is missing");
  assert.match(html, /data-step="save"/, "save workflow step is missing");
  assert.match(html, /id="dropZone"/, "drop zone is missing");
  assert.match(html, /把文件拖到这里，或点击选择/, "drop zone main copy is missing");
  assert.match(html, /id="dropHint"/, "drop hint is missing");
});

test("renderer has no mouse mascot or donation widget", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");

  assert.doesNotMatch(html, /mouse-mascot|mouseMascot|sponsor|打赏|小鱼干/, "mouse mascot or donation widget must be removed from index.html");
  assert.doesNotMatch(app, /setMouseState|mouseAssets|mouseMascot|sponsor|打赏/, "mouse mascot or donation logic must be removed from app.js");
  assert.doesNotMatch(html, /鼠鼠/, "mouse branding copy must be removed from index.html");
  assert.doesNotMatch(app, /鼠鼠/, "mouse branding copy must be removed from app.js");
});

test("renderer uses a neutral brand mark and favicon", () => {
  const html = readPublic("index.html");

  assert.match(html, /class="brand-mark"/, "brand mark is missing");
  assert.match(html, /rel="icon"/, "favicon link is missing");
  assert.match(html, /href="\/assets\/app-icon\.svg"/, "app favicon is missing");
});

test("fresh visual theme classes are present", () => {
  const css = readPublic("styles.css");

  assert.match(css, /--accent:\s*#ff7a45/, "orange accent is missing");
  assert.match(css, /\.workflow-steps/, "workflow styles are missing");
  assert.match(css, /\.drop-icon/, "drop icon styles are missing");
  assert.match(css, /\.brand-mark/, "brand mark styles are missing");
  assert.match(css, /border-radius:\s*var\(--radius\)/, "soft rounded theme is missing");
});

test("renderer does not inject dynamic HTML", () => {
  const app = readPublic("app.js");
  assert.doesNotMatch(app, /\.innerHTML\s*=/, "renderer must build dynamic content with DOM APIs");
  assert.match(app, /\.textContent\s*=/, "renderer should render untrusted text with textContent");
});

test("renderer restores and updates target preferences by source extension", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  assert.match(html, /conversion-preferences\.js/);
  assert.match(app, /preferredTarget\(localStorage/);
  assert.match(app, /rememberTarget\(localStorage/);
});
