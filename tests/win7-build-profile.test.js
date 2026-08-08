const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const rootPackage = require("../package.json");

test("Win7 profile pins the legacy runtime and is NSIS-only without mutating its input", () => {
  const { createWin7BuildProfile } = require("../win7-build-profile");
  const input = structuredClone(rootPackage);
  input.scripts.test += " tests/win7-build-profile.test.js tests/win7-build-script.test.js tests/pe-metadata.test.js";
  input.scripts["test:ci"] += " tests/win7-build-profile.test.js tests/win7-build-script.test.js tests/pe-metadata.test.js";
  input.scripts["dist:win7"] = "node scripts/build-win7.js";
  const original = JSON.stringify(input);

  const { packageJson: profile, stagingEntries } = createWin7BuildProfile(
    input,
    path.resolve(__dirname, "..")
  );

  assert.equal(profile.name, "flyingmouse-format-win7");
  assert.equal(profile.version, "0.3.2");
  assert.equal(profile.devDependencies.electron, "22.3.27");
  assert.equal(profile.dependencies.sharp, "0.32.6");
  assert.equal(profile.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(profile.build.artifactName, "FlyingMouse Format-Setup-0.3.2-win7-x64.exe");
  assert.deepEqual(profile.build.win.target, ["nsis"]);
  assert.equal(profile.build.appx, undefined);
  assert.doesNotMatch(profile.scripts.test, /win7-build-profile|win7-build-script|pe-metadata/);
  assert.doesNotMatch(profile.scripts["test:ci"], /win7-build-profile|win7-build-script|pe-metadata/);
  assert.equal(profile.scripts["dist:win7"], undefined);
  assert.ok(stagingEntries.includes("public"));
  assert.equal(JSON.stringify(input), original);
});

test("Win7 profile includes every current runtime module and absolute binary resources", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const projectRoot = path.resolve(__dirname, "..");
  const profile = createWin7Package(rootPackage, projectRoot);

  for (const file of [
    "electron-main.js",
    "electron-security.js",
    "preload.js",
    "server.js",
    "logger.js",
    "settings-store.js",
    "ncm-format.js",
    "av3a-format.js",
    "kgg-format.js"
  ]) {
    assert.ok(profile.build.files.includes(file), `missing ${file}`);
  }

  const binaryResources = profile.build.extraResources.filter((item) =>
    ["ffmpeg/ffmpeg.exe", "avs3", "libreoffice", "poppler", "tessdata"].includes(item.to)
  );
  assert.equal(binaryResources.length, 5);
  for (const resource of binaryResources) {
    assert.ok(path.isAbsolute(resource.from), `resource is not absolute: ${resource.from}`);
    assert.ok(resource.from.startsWith(path.join(projectRoot, "bin")), `resource is outside bin: ${resource.from}`);
  }

  const avs3 = binaryResources.find((item) => item.to === "avs3");
  assert.equal(avs3.from, path.join(projectRoot, "bin", "avs3"));
});

test("stage source entries contain runtime source and assets but exclude node_modules", () => {
  const { stageSourceEntries } = require("../win7-build-profile");
  const entries = stageSourceEntries(rootPackage);

  for (const entry of [
    "build",
    "tests",
    "public",
    "av3a-format.js",
    "settings-store.js",
    "ncm-format.js",
    "kgg-format.js"
  ]) {
    assert.ok(entries.includes(entry), `missing staged ${entry}`);
  }
  assert.ok(!entries.includes("node_modules"));
  assert.ok(!entries.some((entry) => entry.startsWith("node_modules/")));
});
