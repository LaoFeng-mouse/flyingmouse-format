# Mahiro Format v0.3.2 Win7 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a reproducible Windows 7 SP1 x64 installer from the current Mahiro Format v0.3.2 mouse-UI source without downgrading the Windows 10/11 main package.

**Architecture:** Keep the root package on Electron 43. A pure profile module derives a Win7 package manifest, while a CLI copies controlled source files into `output/win7-stage`, installs Electron 22-compatible dependencies there, and builds an NSIS-only x64 artifact. Shared runtime code gains a PDF.js `.mjs` to legacy `.js` fallback so the same source works with both dependency lines.

**Tech Stack:** Node.js CommonJS, Node test runner, Electron 43 mainline, Electron 22.3.27 legacy runtime, electron-builder 26, Sharp 0.32.6, pdfjs-dist 2.16.105, NSIS, PowerShell verification, GitHub CLI.

---

## File map

- Create `win7-build-profile.js`: pure Win7 manifest transformation and staging-entry selection.
- Create `scripts/build-win7.js`: prepare the isolated staging directory, install legacy dependencies, build NSIS x64, and copy the installer to root `dist/`.
- Create `pe-metadata.js`: parse PE optional-header OS version fields without external tools.
- Create `scripts/inspect-pe.js`: CLI wrapper for artifact verification.
- Create `tests/win7-build-profile.test.js`: profile and staging contract tests.
- Create `tests/win7-build-script.test.js`: prepare-only integration test that proves current source is staged without mutating the root manifest.
- Create `tests/pe-metadata.test.js`: unit tests for PE32 and PE32+ parsing.
- Modify `server.js`: support both current `.mjs` and Win7 legacy `.js` PDF.js builds.
- Modify `tests/electron-hardening-static.test.js`: assert the dual PDF.js loader without relaxing the Electron 43 mainline assertion.
- Modify `package.json`: add `dist:win7` and the new test files.
- Modify `.gitignore`: explicitly ignore `output/win7-stage/` even though `output/` is already ignored, documenting the build boundary.
- Modify `README.md`, `AGENTS.md`, `docs/RELEASE.md`, and `docs/HANDOFF.md`: user selection, maintenance commands, security boundary, artifact evidence, and release state.

### Task 1: Win7 manifest profile

**Files:**
- Create: `tests/win7-build-profile.test.js`
- Create: `win7-build-profile.js`

- [ ] **Step 1: Write the failing profile tests**

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const rootPackage = require("../package.json");

test("Win7 profile pins the legacy runtime without changing the main package", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const original = JSON.stringify(rootPackage);
  const input = JSON.parse(original);
  input.scripts.test += " tests/win7-build-profile.test.js tests/win7-build-script.test.js tests/pe-metadata.test.js";
  input.scripts["test:ci"] += " tests/win7-build-profile.test.js tests/win7-build-script.test.js tests/pe-metadata.test.js";
  input.scripts["dist:win7"] = "node scripts/build-win7.js";
  const profile = createWin7Package(input, path.resolve(__dirname, ".."));

  assert.equal(profile.name, "flyingmouse-format-win7");
  assert.equal(profile.version, "0.3.2");
  assert.equal(profile.devDependencies.electron, "22.3.27");
  assert.equal(profile.dependencies.sharp, "0.32.6");
  assert.equal(profile.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(profile.build.artifactName, "${productName}-Setup-${version}-win7-${arch}.${ext}");
  assert.deepEqual(profile.build.win.target, ["nsis"]);
  assert.equal(profile.build.appx, undefined);
  assert.doesNotMatch(profile.scripts.test, /win7-build|pe-metadata/);
  assert.doesNotMatch(profile.scripts["test:ci"], /win7-build|pe-metadata/);
  assert.equal(profile.scripts["dist:win7"], undefined);
  assert.equal(JSON.stringify(rootPackage), original);
});

test("Win7 profile includes every current runtime module and AV3A resource", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const projectRoot = path.resolve(__dirname, "..");
  const profile = createWin7Package(rootPackage, projectRoot);

  for (const file of [
    "electron-main.js", "electron-security.js", "preload.js", "server.js",
    "logger.js", "settings-store.js", "ncm-format.js", "av3a-format.js", "kgg-format.js"
  ]) {
    assert.ok(profile.build.files.includes(file), `missing ${file}`);
  }

  const avs3 = profile.build.extraResources.find((item) => item.to === "avs3");
  assert.ok(avs3);
  assert.equal(avs3.from, path.join(projectRoot, "bin", "avs3"));
});

test("stage source entries exclude node_modules and include build assets", () => {
  const { stageSourceEntries } = require("../win7-build-profile");
  const entries = stageSourceEntries(rootPackage);
  assert.ok(entries.includes("build"));
  assert.ok(entries.includes("public"));
  assert.ok(entries.includes("tests"));
  assert.ok(entries.includes("av3a-format.js"));
  assert.ok(entries.includes("settings-store.js"));
  assert.ok(!entries.includes("node_modules"));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --test tests/win7-build-profile.test.js
```

Expected: FAIL with `Cannot find module '../win7-build-profile'`.

- [ ] **Step 3: Implement the pure profile module**

```js
const path = require("node:path");

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWin7Package(basePackage, projectRoot) {
  if (!basePackage?.build?.files || !basePackage?.build?.extraResources) {
    throw new Error("Base package is missing electron-builder files or resources.");
  }

  const profile = cloneJson(basePackage);
  profile.name = "flyingmouse-format-win7";
  profile.dependencies.sharp = "0.32.6";
  profile.dependencies["pdfjs-dist"] = "2.16.105";
  profile.devDependencies.electron = "22.3.27";
  const builderOnlyTests = new Set([
    "tests/win7-build-profile.test.js",
    "tests/win7-build-script.test.js",
    "tests/pe-metadata.test.js"
  ]);
  for (const scriptName of ["test", "test:ci"]) {
    profile.scripts[scriptName] = profile.scripts[scriptName]
      .split(/\s+/)
      .filter((part) => !builderOnlyTests.has(part))
      .join(" ");
  }
  delete profile.scripts["dist:win7"];
  profile.build.artifactName = "${productName}-Setup-${version}-win7-${arch}.${ext}";
  profile.build.win.target = ["nsis"];
  delete profile.build.appx;
  profile.build.extraResources = profile.build.extraResources.map((item) => ({
    ...item,
    from: item.from.startsWith("bin/")
      ? path.join(projectRoot, ...item.from.split("/"))
      : item.from
  }));
  return profile;
}

function stageSourceEntries(basePackage) {
  const entries = new Set(["build", "tests"]);
  for (const pattern of basePackage.build.files) {
    if (pattern.startsWith("node_modules/")) continue;
    if (pattern.endsWith("/**/*")) {
      entries.add(pattern.slice(0, -5));
    } else {
      entries.add(pattern);
    }
  }
  entries.delete("package.json");
  return [...entries].sort();
}

module.exports = { createWin7Package, stageSourceEntries };
```

- [ ] **Step 4: Run the profile tests and verify GREEN**

Run:

```powershell
node --test tests/win7-build-profile.test.js
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the profile**

```powershell
git add win7-build-profile.js tests/win7-build-profile.test.js
git commit -m "feat: add reproducible Win7 build profile"
```

### Task 2: Isolated staging and build command

**Files:**
- Create: `tests/win7-build-script.test.js`
- Create: `scripts/build-win7.js`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing prepare-only integration test**

```js
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const rootPackagePath = path.join(root, "package.json");
const stage = path.join(root, "output", "win7-stage");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("prepare-only creates an isolated current-source Win7 staging tree", () => {
  const before = sha256(rootPackagePath);
  execFileSync(process.execPath, [path.join(root, "scripts", "build-win7.js"), "--prepare-only"], {
    cwd: root,
    stdio: "pipe"
  });

  assert.equal(sha256(rootPackagePath), before);
  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
  assert.equal(stagedPackage.devDependencies.electron, "22.3.27");
  for (const file of ["av3a-format.js", "settings-store.js", "public/app.js", "build/icon.png"]) {
    assert.ok(fs.existsSync(path.join(stage, ...file.split("/"))), `missing staged ${file}`);
  }
  assert.ok(!fs.existsSync(path.join(stage, "node_modules")));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test tests/win7-build-script.test.js
```

Expected: FAIL because `scripts/build-win7.js` does not exist.

- [ ] **Step 3: Implement the staging/build CLI**

```js
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createWin7Package, stageSourceEntries } = require("../win7-build-profile");

const root = path.resolve(__dirname, "..");
const outputRoot = path.join(root, "output");
const stage = path.join(outputRoot, "win7-stage");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function assertSafeStage() {
  const relative = path.relative(outputRoot, stage);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Win7 staging path: ${stage}`);
  }
}

function prepareStage() {
  assertSafeStage();
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const basePackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const entry of stageSourceEntries(basePackage)) {
    fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
  }
  const win7Package = createWin7Package(basePackage, root);
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(win7Package, null, 2)}\n`);
  return win7Package;
}

function build() {
  const profile = prepareStage();
  if (process.argv.includes("--prepare-only")) {
    console.log(stage);
    return;
  }

  execFileSync(npmCommand, ["install", "--no-audit", "--no-fund"], {
    cwd: stage,
    env: process.env,
    stdio: "inherit"
  });
  execFileSync(npmCommand, ["exec", "electron-builder", "--", "--win", "nsis", "--x64"], {
    cwd: stage,
    env: process.env,
    stdio: "inherit"
  });

  const artifact = profile.build.artifactName
    .replace("${productName}", profile.productName)
    .replace("${version}", profile.version)
    .replace("${arch}", "x64")
    .replace("${ext}", "exe");
  const source = path.join(stage, "dist", artifact);
  const destination = path.join(root, "dist", artifact);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(destination);
}

build();
```

- [ ] **Step 4: Wire the scripts and tests into `package.json`**

Add:

```json
"dist:win7": "node scripts/build-win7.js"
```

Append both Win7 test files to `test` and `test:ci`:

```text
tests/win7-build-profile.test.js tests/win7-build-script.test.js
```

Append to `.gitignore`:

```gitignore
# Reproducible Windows 7 staging tree
output/win7-stage/
```

- [ ] **Step 5: Run the integration and profile tests**

Run:

```powershell
node --test tests/win7-build-profile.test.js tests/win7-build-script.test.js
```

Expected: 4 tests pass; `output/win7-stage/package.json` exists and root `package.json` is unchanged.

- [ ] **Step 6: Commit the build command**

```powershell
git add scripts/build-win7.js tests/win7-build-script.test.js package.json .gitignore
git commit -m "feat: add isolated Win7 build command"
```

### Task 3: Dual PDF.js runtime loader

**Files:**
- Modify: `tests/electron-hardening-static.test.js`
- Modify: `server.js:320-324`

- [ ] **Step 1: Add the failing static contract test**

```js
test("PDF.js loader supports current and Win7 legacy package layouts", () => {
  const source = readRoot("server.js");
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(source, /\.catch\(\(\) => import\("pdfjs-dist\/legacy\/build\/pdf\.js"\)\)/);
  assert.match(source, /mod\.default \|\| mod/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test tests/electron-hardening-static.test.js
```

Expected: FAIL because `server.js` lacks the legacy `.js` fallback.

- [ ] **Step 3: Implement the shared fallback**

Replace `loadPdfjs()` with:

```js
function loadPdfjs() {
  if (!cachedPdfjsPromise) {
    cachedPdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .catch(() => import("pdfjs-dist/legacy/build/pdf.js"))
      .then((mod) => mod.default || mod);
  }
  return cachedPdfjsPromise;
}
```

- [ ] **Step 4: Verify focused and conversion tests**

Run:

```powershell
node --test tests/electron-hardening-static.test.js tests/conversion.test.js
```

Expected: all focused tests pass; current pdfjs-dist 6 conversions remain green.

- [ ] **Step 5: Commit the loader**

```powershell
git add server.js tests/electron-hardening-static.test.js
git commit -m "fix: support legacy PDF.js layout for Win7"
```

### Task 4: Reusable PE compatibility inspection

**Files:**
- Create: `tests/pe-metadata.test.js`
- Create: `pe-metadata.js`
- Create: `scripts/inspect-pe.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing PE32 and PE32+ tests**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { readPeOperatingSystemVersion } = require("../pe-metadata");

function peFixture(magic, major, minor) {
  const buffer = Buffer.alloc(256);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "binary");
  const optional = 0x80 + 24;
  buffer.writeUInt16LE(magic, optional);
  buffer.writeUInt16LE(major, optional + 40);
  buffer.writeUInt16LE(minor, optional + 42);
  return buffer;
}

test("reads PE32 operating system version", () => {
  assert.deepEqual(readPeOperatingSystemVersion(peFixture(0x10b, 5, 2)), { major: 5, minor: 2 });
});

test("reads PE32+ operating system version", () => {
  assert.deepEqual(readPeOperatingSystemVersion(peFixture(0x20b, 6, 1)), { major: 6, minor: 1 });
});

test("rejects a non-PE buffer", () => {
  assert.throws(() => readPeOperatingSystemVersion(Buffer.alloc(64)), /Not a PE executable/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test tests/pe-metadata.test.js
```

Expected: FAIL with `Cannot find module '../pe-metadata'`.

- [ ] **Step 3: Implement parser and CLI**

`pe-metadata.js`:

```js
function readPeOperatingSystemVersion(buffer) {
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Not a PE executable: missing MZ header.");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 68 > buffer.length || buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Not a PE executable: missing PE header.");
  }
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`Unsupported PE optional header: 0x${magic.toString(16)}`);
  }
  return {
    major: buffer.readUInt16LE(optional + 40),
    minor: buffer.readUInt16LE(optional + 42)
  };
}

module.exports = { readPeOperatingSystemVersion };
```

`scripts/inspect-pe.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
const { readPeOperatingSystemVersion } = require("../pe-metadata");

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/inspect-pe.js path-to-executable");
const filePath = path.resolve(input);
const osVersion = readPeOperatingSystemVersion(fs.readFileSync(filePath));
console.log(JSON.stringify({ filePath, osVersion }, null, 2));
```

Add `tests/pe-metadata.test.js` to `test` and `test:ci`.

- [ ] **Step 4: Run the PE tests and inspect the old verified Win7 EXE**

```powershell
node --test tests/pe-metadata.test.js
node scripts/inspect-pe.js "D:\34615\Mahiro Format-win7\dist\win-unpacked\Mahiro Format.exe"
```

Expected: 3 tests pass; old EXE reports OS version `5.2`.

- [ ] **Step 5: Commit the inspector**

```powershell
git add pe-metadata.js scripts/inspect-pe.js tests/pe-metadata.test.js package.json
git commit -m "test: add PE compatibility inspection"
```

### Task 5: Mainline regression gate

**Files:**
- No production files added in this task.

- [ ] **Step 1: Run syntax checks**

```powershell
node --check win7-build-profile.js
node --check scripts/build-win7.js
node --check pe-metadata.js
node --check scripts/inspect-pe.js
node --check server.js
```

Expected: every command exits 0 without output.

- [ ] **Step 2: Run the complete current-engine suite**

```powershell
$env:FLYINGMOUSE_FFMPEG_PATH='D:\34615\Mahiro Format\bin\ffmpeg\ffmpeg.exe'
$env:FLYINGMOUSE_AVS3_DECODER_PATH='D:\34615\Mahiro Format\bin\avs3\avs3RM0Decoder.exe'
$env:FLYINGMOUSE_LIBREOFFICE_PATH='D:\34615\Mahiro Format\bin\libreoffice\LibreOfficePortable\App\libreoffice\program\soffice.com'
$env:FLYINGMOUSE_PDFTOPPM_PATH='D:\34615\Mahiro Format\bin\poppler\Library\bin\pdftoppm.exe'
npm test
```

Expected: the original 72 tests plus the newly added Win7/PE tests all pass; zero failures.

- [ ] **Step 3: Run mainline dependency and diff checks**

```powershell
npm audit --omit=dev
git diff --check
git status --short
```

Expected: mainline audit reports 0 vulnerabilities; diff check is clean; only intentional files are modified.

### Task 6: Build and test the Win7 staging environment

**Files:**
- Generated only: `output/win7-stage/**`
- Generated only: `dist/Mahiro Format-Setup-0.3.2-win7-x64.exe`

- [ ] **Step 1: Prepare and inspect the generated manifest**

```powershell
npm run dist:win7 -- --prepare-only
Get-Content -LiteralPath 'output\win7-stage\package.json' -Raw
```

Expected: Electron 22.3.27, Sharp 0.32.6, pdfjs-dist 2.16.105, NSIS-only, `-win7-x64` artifact naming, current runtime modules, and absolute `bin` resource sources.

- [ ] **Step 2: Build the Win7 installer**

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist:win7
```

Expected: build exits 0 and creates both:

```text
output/win7-stage/dist/win-unpacked/Mahiro Format.exe
dist/Mahiro Format-Setup-0.3.2-win7-x64.exe
```

- [ ] **Step 3: Run the generated staging test suite**

```powershell
$env:FLYINGMOUSE_FFMPEG_PATH='D:\34615\Mahiro Format\bin\ffmpeg\ffmpeg.exe'
$env:FLYINGMOUSE_AVS3_DECODER_PATH='D:\34615\Mahiro Format\bin\avs3\avs3RM0Decoder.exe'
$env:FLYINGMOUSE_LIBREOFFICE_PATH='D:\34615\Mahiro Format\bin\libreoffice\LibreOfficePortable\App\libreoffice\program\soffice.com'
$env:FLYINGMOUSE_PDFTOPPM_PATH='D:\34615\Mahiro Format\bin\poppler\Library\bin\pdftoppm.exe'
npm test --prefix output\win7-stage
```

Expected: 73 runtime/security/UI tests pass under the Electron 22-compatible dependency tree. Builder-only profile, staging, and PE-parser tests are intentionally removed from the generated staging `test` script and already passed in the mainline suite.

- [ ] **Step 4: Run real AV3A fixtures under the Win7 dependency tree**

```powershell
$env:FLYINGMOUSE_AV3A_NCM_FIXTURES='C:\Users\34615\Documents\xwechat_files\wxid_u36yiqf133e722_e0ec\msg\file\2026-08\喜羊羊童星合唱团 - 奇思妙想喜羊羊（《奇思妙想喜羊羊》主题曲）.ncm'
node --test output\win7-stage\tests\av3a-real.test.js
```

Expected: the real AV3A fixture produces a fully decodable MP3 and the test passes. If the file is no longer present, locate one of the two other user-provided AV3A samples and set the same environment variable to its absolute path.

- [ ] **Step 5: Audit legacy production dependencies without force-fixing**

```powershell
npm audit --omit=dev --prefix output\win7-stage --json
```

Expected: capture the exact JSON result. Any advisory caused by fixed legacy dependencies is recorded in release notes; do not run `npm audit fix --force`.

### Task 7: Packaged artifact acceptance

**Files:**
- Generated evidence: `output/win7-acceptance/**`

- [ ] **Step 1: Verify version, PE requirement, size, and hash**

```powershell
$exe='D:\34615\Mahiro Format\output\win7-stage\dist\win-unpacked\Mahiro Format.exe'
$installer='D:\34615\Mahiro Format\dist\Mahiro Format-Setup-0.3.2-win7-x64.exe'
node scripts/inspect-pe.js $exe
(Get-Item -LiteralPath $exe).VersionInfo | Select-Object ProductVersion,FileVersion
Get-Item -LiteralPath $installer | Select-Object FullName,Length
Get-FileHash -LiteralPath $installer -Algorithm SHA256
```

Expected: ProductVersion `0.3.2.0`; PE OS version no higher than `6.1`; installer exists with a non-zero size and SHA-256.

- [ ] **Step 2: Verify packaged files and resources**

```powershell
npx asar list 'output\win7-stage\dist\win-unpacked\resources\app.asar' | rg 'av3a-format.js|settings-store.js|logger.js|ncm-format.js|kgg-format.js|public/app.js'
Get-Item -LiteralPath 'output\win7-stage\dist\win-unpacked\resources\avs3\avs3RM0Decoder.exe','output\win7-stage\dist\win-unpacked\resources\avs3\model.bin'
```

Expected: every runtime module is listed and both AVS3 files exist.

- [ ] **Step 3: Launch the exact unpacked Win7 build and capture logs**

```powershell
$win7Exe='D:\34615\Mahiro Format\output\win7-stage\dist\win-unpacked\Mahiro Format.exe'
$before=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $win7Exe} | Select-Object -ExpandProperty ProcessId
Start-Process -FilePath $win7Exe -WindowStyle Hidden
Start-Sleep -Seconds 8
Get-Content -LiteralPath "$env:APPDATA\Mahiro Format\debug.log" -Tail 80
$after=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $win7Exe -and $_.ProcessId -notin $before}
$after | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
```

Expected: log contains `Server started`, `Creating window`, and `Window finished loading`; only processes whose executable path exactly matches the Win7 artifact are stopped.

- [ ] **Step 4: Verify the packaged mouse icon visually**

Run:

```powershell
$exe='D:\34615\Mahiro Format\output\win7-stage\dist\win-unpacked\Mahiro Format.exe'
$iconOut='D:\34615\Mahiro Format\output\win7-acceptance\extracted-icon.png'
New-Item -ItemType Directory -Path (Split-Path -LiteralPath $iconOut) -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$icon=[System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$bitmap=$icon.ToBitmap()
$bitmap.Save($iconOut,[System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$icon.Dispose()
```

Inspect `output/win7-acceptance/extracted-icon.png` with the local image viewer.

Expected: the icon is the gray mouse identity, not the orange lightning mark.

- [ ] **Step 5: Record the evidence boundary**

Generate a machine-readable evidence record from the verified artifact:

```powershell
$installer='D:\34615\Mahiro Format\dist\Mahiro Format-Setup-0.3.2-win7-x64.exe'
$evidence=[PSCustomObject]@{
  version='0.3.2'
  automatedTests=[PSCustomObject]@{status='passed';count=80}
  win7DependencyTests=[PSCustomObject]@{status='passed';count=73}
  realAv3aTest=[PSCustomObject]@{status='passed';count=1}
  peOperatingSystemVersion='5.2'
  electron22Smoke='passed-on-current-Windows-host'
  actualWindows7Sp1X64Runtime='pending'
  codeSigning='unsigned'
  installerBytes=(Get-Item -LiteralPath $installer).Length
  sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLower()
}
$evidence | ConvertTo-Json -Depth 4
```

Use the JSON values when patching `docs/HANDOFF.md` and the final QA report. If any preceding verification did not pass or the measured PE value differs from `5.2`, stop instead of writing this success record.

### Task 8: Documentation and release metadata

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/RELEASE.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Update README system selection in both languages**

Add a Windows 7 entry that tells users to choose the `win7-x64` asset only on Windows 7 SP1 x64, while Windows 10/11 users keep the standard x64 installer. Add the legacy-security and unsigned-build warning beside the Win7 entry.

- [ ] **Step 2: Add reproducible maintenance commands**

Document these exact commands in `AGENTS.md` and `docs/RELEASE.md`:

```powershell
node scripts/build-win7.js --prepare-only
npm run dist:win7
node scripts/inspect-pe.js "output\win7-stage\dist\win-unpacked\Mahiro Format.exe"
npm audit --omit=dev --prefix output\win7-stage
```

Also document the fixed dependency versions, NSIS-only boundary, staging location, real-Win7 acceptance boundary, and the rule that Win10/11 mainline stays on Electron 43.

- [ ] **Step 3: Add actual artifact evidence to HANDOFF**

Use the exact ProductVersion, byte length, SHA-256, PE version, test count, legacy audit result, smoke result, and real-Win7 status produced by Tasks 6-7. Do not copy the old v0.2.1 hash and do not state that actual Win7 passed unless it was run on a Windows 7 SP1 x64 machine.

- [ ] **Step 4: Run documentation consistency checks**

```powershell
rg -n '0\.2\.1-win7|Electron 22|Win7|Windows 7|dist:win7|win7-stage' README.md AGENTS.md docs
git diff --check
```

Expected: no active download instruction points to v0.2.1; all current Win7 instructions agree on v0.3.2, x64 SP1, Electron 22.3.27, and the evidence boundary.

- [ ] **Step 5: Commit implementation and release documentation**

```powershell
git add README.md AGENTS.md docs/RELEASE.md docs/HANDOFF.md
git commit -m "docs: add v0.3.2 Win7 legacy release guidance"
```

### Task 9: Final verification and GitHub publication

**Files:**
- No additional source files expected.

- [ ] **Step 1: Run the final local gate**

```powershell
npm test
npm audit --omit=dev
git diff --check
git status --short
```

Expected: all tests pass, mainline audit is 0 vulnerabilities, diff check is clean, and worktree is clean after commits.

- [ ] **Step 2: Push main without moving v0.3.2 tag**

```powershell
git -c http.proxy=http://127.0.0.1:7897 push origin main
```

Expected: remote `main` advances to the implementation/docs commit. The existing `v0.3.2` tag and Windows 10/11 asset remain unchanged.

- [ ] **Step 3: Upload the Win7 installer to the existing Release**

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
gh release upload v0.3.2 'dist\Mahiro Format-Setup-0.3.2-win7-x64.exe' --repo LaoFeng-mouse/flyingmouse-format
```

Expected: GitHub reports successful upload and does not replace the standard x64 asset.

- [ ] **Step 4: Update Release notes with the exact compatibility warning**

Append the compatibility warning without discarding the existing v0.3.2 notes:

```powershell
$existing=gh release view v0.3.2 --repo LaoFeng-mouse/flyingmouse-format --json body --jq .body
$legacy=@(
  'Windows 7 SP1 x64 users must choose the win7-x64 asset.'
  'This Legacy build uses Electron 22.3.27, which is no longer maintained upstream.'
  'Windows 10/11 users should use the standard x64 installer.'
  'The installer is unsigned. Actual Windows 7 runtime acceptance is listed separately from automated and PE checks.'
) -join "`n"
gh release edit v0.3.2 --repo LaoFeng-mouse/flyingmouse-format --notes ($existing.TrimEnd()+"`n`n"+$legacy)
```

- [ ] **Step 5: Read back and compare the remote asset**

```powershell
gh api repos/LaoFeng-mouse/flyingmouse-format/releases/tags/v0.3.2 --jq '{tag_name:.tag_name,assets:[.assets[]|{name:.name,size:.size,digest:.digest,state:.state}]}'
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: the Win7 asset state is `uploaded`; its remote size and `sha256:` digest equal the local artifact; local HEAD equals remote main.

- [ ] **Step 6: Copy the verified installer and acceptance report to the Codex output folder**

```powershell
Copy-Item -LiteralPath 'D:\34615\Mahiro Format\dist\Mahiro Format-Setup-0.3.2-win7-x64.exe' -Destination 'C:\Users\34615\Documents\Codex\2026-08-08\zhi\outputs\Mahiro Format-Setup-0.3.2-win7-x64.exe' -Force
```

Create `C:\Users\34615\Documents\Codex\2026-08-08\zhi\outputs\Mahiro-Format-v0.3.2-Win7-QA.md` with the exact local/remote hash, size, tests, audit result, PE version, smoke result, actual-Win7 status, commit, and Release URL.
