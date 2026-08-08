const path = require("node:path");

const BUILDER_ONLY_TESTS = new Set([
  "tests/win7-build-profile.test.js",
  "tests/win7-build-script.test.js",
  "tests/pe-metadata.test.js"
]);

const REQUIRED_RUNTIME_FILES = [
  "electron-main.js",
  "electron-security.js",
  "preload.js",
  "server.js",
  "logger.js",
  "settings-store.js",
  "ncm-format.js",
  "av3a-format.js",
  "kgg-format.js"
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function removeBuilderOnlyTests(command) {
  return command
    .split(/\s+/)
    .filter((part) => !BUILDER_ONLY_TESTS.has(part))
    .join(" ");
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

  for (const scriptName of ["test", "test:ci"]) {
    profile.scripts[scriptName] = removeBuilderOnlyTests(profile.scripts[scriptName]);
  }
  delete profile.scripts["dist:win7"];

  for (const file of REQUIRED_RUNTIME_FILES) {
    if (!profile.build.files.includes(file)) profile.build.files.push(file);
  }
  profile.build.artifactName = "FlyingMouse Format-Setup-0.3.2-win7-x64.exe";
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
  if (!basePackage?.build?.files) {
    throw new Error("Base package is missing electron-builder files.");
  }

  const entries = new Set(["build", "tests"]);
  for (const pattern of basePackage.build.files) {
    if (pattern === "node_modules" || pattern.startsWith("node_modules/")) continue;
    if (pattern.endsWith("/**/*")) {
      entries.add(pattern.slice(0, -5));
    } else {
      entries.add(pattern);
    }
  }
  entries.delete("package.json");
  return [...entries].sort();
}

function createWin7BuildProfile(basePackage, projectRoot) {
  return {
    packageJson: createWin7Package(basePackage, projectRoot),
    stagingEntries: stageSourceEntries(basePackage)
  };
}

module.exports = { createWin7BuildProfile, createWin7Package, stageSourceEntries };
