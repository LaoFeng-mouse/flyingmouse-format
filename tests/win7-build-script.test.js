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
const supportedBuildNodeVersion = "22.22.0";

function runPrepareOnly() {
  return execFileSync(process.execPath, [scriptPath, "--prepare-only"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

function readPathEnvironment(environment) {
  return Object.entries(environment).find(([name]) => name.toLowerCase() === "path")?.[1];
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
  const { prepareWin7Stage, removeWin7Stage } = require("../scripts/build-win7");
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

  const currentNodeMajor = Number(process.versions.node.split(".")[0]);
  if (currentNodeMajor >= 18 && currentNodeMajor <= 22) {
    const output = runPrepareOnly();
    assert.match(output, /Win7 staging prepared:/);
    assert.match(output, /prepare-only complete/i);
    assert.match(output, new RegExp(stagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  } else {
    prepareWin7Stage(projectRoot, { nodeVersion: supportedBuildNodeVersion });
  }
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
  const rootWin7Lock = JSON.parse(beforeWin7Lock.toString("utf8"));
  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stagePath, "package.json"), "utf8"));
  const stagedLock = JSON.parse(fs.readFileSync(path.join(stagePath, "package-lock.json"), "utf8"));
  assert.equal(rootPackage.name, "flyingmouse-format");
  assert.notEqual(stagedPackage.name, rootPackage.name);
  assert.equal(stagedPackage.dependencies.sharp, "0.32.6");
  assert.equal(stagedPackage.dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(stagedPackage.devDependencies.electron, "22.3.27");
  assert.equal(stagedLock.name, "flyingmouse-format-win7");
  assert.equal(stagedLock.version, rootWin7Lock.version);
  assert.equal(stagedLock.packages[""].devDependencies.electron, "22.3.27");
  assert.equal(stagedLock.packages[""].dependencies.sharp, "0.32.6");
  assert.equal(stagedLock.packages[""].dependencies["pdfjs-dist"], "2.16.105");
  assert.equal(stagedLock.packages[""].dependencies.turndown, "7.2.0");
  assert.equal(stagedLock.packages["node_modules/turndown"].version, "7.2.0");
  assert.equal(stagedLock.packages["node_modules/turndown"].engines, undefined);
  assert.ok(stagedLock.packages["node_modules/electron-builder"]);
  assert.deepEqual(stagedPackage.build.win.target, ["nsis"]);
  assert.equal(stagedPackage.build.appx, undefined);
  assert.doesNotMatch(stagedPackage.scripts.test, /win7-build-script/);
  assert.doesNotMatch(stagedPackage.scripts["test:ci"], /win7-build-script/);
  assert.doesNotMatch(stagedPackage.scripts.test, /tests\/conversion\.test|ci-engine-release/);
  assert.doesNotMatch(stagedPackage.scripts["test:ci"], /tests\/conversion\.test|ci-engine-release/);
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

test("Win7 child environment binds lifecycle Node without mutating inherited variables", () => {
  const { createWin7ChildEnv } = require("../scripts/build-win7");
  const nodeExecutable = path.join(projectRoot, "portable-node", "node.exe");
  const inheritedWithMixedCasePath = {
    Path: ["legacy-one", "legacy-two"].join(path.delimiter),
    KEEP_ME: "unchanged"
  };
  const inheritedBefore = structuredClone(inheritedWithMixedCasePath);

  const childEnvironment = createWin7ChildEnv(
    nodeExecutable,
    inheritedWithMixedCasePath
  );

  assert.notStrictEqual(childEnvironment, inheritedWithMixedCasePath);
  assert.deepEqual(inheritedWithMixedCasePath, inheritedBefore);
  assert.equal(
    readPathEnvironment(childEnvironment),
    [path.dirname(nodeExecutable), inheritedWithMixedCasePath.Path].join(path.delimiter)
  );
  assert.equal(childEnvironment.npm_node_execpath, nodeExecutable);
  assert.equal(childEnvironment.NODE, nodeExecutable);
  assert.equal(childEnvironment.KEEP_ME, "unchanged");
  assert.equal(Object.keys(childEnvironment).filter((name) => name.toLowerCase() === "path").length, 1);

  const withoutInheritedPath = { KEEP_ME: "still here" };
  assert.equal(
    readPathEnvironment(createWin7ChildEnv(nodeExecutable, withoutInheritedPath)),
    path.dirname(nodeExecutable)
  );
  assert.deepEqual(withoutInheritedPath, { KEEP_ME: "still here" });
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
    nodeVersion: supportedBuildNodeVersion,
    projectRoot: temporaryRoot,
    packageJson: stagedPackage
  };
  const calls = [];
  const processEnvironmentBefore = {
    path: readPathEnvironment(process.env),
    npmNodeExecPath: process.env.npm_node_execpath,
    node: process.env.NODE
  };
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
  assert.notStrictEqual(calls[0].options.env, process.env);
  assert.equal(
    readPathEnvironment(calls[0].options.env).split(path.delimiter)[0],
    path.dirname(process.execPath)
  );
  assert.equal(calls[0].options.env.npm_node_execpath, process.execPath);
  assert.equal(calls[0].options.env.NODE, process.execPath);
  assert.deepEqual(
    {
      path: readPathEnvironment(process.env),
      npmNodeExecPath: process.env.npm_node_execpath,
      node: process.env.NODE
    },
    processEnvironmentBefore
  );

  calls.length = 0;
  assert.throws(
    () =>
      runBuildCommands(temporaryStage, (...args) => {
        calls.push(args);
        return { status: 0 };
      }, { ...buildOptions, packageJson: { ...stagedPackage, unexpected: true } }),
    /does not match the expected derived manifest/i
  );
  assert.equal(calls.length, 0, "npm ran with a manifest different from the expected profile");

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
        "cli.js"
      );
      fs.mkdirSync(path.dirname(localBuilderCli), { recursive: true });
      fs.writeFileSync(localBuilderCli, "local builder CLI");
      const electronExecutable = path.join(
        temporaryStage,
        "node_modules",
        "electron",
        "dist",
        process.platform === "win32" ? "electron.exe" : "electron"
      );
      fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
      fs.writeFileSync(electronExecutable, "staged Electron runtime");
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
  assert.equal(calls[1].command, path.join(
    temporaryStage,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  ));
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[2].command, process.execPath);
  assert.deepEqual(calls[2].args, [
    path.join(temporaryStage, "node_modules", "electron-builder", "cli.js"),
    "--win",
    "nsis",
    "--x64"
  ]);
  assert.ok(calls.every(({ options }) => options.cwd === temporaryStage));
  assert.ok(calls.every(({ options }) => options.env !== process.env));
  assert.ok(calls.every(({ options }) =>
    readPathEnvironment(options.env).split(path.delimiter)[0] === path.dirname(process.execPath)
  ));

  calls.length = 0;
  const missingResourcePackage = {
    ...stagedPackage,
    build: {
      extraResources: [{ from: path.join(temporaryRoot, "bin", "missing.exe"), to: "missing.exe" }]
    }
  };
  fs.writeFileSync(
    path.join(temporaryStage, "package.json"),
    JSON.stringify(missingResourcePackage)
  );
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

test("build commands bind validation to unchanged staged manifest and lock bytes", (t) => {
  const { runBuildCommands } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-stage-snapshot-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const npmCliPath = path.join(temporaryRoot, "npm-cli.js");
  const packageJson = {
    name: "flyingmouse-format-win7",
    version: "0.3.2",
    dependencies: { sharp: "0.32.6" },
    devDependencies: { electron: "22.3.27" },
    build: { extraResources: [] }
  };
  const lockfile = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies
      }
    }
  };
  fs.mkdirSync(path.join(temporaryStage, "node_modules", ".bin"), { recursive: true });
  fs.mkdirSync(path.join(temporaryStage, "node_modules", "electron-builder"), { recursive: true });
  fs.writeFileSync(path.join(temporaryStage, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(temporaryStage, "package-lock.json"), JSON.stringify(lockfile));
  fs.writeFileSync(npmCliPath, "npm CLI");
  fs.writeFileSync(
    path.join(
      temporaryStage,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
    ),
    "builder shim"
  );
  fs.writeFileSync(
    path.join(temporaryStage, "node_modules", "electron-builder", "cli.js"),
    "builder CLI"
  );
  const externalResource = path.join(temporaryRoot, "..", "outside-resource.exe");
  const calls = [];

  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (command, args, options) => {
          calls.push({ command, args, options });
          if (calls.length === 1) {
            fs.writeFileSync(
              path.join(temporaryStage, "package.json"),
              JSON.stringify({
                ...packageJson,
                build: { extraResources: [{ from: externalResource, to: "outside.exe" }] }
              })
            );
          }
          return { status: 0 };
        },
        { npmCliPath, nodeVersion: supportedBuildNodeVersion, projectRoot: temporaryRoot, packageJson }
      ),
    /package.*changed during npm ci|does not match.*expected/i
  );
  assert.equal(calls.length, 1, "electron-builder ran after the staged manifest changed");

  fs.writeFileSync(path.join(temporaryStage, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(temporaryStage, "package-lock.json"), JSON.stringify(lockfile));
  calls.length = 0;
  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (command, args, options) => {
          calls.push({ command, args, options });
          if (calls.length === 1) {
            fs.writeFileSync(
              path.join(temporaryStage, "package-lock.json"),
              `${JSON.stringify(lockfile)}\n`
            );
          }
          return { status: 0 };
        },
        { npmCliPath, nodeVersion: supportedBuildNodeVersion, projectRoot: temporaryRoot, packageJson }
      ),
    /package lock changed during npm ci/i
  );
  assert.equal(calls.length, 1, "electron-builder ran after staged lock bytes changed");
});

test("build commands reject a junctioned local builder CLI before executing it", (t) => {
  const { runBuildCommands } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-builder-root-");
  const externalBuilder = createTemporaryRoot(t, "flyingmouse-win7-builder-target-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const npmCliPath = path.join(temporaryRoot, "npm-cli.js");
  const packageJson = {
    name: "flyingmouse-format-win7",
    version: "0.3.2",
    dependencies: { sharp: "0.32.6" },
    devDependencies: { electron: "22.3.27" },
    build: { extraResources: [] }
  };
  const lockfile = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies
      }
    }
  };
  fs.mkdirSync(path.join(temporaryStage, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(temporaryStage, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(temporaryStage, "package-lock.json"), JSON.stringify(lockfile));
  fs.writeFileSync(npmCliPath, "npm CLI");
  fs.writeFileSync(
    path.join(
      temporaryStage,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
    ),
    "builder shim"
  );
  fs.mkdirSync(path.join(externalBuilder, "out", "cli"), { recursive: true });
  fs.writeFileSync(path.join(externalBuilder, "cli.js"), "external builder CLI");
  fs.writeFileSync(path.join(externalBuilder, "out", "cli", "cli.js"), "external old CLI");
  const sentinel = path.join(externalBuilder, "do-not-touch.txt");
  fs.writeFileSync(sentinel, "external content");
  const builderJunction = path.join(temporaryStage, "node_modules", "electron-builder");
  if (!createJunctionOrSkip(t, externalBuilder, builderJunction)) return;
  const calls = [];

  assert.throws(
    () =>
      runBuildCommands(
        temporaryStage,
        (...args) => {
          calls.push(args);
          return { status: 0 };
        },
        { npmCliPath, nodeVersion: supportedBuildNodeVersion, projectRoot: temporaryRoot, packageJson }
      ),
    /builder.*reparse|reparse.*builder|builder.*canonical/i
  );
  assert.equal(calls.length, 1, "junctioned electron-builder CLI was executed");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
  fs.unlinkSync(builderJunction);
});

test("Win7 runtime probe requires Turndown conversion inside staged Electron", (t) => {
  const { runWin7RuntimeProbe } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-runtime-probe-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const electronExecutable = path.join(
    temporaryStage,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  );
  fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
  fs.writeFileSync(electronExecutable, "staged Electron runtime");
  const calls = [];

  runWin7RuntimeProbe(temporaryStage, temporaryRoot, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, electronExecutable);
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /require\(["']turndown["']\)/);
  assert.match(
    calls[0].args[1],
    /new TurndownService\(\{\s*headingStyle:\s*["']atx["'],\s*codeBlockStyle:\s*["']fenced["']\s*\}\)/
  );
  assert.match(calls[0].args[1], /<h1>Win7<\/h1>/);
  assert.match(calls[0].args[1], /# Win7/);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0].options.cwd, temporaryStage);

  assert.throws(
    () => runWin7RuntimeProbe(temporaryStage, temporaryRoot, () => ({ status: 9 })),
    /Win7 Electron runtime probe failed with exit code 9/i
  );
});

test("Win7 build rejects unsupported host Node before staging or npm", (t) => {
  const { assertSupportedBuildNode, buildWin7 } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-node-version-");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  let runnerCalls = 0;

  assert.throws(
    () =>
      buildWin7(
        temporaryRoot,
        () => {
          runnerCalls += 1;
          return { status: 0 };
        },
        { nodeVersion: "26.2.0" }
      ),
    /Node\.js 26\.2\.0.*Node\.js 22 LTS/i
  );
  assert.equal(runnerCalls, 0, "npm ran with an unsupported build host");
  assert.ok(!fs.existsSync(temporaryStage), "unsupported build host wrote staging content");
  assert.doesNotThrow(() => assertSupportedBuildNode("18.20.8"));
  assert.doesNotThrow(() => assertSupportedBuildNode("22.22.0"));
  assert.throws(() => assertSupportedBuildNode("16.20.2"), /Node\.js 22 LTS/i);
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
  fs.writeFileSync(path.join(temporaryStage, "package.json"), JSON.stringify(packageJson));

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
        { npmCliPath, nodeVersion: supportedBuildNodeVersion, projectRoot: temporaryRoot, packageJson }
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
        { npmCliPath, nodeVersion: supportedBuildNodeVersion, projectRoot: temporaryRoot, packageJson }
      ),
    /dependencies.*sharp|sharp.*mismatch/i
  );
  assert.equal(calls.length, 0, "npm ran before the mismatched lock was rejected");
});

test("build commands reject junction and nested staging paths before npm", (t) => {
  const { runBuildCommands } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-build-stage-root-");
  const externalStage = createTemporaryRoot(t, "flyingmouse-win7-build-stage-target-");
  const output = path.join(temporaryRoot, "output");
  const npmCliPath = path.join(temporaryRoot, "npm-cli.js");
  const packageJson = {
    name: "flyingmouse-format-win7",
    version: "0.3.2",
    dependencies: { sharp: "0.32.6" },
    devDependencies: { electron: "22.3.27" },
    build: { extraResources: [] }
  };
  const lockfile = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies
      }
    }
  };
  fs.mkdirSync(output);
  fs.writeFileSync(npmCliPath, "npm CLI");
  fs.writeFileSync(path.join(externalStage, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(externalStage, "package-lock.json"), JSON.stringify(lockfile));
  const sentinel = path.join(externalStage, "do-not-touch.txt");
  fs.writeFileSync(sentinel, "external content");
  const calls = [];
  const runner = (...args) => {
    calls.push(args);
    return { status: 0 };
  };

  const junctionStage = path.join(output, "win7-stage");
  if (!createJunctionOrSkip(t, externalStage, junctionStage)) return;
  assert.throws(
    () =>
      runBuildCommands(junctionStage, runner, {
        npmCliPath,
        nodeVersion: supportedBuildNodeVersion,
        projectRoot: temporaryRoot,
        packageJson
      }),
    /stage.*reparse|reparse.*stage/i
  );
  assert.equal(calls.length, 0, "npm ran through a junction staging path");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
  fs.unlinkSync(junctionStage);

  const nestedStage = path.join(output, "nested", "win7-stage");
  fs.mkdirSync(nestedStage, { recursive: true });
  fs.writeFileSync(path.join(nestedStage, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(nestedStage, "package-lock.json"), JSON.stringify(lockfile));
  assert.throws(
    () =>
      runBuildCommands(nestedStage, runner, {
        npmCliPath,
        nodeVersion: supportedBuildNodeVersion,
        projectRoot: temporaryRoot,
        packageJson
      }),
    /must exactly match.*output.*win7-stage/i
  );
  assert.equal(calls.length, 0, "npm ran from a nested staging path");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "external content");
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

test("staging recursively copies nested directories without fs.cpSync", (t) => {
  const { copyStagingEntry } = require("../scripts/build-win7");
  const temporaryRoot = createTemporaryRoot(t, "flyingmouse-win7-unicode-copy-");
  const source = path.join(temporaryRoot, "public");
  const nested = path.join(source, "图标", "鼠鼠");
  const emptyDirectory = path.join(source, "空目录");
  const temporaryStage = path.join(temporaryRoot, "output", "win7-stage");
  const payload = Buffer.from([0x00, 0x57, 0x69, 0x6e, 0x37, 0xff]);
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(emptyDirectory, { recursive: true });
  fs.mkdirSync(temporaryStage, { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<h1>Win7</h1>");
  fs.writeFileSync(path.join(nested, "资源.bin"), payload);

  const originalCpSync = fs.cpSync;
  try {
    fs.cpSync = () => {
      throw new Error("fs.cpSync must not be used for Win7 staging");
    };
    copyStagingEntry("public", temporaryRoot, temporaryStage);
  } finally {
    fs.cpSync = originalCpSync;
  }

  assert.equal(
    fs.readFileSync(path.join(temporaryStage, "public", "index.html"), "utf8"),
    "<h1>Win7</h1>"
  );
  assert.deepEqual(
    fs.readFileSync(path.join(temporaryStage, "public", "图标", "鼠鼠", "资源.bin")),
    payload
  );
  assert.ok(fs.statSync(path.join(temporaryStage, "public", "空目录")).isDirectory());
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
