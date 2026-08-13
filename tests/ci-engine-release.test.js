"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const releaseNotesResolver = path.join(root, "scripts", "resolve-release-notes.js");

function withReleaseNotesFixture(files, callback) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flyingmouse-release-notes-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(fixtureRoot, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    }
    callback(fixtureRoot);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("release notes resolver preserves the markdown extension", () => {
  withReleaseNotesFixture({ "docs/release-notes-050.md": "# v0.5.0" }, (fixtureRoot) => {
    const result = spawnSync(process.execPath, [releaseNotesResolver, "v0.5.0", fixtureRoot], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "docs/release-notes-050.md");
  });
});

test("release notes resolver falls back to the release guide", () => {
  withReleaseNotesFixture({ "docs/RELEASE.md": "# Release guide" }, (fixtureRoot) => {
    const result = spawnSync(process.execPath, [releaseNotesResolver, "v9.8.7", fixtureRoot], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "docs/RELEASE.md");
  });
});

test("release notes resolver rejects malformed tags", () => {
  withReleaseNotesFixture({}, (fixtureRoot) => {
    const result = spawnSync(process.execPath, [releaseNotesResolver, "release/0.5.0", fixtureRoot], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid release tag/);
  });
});

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
  assert.match(workflow, /node scripts\/resolve-release-notes\.js "\$TAG"/);
  assert.ok(!workflow.includes('NOTES="${NOTES//./}"'));
});
