const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const publicRoot = path.join(__dirname, "..", "public");

function readPublic(fileName) {
  return fs.readFileSync(path.join(publicRoot, fileName), "utf8");
}

test("renderer exposes mouse mascot and workflow hooks", () => {
  const html = readPublic("index.html");

  assert.match(html, /id="mouseMascot"/, "mouse mascot image is missing");
  assert.match(html, /id="workflowSteps"/, "workflow steps container is missing");
  assert.match(html, /data-step="select"/, "select workflow step is missing");
  assert.match(html, /data-step="analyze"/, "analyze workflow step is missing");
  assert.match(html, /data-step="convert"/, "convert workflow step is missing");
  assert.match(html, /data-step="save"/, "save workflow step is missing");
  assert.match(html, /把文件丢给鼠鼠/, "upload copy should use the approved mouse wording");
});

test("renderer maps conversion states to mouse assets", () => {
  const app = readPublic("app.js");

  for (const stateName of ["idle", "upload", "analyzing", "converting", "batch", "success", "error"]) {
    assert.match(app, new RegExp(`${stateName}:\\s*"/assets/mouse-format/mouse-`), `${stateName} asset mapping is missing`);
  }

  assert.match(app, /function setMouseState\(/, "setMouseState function is missing");
  assert.match(app, /function setWorkflowStep\(/, "setWorkflowStep function is missing");
  assert.match(app, /setMouseState\("analyzing"\)/, "analyzing state is not used");
  assert.match(app, /setMouseState\("converting"\)/, "converting state is not used");
  assert.match(app, /setMouseState\("success"\)/, "success state is not used");
  assert.match(app, /setMouseState\("error"\)/, "error state is not used");
});

test("mouse print visual theme classes are present", () => {
  const css = readPublic("styles.css");

  assert.match(css, /--accent:\s*#e95f6d/, "mouse pink accent is missing");
  assert.match(css, /\.workflow-steps/, "workflow styles are missing");
  assert.match(css, /\.mouse-mascot/, "mouse mascot styles are missing");
  assert.match(css, /border:\s*3px solid var\(--ink\)/, "rough black card border style is missing");
});

test("renderer does not inject dynamic HTML", () => {
  const app = readPublic("app.js");
  assert.doesNotMatch(app, /\.innerHTML\s*=/, "renderer must build dynamic content with DOM APIs");
  assert.match(app, /\.textContent\s*=/, "renderer should render untrusted text with textContent");
});

test("renderer declares an existing local favicon", () => {
  const html = readPublic("index.html");
  assert.match(html, /rel="icon"/);
  assert.match(html, /href="\/assets\/mouse-format\/mouse-idle\.png"/);
});
