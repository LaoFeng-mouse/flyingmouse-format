"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

test("ci-engines-v1 pins one immutable bundle and required engine files", () => {
  const manifest = require("../ci-engines-v1.json");
  assert.equal(manifest.version, "ci-engines-v1");
  assert.equal(manifest.releaseTag, "ci-engines-v1");
  assert.equal(manifest.assetName, "ci-engines-v1.tar.zst");
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  for (const fragment of ["ffmpeg.exe", "pdftoppm.exe", "soffice.com", "eng.traineddata.gz", "chi_sim.traineddata.gz"]) {
    assert.ok(manifest.requiredFiles.some((entry) => entry.endsWith(fragment)), `missing ${fragment}`);
  }
});

test("engine restore validates SHA-256 before extracting and checks every required file", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "restore-ci-engines.ps1"), "utf8");
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /actualHash[\s\S]*expectedHash/);
  assert.ok(source.indexOf("SHA-256 mismatch") < source.indexOf("& tar -xf"));
  assert.match(source, /manifest\.requiredFiles/);
  assert.match(source, /ci-engines-v1-stage/);
  assert.match(source, /Test-Path[\s\S]*gh release download/);
});

test("release workflow restores engines, runs full conversion tests and builds both installers", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  for (const command of ["restore-ci-engines.ps1", "npm test", "npm audit --omit=dev", "npm run dist", "npm run dist:win7"]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(workflow, /actions\/cache@v4/);
  assert.match(workflow, /ci-engines-v1\.tar\.zst/);
  const packageJson = require("../package.json");
  assert.ok(packageJson.build.files.includes("ci-engines-v1.json"));
  assert.match(packageJson.scripts.dist, /--publish never/);
  const jobHeader = workflow.slice(workflow.indexOf("jobs:"), workflow.indexOf("    steps:"));
  assert.doesNotMatch(jobHeader, /GH_TOKEN/);
  assert.match(workflow, /Restore fixed conversion engines[\s\S]*?GH_TOKEN:[\s\S]*?restore-ci-engines\.ps1/);
  // 云端发布：下载产物 → 创建 Release → 上传资产 → 设 Latest（contents: write）
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /--draft=false --latest/);
  assert.match(workflow, /contents: write/);
});

test("Windows release restores and validates docstructure before probe, conversion tests and build", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const restore = workflow.indexOf("Restore fixed conversion engines");
  const validate = workflow.indexOf("Validate locked document structure engine");
  const probe = workflow.indexOf("Probe document structure engine");
  const conversion = workflow.indexOf("Full real conversion suite");
  const build = workflow.indexOf("Build Windows 10 and 11 installer");
  assert.ok(restore >= 0 && restore < validate && validate < probe && probe < conversion && conversion < build);
  assert.match(workflow.slice(validate, conversion), /docstructure-engine-lock\.json/);
  assert.match(workflow.slice(probe, conversion), /docstructure-engine\.exe/);
});

test("CI engine manifest and restore script include the locked docstructure one-folder tree", () => {
  const manifest = require("../ci-engines-v1.json");
  const windows = manifest.assets["win32-x64"];
  assert.ok(windows.requiredFiles.includes("docstructure/docstructure-engine.exe"));
  assert.ok(windows.requiredFiles.some((entry) => entry.startsWith("docstructure/models/")));

  const restore = fs.readFileSync(path.join(root, "scripts", "restore-ci-engines.ps1"), "utf8");
  assert.match(restore, /"docstructure"/);
  assert.match(restore, /docstructure-engine-lock\.json/);
  assert.match(restore, /lock-docstructure-engine\.js[\s\S]*--verify/);
  assert.ok(restore.indexOf("--verify") < restore.indexOf("Move-Item"));
});
