"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { mergeUpdateMetadata } = require("../scripts/merge-mac-update-yml");

function sampleYml(arch, version) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: FlyingMouse.Format-Setup-${version}-mac-${arch}.dmg`,
    `    sha512: ${arch === "arm64" ? "AAAA" : "BBBB"}`,
    `    size: ${arch === "arm64" ? 100 : 200}`,
    `path: FlyingMouse.Format-Setup-${version}-mac-${arch}.dmg`,
    `sha512: ${arch === "arm64" ? "AAAA" : "BBBB"}`,
    "releaseDate: '2026-08-14T00:00:00.000Z'",
    ""
  ].join("\n");
}

test("merges arm64 and x64 update metadata into one latest-mac.yml", () => {
  const arm64 = sampleYml("arm64", "0.6.1");
  const x64 = sampleYml("x64", "0.6.1");
  const merged = mergeUpdateMetadata([arm64, x64]);

  assert.match(merged, /^version: 0\.6\.1$/m);
  assert.match(merged, /url: FlyingMouse\.Format-Setup-0\.6\.1-mac-arm64\.dmg/);
  assert.match(merged, /url: FlyingMouse\.Format-Setup-0\.6\.1-mac-x64\.dmg/);
  // top-level path/sha512 stay aligned with the first (arm64) entry
  assert.match(merged, /^path: FlyingMouse\.Format-Setup-0\.6\.1-mac-arm64\.dmg$/m);
  assert.match(merged, /^sha512: AAAA$/m);
  assert.match(merged, /^releaseDate: '2026-08-14T00:00:00\.000Z'$/m);
});

test("keeps a single-architecture file intact when only one is present", () => {
  const arm64 = sampleYml("arm64", "0.6.1");
  const merged = mergeUpdateMetadata([arm64]);
  assert.equal(merged, arm64);
});

test("rejects metadata without a top-level files list", () => {
  assert.throws(
    () => mergeUpdateMetadata(["version: 0.6.1\npath: x.dmg\n"]),
    /cannot locate top-level `files` list/
  );
});

test("writes and verifies merged file end-to-end", () => {
  const { main } = require("../scripts/merge-mac-update-yml");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flyingmouse-yml-"));
  try {
    fs.writeFileSync(path.join(dir, "latest-mac-arm64.yml"), sampleYml("arm64", "0.6.1"));
    fs.writeFileSync(path.join(dir, "latest-mac-x64.yml"), sampleYml("x64", "0.6.1"));

    const originalArgv = process.argv;
    process.argv = ["node", "merge-mac-update-yml.js", dir];
    try {
      main();
    } finally {
      process.argv = originalArgv;
    }

    assert.equal(fs.existsSync(path.join(dir, "latest-mac-arm64.yml")), false);
    assert.equal(fs.existsSync(path.join(dir, "latest-mac-x64.yml")), false);
    const merged = fs.readFileSync(path.join(dir, "latest-mac.yml"), "utf8");
    assert.match(merged, /url: FlyingMouse\.Format-Setup-0\.6\.1-mac-arm64\.dmg/);
    assert.match(merged, /url: FlyingMouse\.Format-Setup-0\.6\.1-mac-x64\.dmg/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
