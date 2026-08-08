const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "build-win7.js");
const stagePath = path.join(projectRoot, "output", "win7-stage");
const rootPackagePath = path.join(projectRoot, "package.json");

function runPrepareOnly() {
  return execFileSync(process.execPath, [scriptPath, "--prepare-only"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

test("prepare-only creates a clean, current Win7 staging tree without changing the root manifest", () => {
  const beforePackage = fs.readFileSync(rootPackagePath);
  const rootNodeModules = path.join(projectRoot, "node_modules");
  const nodeModulesMtime = fs.statSync(rootNodeModules).mtimeMs;

  fs.mkdirSync(stagePath, { recursive: true });
  fs.writeFileSync(path.join(stagePath, "stale.txt"), "remove me");

  const output = runPrepareOnly();

  assert.match(output, /Win7 staging prepared:/);
  assert.match(output, /prepare-only complete/i);
  assert.match(output, new RegExp(stagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.ok(!fs.existsSync(path.join(stagePath, "stale.txt")), "old staging content survived");
  assert.deepEqual(fs.readFileSync(rootPackagePath), beforePackage, "root package.json changed");
  assert.equal(fs.statSync(rootNodeModules).mtimeMs, nodeModulesMtime, "root node_modules was written");
  assert.ok(!fs.existsSync(path.join(stagePath, "node_modules")), "node_modules was staged");

  for (const entry of [
    "public",
    "build",
    "av3a-format.js",
    "settings-store.js",
    "electron-main.js",
    "server.js"
  ]) {
    assert.ok(fs.existsSync(path.join(stagePath, entry)), `missing staged ${entry}`);
  }

  assert.deepEqual(
    fs.readFileSync(path.join(stagePath, "public", "app.js")),
    fs.readFileSync(path.join(projectRoot, "public", "app.js")),
    "staged UI is not current"
  );
  assert.deepEqual(
    fs.readFileSync(path.join(stagePath, "build", "icon.png")),
    fs.readFileSync(path.join(projectRoot, "build", "icon.png")),
    "staged build icon is not current"
  );

  const rootPackage = JSON.parse(beforePackage.toString("utf8"));
  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stagePath, "package.json"), "utf8"));
  assert.equal(rootPackage.name, "flyingmouse-format");
  assert.notEqual(stagedPackage.name, rootPackage.name);
  assert.equal(stagedPackage.dependencies.sharp, "0.32.6");
  assert.equal(stagedPackage.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(stagedPackage.devDependencies.electron, "22.3.27");
  assert.deepEqual(stagedPackage.build.win.target, ["nsis"]);
  assert.equal(stagedPackage.build.appx, undefined);
  assert.doesNotMatch(stagedPackage.scripts.test, /win7-build-script/);
  assert.doesNotMatch(stagedPackage.scripts["test:ci"], /win7-build-script/);
});

test("CLI rejects unknown arguments before preparing staging", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--surprise"], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown argument: --surprise/);
});

test("safe stage removal rejects paths outside output and paths with the wrong basename", () => {
  const { assertSafeStagePath } = require("../scripts/build-win7");

  assert.throws(
    () => assertSafeStagePath(path.join(projectRoot, "..", "win7-stage"), projectRoot),
    /must be strictly inside.*output/i
  );
  assert.throws(
    () => assertSafeStagePath(path.join(projectRoot, "output", "other-stage"), projectRoot),
    /basename must be win7-stage/i
  );
  assert.doesNotThrow(() => assertSafeStagePath(stagePath, projectRoot));
});

test("build commands run only inside staging and stop after a failed command", () => {
  const { runBuildCommands } = require("../scripts/build-win7");
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 1 ? 7 : 0 };
  };

  assert.throws(() => runBuildCommands(stagePath, runner), /npm install failed with exit code 7/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.platform === "win32" ? "npm.cmd" : "npm");
  assert.deepEqual(calls[0].args, ["install", "--no-audit", "--no-fund"]);
  assert.equal(calls[0].options.cwd, stagePath);
  assert.equal(calls[0].options.stdio, "inherit");

  calls.length = 0;
  runBuildCommands(stagePath, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["install", "--no-audit", "--no-fund"],
      ["exec", "electron-builder", "--", "--win", "nsis", "--x64"]
    ]
  );
  assert.ok(calls.every(({ options }) => options.cwd === stagePath));
});

test("artifact copying rejects a staging directory outside the project output", () => {
  const { copyWin7Artifact } = require("../scripts/build-win7");
  assert.throws(
    () =>
      copyWin7Artifact(path.join(projectRoot, "..", "win7-stage"), projectRoot, {
        productName: "FlyingMouse Format",
        version: "0.3.2"
      }),
    /must be strictly inside.*output/i
  );
});

test("artifact copying replaces only the exact Win7 installer in the root dist", (t) => {
  const { copyWin7Artifact } = require("../scripts/build-win7");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flyingmouse-win7-copy-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const stageDist = path.join(temporaryStage, "dist");
  const rootDist = path.join(temporaryRoot, "dist");
  const win7Name = "FlyingMouse Format-Setup-0.3.2-win7-x64.exe";
  const regularName = "FlyingMouse Format-Setup-0.3.2.exe";
  const stagedInstaller = Buffer.from([0x4d, 0x5a, 0x57, 0x49, 0x4e, 0x37]);
  const oldWin7Installer = Buffer.from("old Win7 installer", "utf8");
  const regularInstaller = Buffer.from([0x4d, 0x5a, 0x52, 0x45, 0x47, 0x55, 0x4c, 0x41, 0x52]);

  fs.mkdirSync(stageDist, { recursive: true });
  fs.mkdirSync(rootDist, { recursive: true });
  fs.writeFileSync(path.join(stageDist, win7Name), stagedInstaller);
  fs.writeFileSync(path.join(rootDist, win7Name), oldWin7Installer);
  fs.writeFileSync(path.join(rootDist, regularName), regularInstaller);
  const oldWin7Before = fs.readFileSync(path.join(rootDist, win7Name));
  const regularBefore = fs.readFileSync(path.join(rootDist, regularName));

  const copiedPath = copyWin7Artifact(temporaryStage, temporaryRoot, {
    productName: "FlyingMouse Format",
    version: "0.3.2"
  });

  assert.equal(copiedPath, path.join(rootDist, win7Name));
  assert.equal(path.basename(copiedPath), win7Name);
  assert.deepEqual(fs.readFileSync(copiedPath), stagedInstaller);
  assert.notDeepEqual(fs.readFileSync(copiedPath), oldWin7Before);
  assert.deepEqual(fs.readFileSync(path.join(rootDist, regularName)), regularBefore);
});
