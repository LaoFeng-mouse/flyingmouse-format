# Mouse Style UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `飞鼠格式` into a `鼠鼠打印`-style file-conversion workbench with a correct mouse character identity and lightweight task-state mascot actions.

**Architecture:** Keep the Express/Electron conversion backend unchanged. Add deterministic project-local mascot assets generated from the full existing `鼠鼠打印` base mouse image, then update the renderer HTML/CSS/JS to map UI workflow states to those assets without coupling mascot state to conversion APIs.

**Tech Stack:** Electron renderer HTML/CSS/vanilla JS, Node `node:test`, `sharp` for deterministic PNG compositing, existing Express conversion tests, optional Playwright/browser screenshot verification.

---

## File Structure

- Create: `D:\34615\飞鼠格式\tests\mouse-assets.test.js`
  - Verifies mouse action assets exist, are PNG, have alpha, and are not tiny placeholder files.
- Create: `D:\34615\飞鼠格式\tests\ui-static.test.js`
  - Verifies renderer DOM hooks and JavaScript state mapping exist.
- Create: `D:\34615\飞鼠格式\scripts\build-mouse-format-assets.js`
  - Builds 9 transparent PNG action assets from the full `D:\鼠鼠打印\assets\mouse_avatar.png` base image and SVG overlays.
- Create directory: `D:\34615\飞鼠格式\public\assets\mouse-format\`
  - Stores generated PNG assets and copied source reference image.
- Modify: `D:\34615\飞鼠格式\public\index.html`
  - Adds top brand mascot, workflow strip, drop-zone mascot image, and clearer mouse-style copy.
- Modify: `D:\34615\飞鼠格式\public\app.js`
  - Adds `MOUSE_ASSETS`, `setMouseState()`, workflow step updates, and calls through the existing file lifecycle.
- Modify: `D:\34615\飞鼠格式\public\styles.css`
  - Replaces the current calm teal styling with mouse-print-inspired rough card styling, while preserving responsive behavior.
- Modify: `D:\34615\飞鼠格式\README.md`
  - Documents the UI asset build command and mouse character constraints.
- Modify: `D:\34615\飞鼠格式\AGENTS.md`
  - Adds future-agent guardrails: do not crop the mouse head or use avatar-body mashups.

Because `D:\34615\飞鼠格式` is not a git repository, use timestamped backups instead of commits.

---

## Task 1: Add Asset Contract Test

**Files:**
- Create: `D:\34615\飞鼠格式\tests\mouse-assets.test.js`

- [ ] **Step 1: Write the failing asset test**

Create `D:\34615\飞鼠格式\tests\mouse-assets.test.js`:

```js
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
```

- [ ] **Step 2: Run the asset test and verify RED**

Run:

```powershell
node --test tests\mouse-assets.test.js
```

Expected: FAIL because `public\assets\mouse-format\mouse-idle.png` does not exist yet.

---

## Task 2: Generate Correct Mouse Action Assets

**Files:**
- Create: `D:\34615\飞鼠格式\scripts\build-mouse-format-assets.js`
- Create directory: `D:\34615\飞鼠格式\public\assets\mouse-format\`
- Generate: `D:\34615\飞鼠格式\public\assets\mouse-format\mouse-*.png`

- [ ] **Step 1: Add the deterministic asset builder**

Create `D:\34615\飞鼠格式\scripts\build-mouse-format-assets.js`:

```js
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const sourceMouse = "D:\\鼠鼠打印\\assets\\mouse_avatar.png";
const outputDir = path.join(root, "public", "assets", "mouse-format");

const canvas = { width: 720, height: 540 };
const mouseBox = { left: 116, top: 56, width: 380 };

const actions = [
  { name: "idle", prop: "none", tint: "#fffdf8" },
  { name: "upload", prop: "folder", tint: "#ffe0e4" },
  { name: "analyzing", prop: "magnifier", tint: "#dff5ee" },
  { name: "converting", prop: "machine", tint: "#fff2bc" },
  { name: "pdf-pages", prop: "pages", tint: "#dcecff" },
  { name: "ocr", prop: "txt", tint: "#dff5ee" },
  { name: "batch", prop: "cart", tint: "#fff2bc" },
  { name: "success", prop: "check", tint: "#ffe0e4" },
  { name: "error", prop: "warning", tint: "#dcecff" }
];

function svgFor(action) {
  const prop = propSvg(action.prop);
  return Buffer.from(`
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="none"/>
      <g opacity="0.98">
        <path d="M104 425 C130 493 533 500 566 426" fill="${action.tint}" stroke="#111" stroke-width="11" stroke-linecap="round"/>
        <path d="M123 430 C112 464 132 488 178 498" fill="none" stroke="#111" stroke-width="10" stroke-linecap="round"/>
        <path d="M525 431 C538 464 519 488 472 498" fill="none" stroke="#111" stroke-width="10" stroke-linecap="round"/>
      </g>
      ${prop}
    </svg>
  `);
}

function propSvg(prop) {
  if (prop === "none") {
    return `<text x="502" y="132" font-family="Microsoft YaHei, Arial" font-size="34" font-weight="900" fill="#e95f6d">待命</text>`;
  }
  if (prop === "folder") {
    return `
      <g transform="translate(446 118)">
        <path d="M26 0 H92 L111 24 H174 Q188 24 188 38 V154 Q188 170 172 170 H20 Q4 170 4 154 V20 Q4 0 26 0 Z" fill="#ffe0e4" stroke="#111" stroke-width="9" stroke-linejoin="round"/>
        <path d="M28 67 H160" stroke="#111" stroke-width="8" stroke-linecap="round"/>
        <path d="M28 101 H130" stroke="#111" stroke-width="8" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "magnifier") {
    return `
      <g transform="translate(464 116)">
        <rect x="0" y="0" width="158" height="118" rx="16" fill="#fff" stroke="#111" stroke-width="9"/>
        <path d="M28 34 H116 M28 66 H94" stroke="#111" stroke-width="8" stroke-linecap="round"/>
        <circle cx="55" cy="138" r="38" fill="#fff" stroke="#111" stroke-width="9"/>
        <circle cx="55" cy="138" r="10" fill="#e95f6d"/>
        <path d="M83 166 L128 211" stroke="#111" stroke-width="11" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "machine") {
    return `
      <g transform="translate(455 120)">
        <rect x="0" y="30" width="178" height="132" rx="17" fill="#fff" stroke="#111" stroke-width="9"/>
        <path d="M22 73 H134 M22 108 H104" stroke="#111" stroke-width="8" stroke-linecap="round"/>
        <circle cx="158" cy="12" r="18" fill="#e95f6d" stroke="#111" stroke-width="7"/>
        <path d="M151 30 C124 54 120 78 140 98" fill="none" stroke="#111" stroke-width="9" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "pages") {
    return `
      <g transform="translate(454 92)">
        <rect x="34" y="34" width="126" height="164" rx="12" fill="#fff" stroke="#111" stroke-width="8"/>
        <rect x="18" y="18" width="126" height="164" rx="12" fill="#fff" stroke="#111" stroke-width="8"/>
        <rect x="2" y="2" width="126" height="164" rx="12" fill="#fff" stroke="#111" stroke-width="8"/>
        <path d="M27 47 H95 M27 82 H88 M27 117 H103" stroke="#111" stroke-width="8" stroke-linecap="round"/>
        <path d="M102 142 L139 177" stroke="#e95f6d" stroke-width="10" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "txt") {
    return `
      <g transform="translate(450 112)">
        <rect x="0" y="0" width="176" height="132" rx="16" fill="#fff" stroke="#111" stroke-width="9"/>
        <text x="32" y="84" font-family="Arial" font-size="48" font-weight="900" fill="#111">TXT</text>
        <path d="M21 104 H147" stroke="#e95f6d" stroke-width="8" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "cart") {
    return `
      <g transform="translate(443 154)">
        <rect x="24" y="30" width="186" height="112" rx="17" fill="#fff" stroke="#111" stroke-width="9"/>
        <rect x="46" y="0" width="118" height="55" rx="12" fill="#ffe0e4" stroke="#111" stroke-width="8"/>
        <path d="M0 22 H42" stroke="#111" stroke-width="10" stroke-linecap="round"/>
        <circle cx="73" cy="158" r="16" fill="#fff" stroke="#111" stroke-width="8"/>
        <circle cx="168" cy="158" r="16" fill="#fff" stroke="#111" stroke-width="8"/>
      </g>`;
  }
  if (prop === "check") {
    return `
      <g transform="translate(470 116)">
        <rect x="0" y="0" width="150" height="150" rx="18" fill="#ffe0e4" stroke="#111" stroke-width="9"/>
        <path d="M39 80 L66 108 L113 44" fill="none" stroke="#e95f6d" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
  }
  if (prop === "warning") {
    return `
      <g transform="translate(472 116)">
        <rect x="0" y="0" width="150" height="150" rx="18" fill="#fff" stroke="#111" stroke-width="9"/>
        <path d="M75 34 V88" stroke="#e95f6d" stroke-width="14" stroke-linecap="round"/>
        <circle cx="75" cy="115" r="9" fill="#e95f6d"/>
      </g>`;
  }
  throw new Error(`Unknown prop: ${prop}`);
}

async function build() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.copyFile(sourceMouse, path.join(outputDir, "source-mouse-avatar.png"));

  const baseMouse = await sharp(sourceMouse)
    .resize({ width: mouseBox.width, fit: "contain" })
    .png()
    .toBuffer();

  for (const action of actions) {
    const output = path.join(outputDir, `mouse-${action.name}.png`);
    await sharp({
      create: {
        width: canvas.width,
        height: canvas.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        { input: svgFor(action), left: 0, top: 0 },
        { input: baseMouse, left: mouseBox.left, top: mouseBox.top }
      ])
      .png()
      .toFile(output);
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Important: this script uses the full `mouse_avatar.png` and layers props around it. It does not crop the head or redraw a separate body.

- [ ] **Step 2: Run asset builder**

Run:

```powershell
node scripts\build-mouse-format-assets.js
```

Expected: exit 0 and 10 files in `public\assets\mouse-format\` including `source-mouse-avatar.png`.

- [ ] **Step 3: Run asset test and verify GREEN**

Run:

```powershell
node --test tests\mouse-assets.test.js
```

Expected: PASS.

---

## Task 3: Add Static UI Contract Test

**Files:**
- Create: `D:\34615\飞鼠格式\tests\ui-static.test.js`

- [ ] **Step 1: Write the failing UI static test**

Create `D:\34615\飞鼠格式\tests\ui-static.test.js`:

```js
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
    assert.match(app, new RegExp(`${stateName}:\\\\s*\"/assets/mouse-format/mouse-`), `${stateName} asset mapping is missing`);
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

  assert.match(css, /--accent:\\s*#e95f6d/, "mouse pink accent is missing");
  assert.match(css, /\\.workflow-steps/, "workflow styles are missing");
  assert.match(css, /\\.mouse-mascot/, "mouse mascot styles are missing");
  assert.match(css, /border:\\s*3px solid var\\(--ink\\)/, "rough black card border style is missing");
});
```

- [ ] **Step 2: Run static UI test and verify RED**

Run:

```powershell
node --test tests\ui-static.test.js
```

Expected: FAIL because `mouseMascot`, `workflowSteps`, and state mapping do not exist yet.

---

## Task 4: Update Renderer Markup and State Mapping

**Files:**
- Modify: `D:\34615\飞鼠格式\public\index.html`
- Modify: `D:\34615\飞鼠格式\public\app.js`

- [ ] **Step 1: Back up renderer files**

Run:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-backup-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item 'D:\34615\飞鼠格式\public\index.html','D:\34615\飞鼠格式\public\app.js','D:\34615\飞鼠格式\public\styles.css','D:\34615\飞鼠格式\README.md','D:\34615\飞鼠格式\AGENTS.md' -Destination $backup -Force
$backup
```

Expected: prints a backup path.

- [ ] **Step 2: Modify `index.html`**

Replace the topbar and drop-zone sections with markup that keeps the same IDs used by JavaScript and adds the new hooks:

```html
<div class="topbar">
  <div class="brand-lockup">
    <img class="brand-mouse" src="/assets/mouse-format/mouse-idle.png" alt="" aria-hidden="true">
    <div>
      <p class="eyebrow">飞鼠格式</p>
      <h1>鼠鼠帮你把文件转成需要的格式</h1>
    </div>
  </div>
  <div class="health" id="toolHealth">正在检测转换引擎</div>
</div>

<nav class="workflow-steps" id="workflowSteps" aria-label="转换流程">
  <span class="workflow-step active" data-step="select">选择文件</span>
  <span class="workflow-step" data-step="analyze">识别格式</span>
  <span class="workflow-step" data-step="convert">开始转换</span>
  <span class="workflow-step" data-step="save">保存结果</span>
</nav>
```

Update the upload button body:

```html
<button class="drop-zone" id="dropZone" type="button">
  <span class="mouse-stage" aria-hidden="true">
    <img class="mouse-mascot" id="mouseMascot" src="/assets/mouse-format/mouse-upload.png" alt="">
  </span>
  <span class="drop-main">把文件丢给鼠鼠</span>
  <span class="drop-sub" id="dropHint">图片、文档、PDF、WPS、音视频都可以试</span>
</button>
```

Keep existing IDs: `fileInput`, `dropZone`, `dropHint`, `targetSelect`, `convertButton`, `progressPanel`, `statusBox`, `downloadButton`, `batchSaveButton`.

- [ ] **Step 3: Add state mapping to `app.js`**

Add selectors and mapping near the existing DOM queries:

```js
const mouseMascot = document.querySelector("#mouseMascot");
const workflowSteps = [...document.querySelectorAll("[data-step]")];

const mouseAssets = {
  idle: "/assets/mouse-format/mouse-idle.png",
  upload: "/assets/mouse-format/mouse-upload.png",
  analyzing: "/assets/mouse-format/mouse-analyzing.png",
  converting: "/assets/mouse-format/mouse-converting.png",
  pdfPages: "/assets/mouse-format/mouse-pdf-pages.png",
  ocr: "/assets/mouse-format/mouse-ocr.png",
  batch: "/assets/mouse-format/mouse-batch.png",
  success: "/assets/mouse-format/mouse-success.png",
  error: "/assets/mouse-format/mouse-error.png"
};
```

Add helper functions after `setStatus()`:

```js
function setMouseState(name) {
  if (!mouseMascot) return;
  const src = mouseAssets[name] || mouseAssets.idle;
  mouseMascot.src = src;
  mouseMascot.dataset.state = name;
}

function setWorkflowStep(step) {
  for (const item of workflowSteps) {
    item.classList.toggle("active", item.dataset.step === step);
  }
}

function mouseStateForConversion(targetFormat) {
  if (state.files.length > 1) return "batch";
  if (targetFormat === "txt" && state.fileInfos.some((info) => info.category === "image" || info.category === "pdf")) {
    return "ocr";
  }
  if ((targetFormat === "png" || targetFormat === "jpg") && state.fileInfos.some((info) => info.category === "pdf")) {
    return "pdfPages";
  }
  return "converting";
}
```

Update lifecycle calls:

```js
function clearFile() {
  // keep existing reset code
  setMouseState("upload");
  setWorkflowStep("select");
}
```

In `acceptFiles()` after reset:

```js
setMouseState(files.length > 1 ? "batch" : "analyzing");
setWorkflowStep("analyze");
```

After targets are successfully loaded:

```js
setMouseState(files.length > 1 ? "batch" : "idle");
setWorkflowStep("convert");
```

In the catch block of `acceptFiles()`:

```js
setMouseState("error");
setWorkflowStep("analyze");
```

In `convertCurrentFiles()` after targetFormat is known:

```js
setMouseState(mouseStateForConversion(targetFormat));
setWorkflowStep("convert");
```

In all success branches:

```js
setMouseState("success");
setWorkflowStep("save");
```

In all error branches:

```js
setMouseState("error");
```

In drag events:

```js
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
  setMouseState("upload");
});
```

- [ ] **Step 4: Run UI static test**

Run:

```powershell
node --test tests\ui-static.test.js
```

Expected: still may fail on CSS theme classes until Task 5 is complete, but HTML and JS hook assertions should pass.

---

## Task 5: Apply Mouse Print Visual Theme

**Files:**
- Modify: `D:\34615\飞鼠格式\public\styles.css`

- [ ] **Step 1: Replace design tokens**

Update `:root` to:

```css
:root {
  color-scheme: light;
  --bg: #f5f4f1;
  --panel: #fffdf8;
  --card: #ffffff;
  --ink: #111111;
  --muted: #555555;
  --line: #111111;
  --accent: #e95f6d;
  --accent-strong: #d94d5d;
  --accent-soft: #ffe0e4;
  --success: #219653;
  --warning: #8a6d00;
  --error: #d93025;
  --shadow: 6px 6px 0 #111111;
}
```

- [ ] **Step 2: Add mouse workbench structure styles**

Add or update these class blocks:

```css
body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(90deg, rgba(17, 17, 17, 0.035) 1px, transparent 1px),
    linear-gradient(rgba(17, 17, 17, 0.035) 1px, transparent 1px),
    var(--bg);
  background-size: 24px 24px;
  color: var(--ink);
  font-family: "Microsoft YaHei UI", "Segoe UI", Arial, sans-serif;
}

.workspace,
.drop-panel,
.controls,
.format-item,
.health,
.status-box,
.progress-panel,
.file-strip,
.batch-item {
  border: 3px solid var(--ink);
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--shadow);
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.brand-mouse {
  width: 86px;
  height: 72px;
  object-fit: contain;
  flex: none;
}

.workflow-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.workflow-step {
  min-height: 42px;
  display: grid;
  place-items: center;
  border: 3px solid var(--ink);
  border-radius: 999px;
  background: #ffffff;
  font-size: 14px;
  font-weight: 900;
  text-align: center;
  overflow-wrap: anywhere;
}

.workflow-step.active {
  background: var(--accent-soft);
  color: var(--ink);
}

.mouse-stage {
  display: grid;
  place-items: center;
  min-height: 190px;
  margin-bottom: 8px;
}

.mouse-mascot {
  width: min(320px, 72vw);
  height: 230px;
  object-fit: contain;
  filter: drop-shadow(5px 5px 0 rgba(17, 17, 17, 0.22));
}
```

- [ ] **Step 3: Restyle buttons and upload area**

Update:

```css
.drop-zone {
  display: grid;
  place-items: center;
  align-content: center;
  width: 100%;
  min-height: 392px;
  border: 0;
  border-radius: 0;
  padding: 30px 24px;
  color: var(--ink);
  background: var(--accent-soft);
  text-align: center;
}

.drop-zone.dragging {
  outline: 5px dashed var(--accent);
  outline-offset: -12px;
}

.drop-main {
  display: block;
  max-width: 520px;
  font-size: clamp(24px, 3vw, 34px);
  font-weight: 900;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.primary-button,
.download-button {
  display: inline-grid;
  place-items: center;
  background: var(--accent);
  color: #ffffff;
  border-color: var(--ink);
  box-shadow: 4px 4px 0 #111111;
}

.primary-button:hover,
.download-button:hover {
  background: var(--accent-strong);
  transform: translate(-1px, -1px);
}
```

- [ ] **Step 4: Preserve responsive behavior**

Add to existing media queries:

```css
@media (max-width: 860px) {
  .brand-lockup {
    align-items: flex-start;
  }

  .workflow-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .brand-lockup {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
  }

  .brand-mouse {
    width: 70px;
    height: 62px;
  }

  .workflow-steps {
    grid-template-columns: 1fr;
  }

  .mouse-mascot {
    width: min(270px, 84vw);
    height: 190px;
  }
}
```

- [ ] **Step 5: Run static UI test and verify GREEN**

Run:

```powershell
node --test tests\ui-static.test.js
```

Expected: PASS.

---

## Task 6: Update Documentation Guardrails

**Files:**
- Modify: `D:\34615\飞鼠格式\README.md`
- Modify: `D:\34615\飞鼠格式\AGENTS.md`

- [ ] **Step 1: Update README**

Add under key paths:

```markdown
- `public/assets/mouse-format/`：飞鼠格式鼠鼠角色动作资产。动作资产必须保持完整鼠鼠头身形象，不能使用圆裁头像贴身体。
- `scripts/build-mouse-format-assets.js`：从本机 `D:\鼠鼠打印\assets\mouse_avatar.png` 生成飞鼠格式专属鼠鼠动作 PNG。
```

Add under verification suggestions:

```markdown
- `node scripts\build-mouse-format-assets.js`
- `node --test tests\mouse-assets.test.js tests\ui-static.test.js`
- 打开桌面端或本地服务截图检查鼠鼠头身是否仍是同一个角色，不能出现圆头像贴矢量身体。
```

- [ ] **Step 2: Update AGENTS.md**

Add to Rules:

```markdown
- Mouse-style UI assets must preserve the `鼠鼠打印` character grammar: full low-resolution mouse head, white blob body, rough black outline, and pink accent. Never crop the head into a circle or attach it to a generic vector body.
- Mouse UI state changes are renderer-only. Do not couple mascot states to conversion backend logic or change conversion APIs for visual effects.
```

- [ ] **Step 3: Run Markdown static checks**

Run:

```powershell
Select-String -LiteralPath README.md,AGENTS.md -Pattern 'mouse-format|圆裁头像|vector body|renderer-only'
```

Expected: output includes the newly added guardrail lines.

---

## Task 7: Full Functional and Visual Verification

**Files:**
- Verify: `D:\34615\飞鼠格式\public\index.html`
- Verify: `D:\34615\飞鼠格式\public\styles.css`
- Verify: `D:\34615\飞鼠格式\public\app.js`
- Verify: generated screenshots in a temporary workspace folder, then remove them.

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check server.js
node --check public\app.js
node --check electron-main.js
node --check preload.js
```

Expected: exit 0 with no syntax errors.

- [ ] **Step 2: Run all automated tests**

Run:

```powershell
npm test
```

Expected: all conversion tests plus `mouse-assets.test.js` and `ui-static.test.js` pass. Existing `pdfjs-dist` optional canvas warnings may appear; failures are not acceptable.

- [ ] **Step 3: Start local service for screenshot verification**

Run:

```powershell
$env:PORT='5187'
$out='C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-server.out.log'
$err='C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-server.err.log'
Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath 'D:\Program Files\nodejs\node.exe' -ArgumentList @('server.js') -WorkingDirectory 'D:\34615\飞鼠格式' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
$p.Id
```

Expected: prints a process id and `http://127.0.0.1:5187` responds.

- [ ] **Step 4: Capture desktop and narrow screenshots**

Use Playwright CLI or an equivalent browser screenshot tool. If using Playwright CLI:

```powershell
npx --yes playwright screenshot --viewport-size=1365,900 http://127.0.0.1:5187 C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-desktop.png
npx --yes playwright screenshot --viewport-size=390,844 http://127.0.0.1:5187 C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-mobile.png
```

Expected: screenshots exist and show the full first screen.

- [ ] **Step 5: Manual visual review**

Inspect screenshots and confirm:

- Mouse head is not circular-cropped.
- The body is the original blob mouse, not a generic vector body.
- Upload text, target select, convert button, status box, and format cards do not overlap.
- Desktop first screen communicates the conversion workflow.
- Mobile view preserves readable text and reachable controls.

- [ ] **Step 6: Stop local service and remove verification artifacts**

Run:

```powershell
Get-Process | Where-Object { $_.Id -eq $p.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath `
  'C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-server.out.log',
  'C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-server.err.log',
  'C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-desktop.png',
  'C:\Users\34615\Documents\Codex\2026-07-02\files-mentioned-by-the-user-lnk\work\mouse-ui-mobile.png' `
  -Force -ErrorAction SilentlyContinue
```

Expected: temporary logs and screenshots are removed after review. Keep source assets and project files.

---

## Self-Review

- Spec coverage:
  - Character identity rules covered by Task 2 asset generation approach and Task 6 documentation guardrails.
  - B + small C workbench layout covered by Task 4 HTML/JS and Task 5 CSS.
  - Rebuilt mouse actions covered by Task 2 generated action files.
  - Renderer-only state mapping covered by Task 4.
  - Visual/manual verification covered by Task 7.
- Placeholder scan:
  - No unfinished placeholders or unspecified “handle edge cases” steps.
- Type/name consistency:
  - Asset names in tests, builder, HTML, and JS all use `mouse-*.png`.
  - JS state names use camelCase only where needed for `pdfPages`; file names stay kebab-case.
  - Existing conversion API names are unchanged.
