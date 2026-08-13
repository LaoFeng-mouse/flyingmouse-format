const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const rootPackage = require("../package.json");

function resolveArtifactName(profile) {
  return profile.build.artifactName
    .replace("${productName}", profile.productName)
    .replace("${version}", profile.version)
    .replace("${arch}", "x64")
    .replace("${ext}", "exe");
}

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
  assert.equal(profile.version, rootPackage.version);
  assert.equal(profile.devDependencies.electron, "22.3.27");
  assert.equal(profile.dependencies.sharp, "0.32.6");
  assert.equal(profile.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(profile.dependencies.turndown, "7.2.0");
  assert.equal(profile.build.artifactName, "${productName}-Setup-${version}-win7-${arch}.${ext}");
  assert.equal(
    resolveArtifactName(profile),
    `FlyingMouse Format-Setup-${rootPackage.version}-win7-x64.exe`
  );
  assert.deepEqual(profile.build.win.target, ["nsis"]);
  assert.equal(profile.build.win.extraResources, undefined);
  assert.equal(profile.build.mac, undefined);
  assert.equal(profile.build.appx, undefined);
  assert.doesNotMatch(profile.scripts.test, /win7-build-profile|win7-build-script|pe-metadata/);
  assert.doesNotMatch(profile.scripts["test:ci"], /win7-build-profile|win7-build-script|pe-metadata/);
  assert.doesNotMatch(profile.scripts.test, /tests\/conversion\.test|ci-engine-release/);
  assert.doesNotMatch(profile.scripts["test:ci"], /tests\/conversion\.test|ci-engine-release/);
  assert.equal(profile.scripts["dist:win7"], undefined);
  assert.ok(stagingEntries.includes("public"));
  assert.equal(JSON.stringify(input), original);
});

test("Win7 artifact name follows a non-current input version", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const input = structuredClone(rootPackage);
  input.version = "9.8.7";

  const profile = createWin7Package(input, path.resolve(__dirname, ".."));

  assert.equal(profile.build.artifactName, "${productName}-Setup-${version}-win7-${arch}.${ext}");
  assert.equal(resolveArtifactName(profile), "FlyingMouse Format-Setup-9.8.7-win7-x64.exe");
  assert.doesNotMatch(profile.build.artifactName, /0\.3\.2/);
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
    "office-engine.js",
    "ncm-format.js",
    "ncm-metadata.js",
    "av3a-format.js",
    "kgg-format.js",
    "mflac-format.js",
    "kgma-format.js",
    "config.js",
    "utils.js",
    "media.js",
    "zip-util.js",
    "image.js",
    "ocr.js",
    "pdfjs.js",
    "pdf-table.js",
    "pdf.js",
    "text-docx.js",
    "office-convert.js"
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

  // pdf2docx（Python 3.12）不支持 Windows 7，win7 版必须排除，PDF→docx 回退到文字提取。
  assert.ok(
    !profile.build.extraResources.some((item) => item.to === "pdf2docx"),
    "win7 must exclude the pdf2docx engine"
  );
});

test("stage source entries contain runtime source and assets but exclude node_modules", () => {
  const { stageSourceEntries } = require("../win7-build-profile");
  const entries = stageSourceEntries(rootPackage);

  for (const entry of [
    "build",
    "tests",
    "win7-build-profile.js",
    "public",
    "av3a-format.js",
    "settings-store.js",
    "office-engine.js",
    "ncm-format.js",
    "kgg-format.js",
    "mflac-format.js",
    "kgma-format.js"
  ]) {
    assert.ok(entries.includes(entry), `missing staged ${entry}`);
  }
  assert.ok(!entries.includes("node_modules"));
  assert.ok(!entries.some((entry) => entry.startsWith("node_modules/")));
});

test("derived package and staging entries restore a missing required runtime module", () => {
  const { createWin7BuildProfile } = require("../win7-build-profile");
  const input = structuredClone(rootPackage);
  input.build.files = input.build.files.filter((entry) => entry !== "logger.js");

  const { packageJson, stagingEntries } = createWin7BuildProfile(
    input,
    path.resolve(__dirname, "..")
  );

  assert.ok(packageJson.build.files.includes("logger.js"));
  assert.ok(stagingEntries.includes("logger.js"));
});

test("test script filtering rejects shell syntax and unknown command forms", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const unsafeCommands = [
    "node --test tests/i18n.test.js && echo unsafe",
    "node --test tests/i18n.test.js || exit 1",
    "node --test tests/i18n.test.js; echo unsafe",
    "node --test tests/i18n.test.js | more",
    "node --test tests/i18n.test.js > result.txt",
    "node --test \"tests/i18n.test.js\"",
    "node --test tests/../outside.test.js",
    "npm exec node --test tests/i18n.test.js"
  ];

  for (const command of unsafeCommands) {
    const input = structuredClone(rootPackage);
    input.scripts.test = command;
    assert.throws(
      () => createWin7Package(input, path.resolve(__dirname, "..")),
      /scripts\.test must use the form node --test <test files>/
    );
  }
});

test("profile validation reports missing required manifest fields", () => {
  const { createWin7Package } = require("../win7-build-profile");
  const projectRoot = path.resolve(__dirname, "..");
  const invalidInputs = [
    [(input) => delete input.dependencies, /dependencies must be an object/],
    [(input) => delete input.devDependencies, /devDependencies must be an object/],
    [(input) => delete input.scripts, /scripts must be an object/],
    [(input) => delete input.scripts.test, /scripts\.test must be a string/],
    [(input) => delete input.scripts["test:ci"], /scripts\.test:ci must be a string/],
    [(input) => delete input.build.win, /build\.win must be an object/],
    [
      (input) => delete input.build.win.extraResources[0].from,
      /build\.win\.extraResources\[0\]\.from must be a string/
    ]
  ];

  for (const [invalidate, expected] of invalidInputs) {
    const input = structuredClone(rootPackage);
    invalidate(input);

    assert.throws(() => createWin7Package(input, projectRoot), expected);
  }
});
