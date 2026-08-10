"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

test("electron-builder declares exact unsigned macOS 11 DMGs without Windows resources", () => {
  const packageJson = require("../package.json");
  const build = packageJson.build;
  assert.ok(build.files.includes("runtime-paths.js"));
  assert.equal(build.extraResources, undefined);
  assert.equal(build.mac.artifactName, "${productName}-Setup-${version}-mac-${arch}.${ext}");
  assert.equal(build.mac.minimumSystemVersion, "11.0.0");
  assert.equal(build.mac.identity, null);
  assert.equal(build.mac.notarize, false);
  assert.deepEqual(build.mac.target, [{ target: "dmg", arch: ["arm64", "x64"] }]);

  const macResources = JSON.stringify(build.mac.extraResources);
  assert.match(macResources, /darwin-\$\{arch\}/);
  assert.doesNotMatch(macResources, /\.exe|soffice\.com|avs3/i);

  const windowsResources = JSON.stringify(build.win.extraResources);
  assert.match(windowsResources, /ffmpeg\.exe/);
  assert.match(windowsResources, /avs3/i);
  for (const arch of ["arm64", "x64"]) {
    assert.match(packageJson.scripts[`dist:mac:${arch}`], new RegExp(`validate-ci-engines\\.js --platform darwin --arch ${arch}`));
    assert.match(packageJson.scripts[`dist:mac:${arch}`], new RegExp(`electron-builder --mac dmg --${arch} --publish never`));
  }
});

test("manifest accepts only an explicit bootstrap or SHA-pinned macOS asset state", () => {
  const manifest = require("../ci-engines-v1.json");
  for (const arch of ["arm64", "x64"]) {
    const asset = manifest.assets[`darwin-${arch}`];
    if (asset.available) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    else assert.equal(asset.sha256, null);
    assert.equal(asset.assetName, `ci-engines-v1-darwin-${arch}.tar.zst`);
    for (const required of [
      "runtime/bin/ffmpeg",
      "libreoffice/LibreOffice.app/Contents/MacOS/soffice",
      "runtime/bin/pdftoppm",
      "tessdata/eng.traineddata.gz",
      "tessdata/chi_sim.traineddata.gz"
    ]) {
      assert.ok(asset.requiredFiles.includes(required), `${arch} missing ${required}`);
    }
    assert.doesNotMatch(JSON.stringify(asset), /\.exe|soffice\.com|avs3/i);
  }
});

test("engine validator fails closed for unpinned assets and unsafe required paths", () => {
  const { selectEngineAsset, validateAssetDefinition } = require("../scripts/validate-ci-engines");
  const manifest = require("../ci-engines-v1.json");
  assert.throws(
    () => selectEngineAsset(manifest, "darwin", "arm64"),
    /not yet pinned.*darwin-arm64/i
  );
  assert.doesNotThrow(() => validateAssetDefinition("darwin-arm64", manifest.assets["darwin-arm64"]));
  assert.throws(
    () => validateAssetDefinition("darwin-arm64", {
      available: true,
      assetName: "engines.tar.zst",
      sha256: "a".repeat(64),
      requiredFiles: ["../escape"]
    }),
    /unsafe required file/i
  );
  assert.throws(
    () => validateAssetDefinition("darwin-arm64", {
      available: true,
      assetName: "engines.tar.zst",
      sha256: null,
      requiredFiles: ["ffmpeg/ffmpeg"]
    }),
    /valid SHA-256/i
  );
  assert.throws(
    () => validateAssetDefinition("darwin-arm64", {
      available: false,
      assetName: "ci-engines-v1-darwin-arm64.tar.zst",
      sha256: null,
      requiredFiles: ["../escape"]
    }),
    /unsafe required file/i
  );
});

test("engine validator checks real hashes, files, and symlink containment", (t) => {
  const { validateEngineDirectory } = require("../scripts/validate-ci-engines");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flyingmouse-mac-engine-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, "ffmpeg"), { recursive: true });
  fs.writeFileSync(path.join(temp, "ffmpeg", "ffmpeg"), "binary");
  const asset = {
    available: true,
    assetName: "engines.tar.zst",
    sha256: "a".repeat(64),
    requiredFiles: ["ffmpeg/ffmpeg"]
  };
  assert.doesNotThrow(() => validateEngineDirectory(temp, asset));

  const outside = path.join(path.dirname(temp), `${path.basename(temp)}-outside`);
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));
  const link = path.join(temp, "ffmpeg", "escaped");
  try {
    fs.symlinkSync(outside, link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) return;
    throw error;
  }
  assert.throws(
    () => validateEngineDirectory(temp, { ...asset, requiredFiles: ["ffmpeg/escaped"] }),
    /symbolic link|outside/i
  );
});

test("engine validator rejects a wrong thin Mach-O architecture and accepts the requested one", (t) => {
  const { validateMachOArchitecture } = require("../scripts/validate-ci-engines");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flyingmouse-macho-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const binary = path.join(temp, "engine");
  const thinX64 = Buffer.alloc(32);
  thinX64.writeUInt32LE(0xfeedfacf, 0);
  thinX64.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(binary, thinX64);
  assert.doesNotThrow(() => validateMachOArchitecture(binary, "x64"));
  assert.throws(() => validateMachOArchitecture(binary, "arm64"), /does not contain arm64/i);

  const thinArm64 = Buffer.from(thinX64);
  thinArm64.writeUInt32LE(0x0100000c, 4);
  fs.writeFileSync(binary, thinArm64);
  assert.doesNotThrow(() => validateMachOArchitecture(binary, "arm64"));
  assert.throws(() => validateMachOArchitecture(binary, "x64"), /does not contain x64/i);
});

test("macOS engine preparation uses native arm64 and Intel runners and validates portable engines", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "prepare-macos-engines.yml"), "utf8");
  assert.match(workflow, /macos-26\b/);
  assert.match(workflow, /macos-26-intel/);
  assert.match(workflow, /process\.arch/);
  assert.match(workflow, /micromamba create/);
  assert.match(workflow, /ffmpeg poppler/);
  assert.match(workflow, /brew install --cask libreoffice/);
  assert.match(workflow, /node scripts\/validate-ci-engines\.js/);
  assert.match(workflow, /file .*runtime\/bin\/(?:ffmpeg|pdftoppm)/);
  assert.match(workflow, /sha256/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /gh release upload ci-engines-v1/);
});

test("CI and release workflows declare native macOS quality and DMG gates", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  for (const workflow of [ci, release]) {
    assert.match(workflow, /macos-26\b/);
    assert.match(workflow, /macos-26-intel/);
    assert.match(workflow, /process\.arch/);
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /validate-ci-engines\.js/);
    assert.match(workflow, /npm test/);
  }
  assert.match(release, /npm run dist:mac:\$\{\{ matrix\.arch \}\}/);
  assert.match(release, /hdiutil attach/);
  assert.match(release, /file .*\.app\/Contents\/MacOS/);
  assert.match(release, /codesign --verify/);
  assert.match(release, /actions\/upload-artifact@v4/);
});
