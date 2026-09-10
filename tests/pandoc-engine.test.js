const assert = require("node:assert/strict");
const { test } = require("node:test");
const { selectAsset, verifyArchive } = require("../scripts/restore-pandoc");

test("Pandoc restoration rejects an altered archive before extraction", () => {
  assert.throws(() => verifyArchive(Buffer.from("damaged release"), selectAsset("win32", "x64")), /SHA-256 mismatch/);
  assert.throws(() => selectAsset("win32", "ia32"), /No locked/);
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    assert.match(selectAsset(platform, arch).sha256, /^[a-f0-9]{64}$/);
  }
});
