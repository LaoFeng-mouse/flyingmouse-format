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
const rootWin7LockPath = path.join(projectRoot, "win7-package-lock.json");

function runPrepareOnly() {
  return execFileSync(process.execPath, [scriptPath, "--prepare-only"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

function createTemporaryRoot(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return temporaryRoot;
}

function createJunctionOrSkip(t, target, junction) {
  try {
    fs.symlinkSync(target, junction, "junction");
    t.after(() => {
      if (fs.lstatSync(junction, { throwIfNoEntry: false })?.isSymbolicLink()) {
        fs.unlinkSync(junction);
      }
    });
    return true;
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("junction creation is not permitted in this environment");
      return false;
    }
    throw error;
  }
}

test("prepare-only creates a clean, current Win7 staging tree without changing the root manifest", (t) => {
  const { removeWin7Stage } = require("../scripts/build-win7");
  t.after(() => {
    removeWin7Stage(stagePath, projectRoot);
    assert.ok(!fs.existsSync(stagePath), "shared Win7 stage survived test cleanup");
  });
  const beforePackage = fs.readFileSync(rootPackagePath);
  const beforeWin7Lock = fs.readFileSync(rootWin7LockPath);
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
  assert.deepEqual(fs.readFileSync(rootWin7LockPath), beforeWin7Lock, "root Win7 lock changed");
  assert.deepEqual(
    fs.readFileSync(path.join(stagePath, "package-lock.json")),
    beforeWin7Lock,
    "staged package-lock.json is not the validated dedicated Win7 lock"
  );
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
  const stagedLock = JSON.parse(fs.readFileSync(path.join(stagePath, "package-lock.json"), "utf8"));
  assert.equal(rootPackage.name, "flyingmouse-format");
  assert.notEqual(stagedPackage.name, rootPackage.name);
  assert.equal(stagedPackage.dependencies.sharp, "0.32.6");
  assert.equal(stagedPackage.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(stagedPackage.devDependencies.electron, "22.3.27");
  assert.equal(stagedLock.name, "flyingmouse-format-win7");
  assert.equal(stagedLock.version, "0.3.2");
  assert.equal(stagedLock.packages[""].devDependencies.electron, "22.3.27");
  assert.equal(stagedLock.packages[""].dependencies.sharp, "0.32.6");
  assert.equal(stagedLock.packages[""].dependencies["pdfjs-dist"], "2.16.105");
  assert.ok(stagedLock.packages["node_modules/electron-builder"]);
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

test("safe stage removal requires the exact project output Win7 stage path", () => {
  const { assertSafeStagePath } = require("../scripts/build-win7");

  assert.throws(
    () => assertSafeStagePath(path.join(projectRoot, "..", "win7-stage"), projectRoot),
    /must be strictly inside.*output/i
  );
  assert.throws(
    () => assertSafeStagePath(path.join(projectRoot, "output", "other-stage"), projectRoot),
    /basename must be win7-stage/i
  );
  assert.throws(
    () =>
      assertSafeStagePath(
        path.join(projectRoot, "output", "nested", "win7-stage"),
        projectRoot
      ),
    /must exactly match.*output.*win7-stage/i
  );
  assert.doesNotThrow(() => assertSafeStagePath(stagePath, projectRoot));
});

test("build commands use only the installed local builder and stop after a failed command", (t) => {
  const { runBuildCommands } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-commands-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const npmCliPath = path.join(temporaryRoot, "tools", "npm-cli.js");
  fs.mkdirSync(temporaryStage, { recursive: true });
  fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
  fs.writeFileSync(npmCliPath, "local npm CLI");
  const stagedPackage = {
    name: "flyingmouse-format-win7",
    version: "0.3.2",
    dependencies: { sharp: "0.32.6" },
    devDependencies: { electron: "22.3.27" },
    build: { extraResources: [] }
  };
  const stagedLock = {
    name: stagedPackage.name,
    version: stagedPackage.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: stagedPackage.name,
        version: stagedPackage.version,
        dependencies: stagedPackage.dependencies,
        devDependencies: stagedPackage.devDependencies
      }
    }
  };
  fs.writeFileSync(path.join(temporaryStage, "package.json"), JSON.stringify(stagedPackage));
  fs.writeFileSync(path.join(temporaryStage, "package-lock.json"), JSON.stringify(stagedLock));
  const buildOptions = {
    npmCliPath,
    projectRoot: temporaryRoot,
    packageJson: stagedPackage
  };
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 1 ? 7 : 0 };
  };

  assert.throws(
    () => runBuildCommands(temporaryStage, runner, buildOptions),
    /npm ci failed with exit code 7/i
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [npmCliPath, "ci", "--no-audit", "--no-fund"]);
  assert.equal(calls[0].options.cwd, temporaryStage);
  assert.equal(calls[0].options.stdio, "inherit");

  calls.length = 0;
  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
        buildOptions
      ),
    /local electron-builder executable was not installed/i
  );
  assert.equal(calls.length, 1, "builder ran despite a missing local executable");

  calls.length = 0;
  runBuildCommands(temporaryStage, (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) {
      const localBuilder = path.join(
        temporaryStage,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
      );
      fs.mkdirSync(path.dirname(localBuilder), { recursive: true });
      fs.writeFileSync(localBuilder, "local builder");
      const localBuilderCli = path.join(
        temporaryStage,
        "node_modules",
        "electron-builder",
        "out",
        "cli",
        "cli.js"
      );
      fs.mkdirSync(path.dirname(localBuilderCli), { recursive: true });
      fs.writeFileSync(localBuilderCli, "local builder CLI");
    }
    return { status: 0 };
  }, buildOptions);
  const expectedLocalBuilder = path.join(
    temporaryStage,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
  );
  assert.ok(fs.statSync(expectedLocalBuilder).isFile());
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, [
    path.join(temporaryStage, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--win",
    "nsis",
    "--x64"
  ]);
  assert.ok(calls.every(({ options }) => options.cwd === temporaryStage));

  calls.length = 0;
  const missingResourcePackage = {
    ...stagedPackage,
    build: {
      extraResources: [{ from: path.join(temporaryRoot, "bin", "missing.exe"), to: "missing.exe" }]
    }
  };
  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
        { ...buildOptions, packageJson: missingResourcePackage }
      ),
    /extraResources\[0\].*does not exist/i
  );
  assert.equal(calls.length, 1, "electron-builder ran before extraResources validation");
});

test("Win7 lock validation fails closed before npm when the lock is missing or mismatched", (t) => {
  const { runBuildCommands, validateWin7Lockfile } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-lock-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const npmCliPath = path.join(temporaryRoot, "npm-cli.js");
  const packageJson = {
    name: "flyingmouse-format-win7",
    version: "0.3.2",
    dependencies: { sharp: "0.32.6", "pdfjs-dist": "2.16.105" },
    devDependencies: { electron: "22.3.27", "electron-builder": "^26.15.3" },
    build: { extraResources: [] }
  };
  const validLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: structuredClone(packageJson.dependencies),
        devDependencies: structuredClone(packageJson.devDependencies)
      }
    }
  };
  fs.mkdirSync(temporaryStage, { recursive: true });
  fs.writeFileSync(npmCliPath, "npm CLI");

  assert.doesNotThrow(() => validateWin7Lockfile(validLock, packageJson, "synthetic lock"));
  const mismatchedLock = structuredClone(validLock);
  mismatchedLock.packages[""].dependencies.sharp = "0.31.0";
  assert.throws(
    () => validateWin7Lockfile(mismatchedLock, packageJson, "synthetic lock"),
    /dependencies.*sharp|sharp.*mismatch/i
  );

  const calls = [];
  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (...args) => {
          calls.push(args);
          return { status: 0 };
        },
        { npmCliPath, projectRoot: temporaryRoot, packageJson }
      ),
    /Win7 package lock.*missing/i
  );
  assert.equal(calls.length, 0, "npm ran before the missing lock was rejected");

  fs.writeFileSync(path.join(temporaryStage, "package-lock.json"), JSON.stringify(mismatchedLock));
  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (...args) => {
          calls.push(args);
          return { status: 0 };
        },
        { npmCliPath, projectRoot: temporaryRoot, packageJson }
      ),
    /dependencies.*sharp|sharp.*mismatch/i
  );
  assert.equal(calls.length, 0, "npm ran before the mismatched lock was rejected");
});

test("extraResources validation accepts controlled paths and rejects external junctions", (t) => {
  const { validateExtraResources } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-resources-root-");
  const externalRoot = createTemporaryRoot(t, "flyingmouse-win7-resources-target-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const binRoot = path.join(temporaryRoot, "bin");
  const safeFile = path.join(binRoot, "safe-tool.exe");
  const safeDirectory = path.join(binRoot, "safe-directory");
  const relativeResource = path.join(temporaryStage, "node_modules", "safe-package", "asset.dat");
  fs.mkdirSync(safeDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(relativeResource), { recursive: true });
  fs.writeFileSync(safeFile, "safe tool");
  fs.writeFileSync(path.join(safeDirectory, "asset.dat"), "safe asset");
  fs.writeFileSync(relativeResource, "safe staged asset");

  assert.doesNotThrow(() =>
    validateExtraResources(
      [
        { from: safeFile, to: "safe-tool.exe" },
        { from: safeDirectory, to: "safe-directory" },
        { from: "node_modules/safe-package/asset.dat", to: "relative-asset.dat" }
      ],
      temporaryRoot,
      temporaryStage
    )
  );

  const externalSentinel = path.join(externalRoot, "do-not-touch.txt");
  fs.writeFileSync(externalSentinel, "external content");
  const directJunction = path.join(binRoot, "direct-junction");
  if (!createJunctionOrSkip(t, externalRoot, directJunction)) return;
  assert.throws(
    () => validateExtraResources([{ from: directJunction, to: "unsafe" }], temporaryRoot, temporaryStage),
    /extraResources.*reparse|reparse.*extraResources/i
  );
  assert.equal(fs.readFileSync(externalSentinel, "utf8"), "external content");
  fs.unlinkSync(directJunction);

  const nestedParent = path.join(binRoot, "nested-parent");
  fs.mkdirSync(nestedParent);
  const nestedJunction = path.join(nestedParent, "nested-junction");
  if (!createJunctionOrSkip(t, externalRoot, nestedJunction)) return;
  assert.throws(
    () => validateExtraResources([{ from: nestedParent, to: "unsafe-nested" }], temporaryRoot, temporaryStage),
    /extraResources.*reparse|reparse.*extraResources/i
  );
  assert.equal(fs.readFileSync(externalSentinel, "utf8"), "external content");
  fs.unlinkSync(nestedJunction);
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
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-copy-");

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
  assert.ok(!fs.readdirSync(rootDist).some((name) => name.includes(".win7-build-")));
});

test("artifact copying restores the previous Win7 installer when promotion fails", (t) => {
  const { copyWin7Artifact } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-rollback-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const stageDist = path.join(temporaryStage, "dist");
  const rootDist = path.join(temporaryRoot, "dist");
  const win7Name = "FlyingMouse Format-Setup-0.3.2-win7-x64.exe";
  const regularName = "FlyingMouse Format-Setup-0.3.2.exe";
  const oldWin7 = Buffer.from("recover this installer", "utf8");
  const regularBefore = Buffer.from("ordinary installer stays", "utf8");

  fs.mkdirSync(stageDist, { recursive: true });
  fs.mkdirSync(rootDist, { recursive: true });
  fs.writeFileSync(path.join(stageDist, win7Name), "new installer");
  fs.writeFileSync(path.join(rootDist, win7Name), oldWin7);
  fs.writeFileSync(path.join(rootDist, regularName), regularBefore);

  let renameCalls = 0;
  assert.throws(
    () =>
      copyWin7Artifact(
        temporaryStage,
        temporaryRoot,
        { productName: "FlyingMouse Format", version: "0.3.2" },
        {
          renameSync(source, destination) {
            renameCalls += 1;
            if (renameCalls === 2) throw new Error("simulated promote failure");
            fs.renameSync(source, destination);
          }
        }
      ),
    /simulated promote failure/
  );

  assert.deepEqual(fs.readFileSync(path.join(rootDist, win7Name)), oldWin7);
  assert.deepEqual(fs.readFileSync(path.join(rootDist, regularName)), regularBefore);
  assert.ok(!fs.readdirSync(rootDist).some((name) => name.includes(".win7-build-")));
});

test("stage cleanup rejects output and stage junctions without touching their targets", (t) => {
  const { removeWin7Stage } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-junction-root-");
  const externalRoot = createTemporaryRoot(t, "flyingmouse-win7-junction-target-");
  const externalStage = path.join(externalRoot, "win7-stage");
  const sentinel = path.join(externalStage, "do-not-delete.txt");
  fs.mkdirSync(externalStage, { recursive: true });
  fs.writeFileSync(sentinel, "external content");

  const outputJunction = path.join(temporaryRoot, "output");
  if (!createJunctionOrSkip(t, externalRoot, outputJunction)) return;
  assert.throws(
    () => removeWin7Stage(path.join(outputJunction, "win7-stage"), temporaryRoot),
    /output.*reparse|reparse.*output/i
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
  fs.unlinkSync(outputJunction);

  const output = path.join(temporaryRoot, "output");
  fs.mkdirSync(output);
  const stageJunction = path.join(output, "win7-stage");
  if (!createJunctionOrSkip(t, externalStage, stageJunction)) return;
  assert.throws(() => removeWin7Stage(stageJunction, temporaryRoot), /stage.*reparse|reparse.*stage/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
  fs.unlinkSync(stageJunction);
});

test("staging rejects a recursive source junction without copying external content", (t) => {
  const { copyStagingEntry } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-source-root-");
  const externalRoot = createTemporaryRoot(t, "flyingmouse-win7-source-target-");
  const source = path.join(temporaryRoot, "public");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  fs.mkdirSync(source);
  fs.mkdirSync(temporaryStage, { recursive: true });
  fs.writeFileSync(path.join(externalRoot, "do-not-copy.txt"), "external content");
  const sourceJunction = path.join(source, "outside");
  if (!createJunctionOrSkip(t, externalRoot, sourceJunction)) return;

  assert.throws(
    () => copyStagingEntry("public", temporaryRoot, temporaryStage),
    /reparse point.*public|public.*reparse point/i
  );
  assert.ok(!fs.existsSync(path.join(temporaryStage, "public")));
  fs.unlinkSync(sourceJunction);
});

test("artifact copying rejects a root dist junction without touching external files", (t) => {
  const { copyWin7Artifact } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-dist-root-");
  const externalRoot = createTemporaryRoot(t, "flyingmouse-win7-dist-target-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const win7Name = "FlyingMouse Format-Setup-0.3.2-win7-x64.exe";
  const sentinel = path.join(externalRoot, "do-not-overwrite.txt");
  fs.mkdirSync(path.join(temporaryStage, "dist"), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(temporaryStage, "dist", win7Name), "new installer");
  fs.writeFileSync(sentinel, "external content");
  fs.rmdirSync(path.join(temporaryRoot, "dist"));
  const distJunction = path.join(temporaryRoot, "dist");
  if (!createJunctionOrSkip(t, externalRoot, distJunction)) return;

  assert.throws(
    () =>
      copyWin7Artifact(temporaryStage, temporaryRoot, {
        productName: "FlyingMouse Format",
        version: "0.3.2"
      }),
    /root dist.*reparse|reparse.*root dist/i
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
  fs.unlinkSync(distJunction);
});

test("root test scripts include both Win7 builder-only test files", () => {
  const packageJson = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  for (const scriptName of ["test", "test:ci"]) {
    assert.match(packageJson.scripts[scriptName], /tests\/win7-build-profile\.test\.js/);
    assert.match(packageJson.scripts[scriptName], /tests\/win7-build-script\.test\.js/);
  }
});
