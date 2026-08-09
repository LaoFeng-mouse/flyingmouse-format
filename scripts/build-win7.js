const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const { createWin7BuildProfile } = require("../win7-build-profile");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STAGE_BASENAME = "win7-stage";
const MINIMUM_BUILD_NODE_MAJOR = 18;
const MAXIMUM_BUILD_NODE_MAJOR = 22;

function assertSupportedBuildNode(nodeVersion = process.versions.node) {
  const match = /^v?(\d+)\./.exec(String(nodeVersion));
  const major = match ? Number(match[1]) : NaN;
  if (
    !Number.isInteger(major) ||
    major < MINIMUM_BUILD_NODE_MAJOR ||
    major > MAXIMUM_BUILD_NODE_MAJOR
  ) {
    throw new Error(
      `Unsupported Node.js ${nodeVersion} for Win7 builds. ` +
      "Use Node.js 22 LTS (supported build host majors: 18 through 22)."
    );
  }
  return major;
}

function pathIsStrictlyInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function getProjectPaths(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Project root must be a real directory, not a reparse point: ${resolvedRoot}`);
  }
  return {
    resolvedRoot,
    canonicalRoot: fs.realpathSync.native(resolvedRoot)
  };
}

function assertExistingAncestorInsideRoot(targetPath, projectPaths, label) {
  let existingPath = path.resolve(targetPath);
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) throw new Error(`${label} has no existing ancestor: ${targetPath}`);
    existingPath = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(existingPath);
  if (
    !pathsEqual(canonicalAncestor, projectPaths.canonicalRoot) &&
    !pathIsStrictlyInside(canonicalAncestor, projectPaths.canonicalRoot)
  ) {
    throw new Error(`${label} existing ancestor escapes the canonical project root: ${existingPath}`);
  }
}

function assertNotReparsePoint(targetPath, projectPaths, label) {
  const resolvedTarget = path.resolve(targetPath);
  const stat = fs.lstatSync(resolvedTarget, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link, junction, or reparse point: ${resolvedTarget}`);
  }
  const relative = path.relative(projectPaths.resolvedRoot, resolvedTarget);
  const expectedCanonical = path.resolve(projectPaths.canonicalRoot, relative);
  const actualCanonical = fs.realpathSync.native(resolvedTarget);
  if (!pathsEqual(actualCanonical, expectedCanonical)) {
    throw new Error(`${label} must not be a symbolic link, junction, or reparse point: ${resolvedTarget}`);
  }
}

function assertSafeStagePath(stagePath, projectRoot = PROJECT_ROOT) {
  const projectPaths = getProjectPaths(projectRoot);
  const { resolvedRoot } = projectPaths;
  const resolvedOutput = path.resolve(resolvedRoot, "output");
  const resolvedStage = path.resolve(stagePath);
  const expectedStage = path.join(resolvedOutput, STAGE_BASENAME);

  if (!pathIsStrictlyInside(resolvedStage, resolvedOutput)) {
    throw new Error(`Win7 stage must be strictly inside ${resolvedOutput}: ${resolvedStage}`);
  }
  if (path.basename(resolvedStage) !== STAGE_BASENAME) {
    throw new Error(`Win7 stage basename must be ${STAGE_BASENAME}: ${resolvedStage}`);
  }
  if (!pathsEqual(resolvedStage, expectedStage)) {
    throw new Error(`Win7 stage must exactly match ${expectedStage}: ${resolvedStage}`);
  }
  assertNotReparsePoint(resolvedOutput, projectPaths, "Win7 output directory");
  assertExistingAncestorInsideRoot(resolvedOutput, projectPaths, "Win7 output directory");
  assertNotReparsePoint(resolvedStage, projectPaths, "Win7 stage directory");
  assertExistingAncestorInsideRoot(resolvedStage, projectPaths, "Win7 stage directory");
  return resolvedStage;
}

function removeWin7Stage(stagePath, projectRoot = PROJECT_ROOT) {
  const safeStagePath = assertSafeStagePath(stagePath, projectRoot);
  fs.rmSync(safeStagePath, { recursive: true, force: true });
}

function assertSafeStagingEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0 || path.isAbsolute(entry)) {
    throw new Error(`Unsafe staging entry: ${entry}`);
  }
  const normalized = entry.replaceAll("\\", "/");
  const topLevel = normalized.split("/")[0];
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    ["node_modules", "dist", "output"].includes(topLevel)
  ) {
    throw new Error(`Unsafe staging entry: ${entry}`);
  }
}

function assertNoReparsePoints(sourcePath, projectPaths, label) {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`${label} contains a reparse point: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
    throw new Error(`Unsupported staging source type: ${sourcePath}`);
  }
  const canonicalSource = fs.realpathSync.native(sourcePath);
  if (
    !pathsEqual(canonicalSource, projectPaths.canonicalRoot) &&
    !pathIsStrictlyInside(canonicalSource, projectPaths.canonicalRoot)
  ) {
    throw new Error(`${label} escapes its canonical root: ${sourcePath}`);
  }
  if (sourceStat.isDirectory()) {
    for (const child of fs.readdirSync(sourcePath)) {
      assertNoReparsePoints(path.join(sourcePath, child), projectPaths, label);
    }
  }
}

function copyStagingTree(source, destination, label) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`${label} contains a reparse point: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: sourceStat.mode });
    for (const child of fs.readdirSync(source)) {
      copyStagingTree(path.join(source, child), path.join(destination, child), label);
    }
    return;
  }
  if (sourceStat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, sourceStat.mode);
    return;
  }
  throw new Error(`Unsupported staging source type: ${source}`);
}

function copyStagingEntry(entry, projectRoot, stagePath) {
  assertSafeStagingEntry(entry);
  const projectPaths = getProjectPaths(projectRoot);
  const safeStagePath = assertSafeStagePath(stagePath, projectPaths.resolvedRoot);
  const source = path.resolve(projectPaths.resolvedRoot, entry);
  const destination = path.resolve(safeStagePath, entry);
  if (
    !pathIsStrictlyInside(source, projectPaths.resolvedRoot) ||
    !pathIsStrictlyInside(destination, safeStagePath)
  ) {
    throw new Error(`Staging entry escapes its allowed root: ${entry}`);
  }
  if (!fs.existsSync(source)) throw new Error(`Staging source does not exist: ${source}`);

  assertExistingAncestorInsideRoot(source, projectPaths, `Staging source ${entry}`);
  const label = `Staging source ${entry}`;
  assertNoReparsePoints(source, projectPaths, label);
  copyStagingTree(source, destination, label);
}

function prepareWin7Stage(projectRoot = PROJECT_ROOT, options = {}) {
  assertSupportedBuildNode(options.nodeVersion);
  const projectPaths = getProjectPaths(projectRoot);
  const { resolvedRoot } = projectPaths;
  const packagePath = path.join(resolvedRoot, "package.json");
  const win7LockPath = path.join(resolvedRoot, "win7-package-lock.json");
  const stagePath = assertSafeStagePath(path.join(resolvedRoot, "output", STAGE_BASENAME), resolvedRoot);
  const basePackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const { packageJson, stagingEntries } = createWin7BuildProfile(basePackage, resolvedRoot);
  const lockfile = readAndValidateWin7Lockfile(
    win7LockPath,
    packageJson,
    "Root Win7 package lock",
    projectPaths
  );

  removeWin7Stage(stagePath, resolvedRoot);
  fs.mkdirSync(stagePath, { recursive: true });
  for (const entry of stagingEntries) copyStagingEntry(entry, resolvedRoot, stagePath);
  fs.writeFileSync(path.join(stagePath, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(stagePath, "package-lock.json"), lockfile.bytes);

  console.log(`Win7 staging prepared: ${stagePath}`);
  return { stagePath, packageJson };
}

function runChecked(command, args, label, stagePath, runner) {
  const result = runner(command, args, {
    cwd: stagePath,
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.signal) throw new Error(`${label} terminated by signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function resolveNpmCliPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCliPath = candidates.find((candidate) =>
    fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()
  );
  if (!npmCliPath) {
    throw new Error(`Local npm CLI was not found. Checked: ${candidates.join(", ")}`);
  }
  return path.resolve(npmCliPath);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDependencySpecs(lockRoot, packageJson, field, label) {
  const expected = packageJson[field];
  const actual = lockRoot[field];
  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    throw new Error(`${label} ${field} must match the derived Win7 manifest.`);
  }
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of [...names].sort()) {
    if (expected[name] !== actual[name]) {
      throw new Error(
        `${label} ${field}.${name} mismatch: expected ${expected[name]}, received ${actual[name]}.`
      );
    }
  }
}

function validateWin7Lockfile(lockfile, packageJson, label = "Win7 package lock") {
  if (!isPlainObject(lockfile)) throw new Error(`${label} must be a JSON object.`);
  if (lockfile.lockfileVersion !== 3) throw new Error(`${label} must use lockfileVersion 3.`);
  if (lockfile.name !== packageJson.name || lockfile.version !== packageJson.version) {
    throw new Error(
      `${label} name/version mismatch: expected ${packageJson.name}@${packageJson.version}.`
    );
  }
  const lockRoot = lockfile.packages?.[""];
  if (!isPlainObject(lockRoot)) throw new Error(`${label} is missing packages[""].`);
  if (lockRoot.name !== packageJson.name || lockRoot.version !== packageJson.version) {
    throw new Error(`${label} packages[""] name/version mismatch.`);
  }
  validateDependencySpecs(lockRoot, packageJson, "dependencies", label);
  validateDependencySpecs(lockRoot, packageJson, "devDependencies", label);
  return lockfile;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularJsonSnapshot(filePath, allowedPaths, label) {
  const resolvedFile = path.resolve(filePath);
  if (!pathIsStrictlyInside(resolvedFile, allowedPaths.resolvedRoot)) {
    throw new Error(`${label} path escapes its allowed root: ${resolvedFile}`);
  }
  const fileStat = fs.lstatSync(resolvedFile, { throwIfNoEntry: false });
  if (!fileStat) throw new Error(`${label} is missing: ${resolvedFile}`);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a reparse point: ${resolvedFile}`);
  }
  assertNotReparsePoint(resolvedFile, allowedPaths, label);
  assertExistingAncestorInsideRoot(resolvedFile, allowedPaths, label);
  const bytes = fs.readFileSync(resolvedFile);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`);
  }
  return { bytes, hash: hashBytes(bytes), value };
}

function readAndValidateWin7Lockfile(lockPath, packageJson, label, projectPaths) {
  const snapshot = readRegularJsonSnapshot(lockPath, projectPaths, label);
  validateWin7Lockfile(snapshot.value, packageJson, label);
  return { ...snapshot, lockfile: snapshot.value };
}

function validateExtraResources(extraResources, projectRoot, stagePath) {
  if (!Array.isArray(extraResources)) throw new Error("build.extraResources must be an array.");
  const projectPaths = getProjectPaths(projectRoot);
  const safeStagePath = assertSafeStagePath(stagePath, projectPaths.resolvedRoot);
  const stagePaths = {
    resolvedRoot: safeStagePath,
    canonicalRoot: fs.realpathSync.native(safeStagePath)
  };

  extraResources.forEach((resource, index) => {
    const label = `extraResources[${index}]`;
    if (!isPlainObject(resource) || typeof resource.from !== "string" || resource.from.length === 0) {
      throw new Error(`${label}.from must be a non-empty string.`);
    }
    const absoluteSource = path.isAbsolute(resource.from);
    const allowedPaths = absoluteSource ? projectPaths : stagePaths;
    const source = path.resolve(allowedPaths.resolvedRoot, resource.from);
    if (!pathIsStrictlyInside(source, allowedPaths.resolvedRoot)) {
      throw new Error(`${label}.from must be strictly inside its allowed root: ${source}`);
    }
    const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!sourceStat) throw new Error(`${label}.from does not exist: ${source}`);
    assertNoReparsePoints(source, allowedPaths, label);
    assertExistingAncestorInsideRoot(source, allowedPaths, label);
  });
}

function readStagePackageSnapshot(stagePath, stagePaths) {
  const packagePath = path.join(stagePath, "package.json");
  return readRegularJsonSnapshot(packagePath, stagePaths, "Staged Win7 package");
}

function assertSnapshotUnchanged(before, after, label) {
  if (before.hash !== after.hash || !before.bytes.equals(after.bytes)) {
    throw new Error(`${label} changed during npm ci.`);
  }
}

function assertRegularFileInside(filePath, allowedPaths, label) {
  const resolvedFile = path.resolve(filePath);
  if (!pathIsStrictlyInside(resolvedFile, allowedPaths.resolvedRoot)) {
    throw new Error(`${label} path escapes staging: ${resolvedFile}`);
  }
  const fileStat = fs.lstatSync(resolvedFile, { throwIfNoEntry: false });
  if (!fileStat) throw new Error(`${label} was not installed: ${resolvedFile}`);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a reparse point: ${resolvedFile}`);
  }
  assertNotReparsePoint(resolvedFile, allowedPaths, label);
  assertExistingAncestorInsideRoot(resolvedFile, allowedPaths, label);
  return resolvedFile;
}

function runWin7RuntimeProbe(stagePath, projectRoot, runner = spawnSync) {
  const safeStagePath = assertSafeStagePath(stagePath, projectRoot);
  const stagePaths = {
    resolvedRoot: safeStagePath,
    canonicalRoot: fs.realpathSync.native(safeStagePath)
  };
  const electronExecutable = assertRegularFileInside(path.join(
    safeStagePath,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  ), stagePaths, "Win7 Electron runtime");
  const probe = [
    'const TurndownService = require("turndown");',
    'const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown("<h1>Win7</h1>").trim();',
    'if (markdown !== "# Win7") throw new Error(`Unexpected Turndown output: ${markdown}`);'
  ].join(" ");
  const result = runner(electronExecutable, ["-e", probe], {
    cwd: safeStagePath,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (result.error) throw new Error(`Win7 Electron runtime probe failed: ${result.error.message}`);
  if (result.signal) {
    throw new Error(`Win7 Electron runtime probe terminated by signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`Win7 Electron runtime probe failed with exit code ${result.status}.`);
  }
}

function runBuildCommands(stagePath, runner = spawnSync, options = {}) {
  assertSupportedBuildNode(options.nodeVersion);
  const projectRoot = path.resolve(options.projectRoot || path.join(stagePath, "..", ".."));
  const safeStagePath = assertSafeStagePath(stagePath, projectRoot);
  const stagePaths = {
    resolvedRoot: safeStagePath,
    canonicalRoot: fs.realpathSync.native(safeStagePath)
  };
  const packageBefore = readStagePackageSnapshot(safeStagePath, stagePaths);
  const expectedPackageJson = JSON.parse(
    JSON.stringify(options.packageJson || packageBefore.value)
  );
  if (!isDeepStrictEqual(packageBefore.value, expectedPackageJson)) {
    throw new Error("Staged Win7 package does not match the expected derived manifest.");
  }
  const stageLockPath = path.join(safeStagePath, "package-lock.json");
  if (!pathIsStrictlyInside(stageLockPath, safeStagePath)) {
    throw new Error(`Staged Win7 package lock path escapes staging: ${stageLockPath}`);
  }
  const lockBefore = readAndValidateWin7Lockfile(
    stageLockPath,
    expectedPackageJson,
    "Staged Win7 package lock",
    stagePaths
  );
  const npmCliPath = resolveNpmCliPath(options.npmCliPath);
  runChecked(
    process.execPath,
    [npmCliPath, "ci", "--no-audit", "--no-fund"],
    "npm ci",
    safeStagePath,
    runner
  );
  const packageAfter = readStagePackageSnapshot(safeStagePath, stagePaths);
  const lockAfter = readAndValidateWin7Lockfile(
    stageLockPath,
    expectedPackageJson,
    "Staged Win7 package lock",
    stagePaths
  );
  assertSnapshotUnchanged(packageBefore, packageAfter, "Staged Win7 package");
  assertSnapshotUnchanged(lockBefore, lockAfter, "Staged Win7 package lock");
  if (!isDeepStrictEqual(packageAfter.value, expectedPackageJson)) {
    throw new Error("Staged Win7 package does not match the expected derived manifest after npm ci.");
  }
  validateExtraResources(packageAfter.value.build?.extraResources, projectRoot, safeStagePath);
  assertRegularFileInside(path.join(
    safeStagePath,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
  ), stagePaths, "Local electron-builder executable");
  const localBuilderCli = assertRegularFileInside(path.join(
    safeStagePath,
    "node_modules",
    "electron-builder",
    "cli.js"
  ), stagePaths, "Local electron-builder CLI");
  runWin7RuntimeProbe(safeStagePath, projectRoot, runner);
  runChecked(
    process.execPath,
    [localBuilderCli, "--win", "nsis", "--x64"],
    "electron-builder",
    safeStagePath,
    runner
  );
}

function expectedArtifactName(packageJson) {
  return `${packageJson.productName}-Setup-${packageJson.version}-win7-x64.exe`;
}

function hashFileSync(filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function assertManagedArtifactPath(candidate, rootDist, filename, kind) {
  if (!pathIsStrictlyInside(candidate, rootDist) || path.dirname(candidate) !== rootDist) {
    throw new Error(`Unsafe Win7 ${kind} path: ${candidate}`);
  }
  if (!path.basename(candidate).startsWith(`.${filename}.win7-build-${kind}-`)) {
    throw new Error(`Unsafe Win7 ${kind} filename: ${candidate}`);
  }
}

function copyWin7Artifact(stagePath, projectRoot, packageJson, operations = {}) {
  const projectPaths = getProjectPaths(projectRoot);
  const { resolvedRoot } = projectPaths;
  const resolvedStage = assertSafeStagePath(stagePath, resolvedRoot);
  const filename = expectedArtifactName(packageJson);
  if (path.basename(filename) !== filename || !filename.endsWith("-win7-x64.exe")) {
    throw new Error(`Unsafe Win7 artifact filename: ${filename}`);
  }
  const sourceDist = path.resolve(resolvedStage, "dist");
  const source = path.resolve(sourceDist, filename);
  const rootDist = path.resolve(resolvedRoot, "dist");
  const destination = path.resolve(rootDist, filename);

  if (!pathIsStrictlyInside(source, sourceDist) || path.basename(source) !== filename) {
    throw new Error(`Unsafe Win7 artifact source: ${source}`);
  }
  if (!pathIsStrictlyInside(destination, rootDist) || path.basename(destination) !== filename) {
    throw new Error(`Unsafe Win7 artifact destination: ${destination}`);
  }
  assertNotReparsePoint(sourceDist, projectPaths, "Win7 staging dist");
  assertExistingAncestorInsideRoot(sourceDist, projectPaths, "Win7 staging dist");
  assertNotReparsePoint(source, projectPaths, "Win7 installer source");
  if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Expected Win7 installer was not created: ${source}`);
  }

  assertNotReparsePoint(rootDist, projectPaths, "Win7 root dist");
  assertExistingAncestorInsideRoot(rootDist, projectPaths, "Win7 root dist");
  fs.mkdirSync(rootDist, { recursive: true });
  assertNotReparsePoint(rootDist, projectPaths, "Win7 root dist");
  if (!fs.lstatSync(rootDist).isDirectory()) throw new Error(`Win7 root dist is not a directory: ${rootDist}`);
  assertNotReparsePoint(destination, projectPaths, "Existing Win7 installer");
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isFile()) {
    throw new Error(`Existing Win7 installer is not a regular file: ${destination}`);
  }

  const uniqueSuffix = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const temporary = path.join(rootDist, `.${filename}.win7-build-temp-${uniqueSuffix}`);
  const backup = path.join(rootDist, `.${filename}.win7-build-backup-${uniqueSuffix}`);
  assertManagedArtifactPath(temporary, rootDist, filename, "temp");
  assertManagedArtifactPath(backup, rootDist, filename, "backup");
  const renameSync = operations.renameSync || fs.renameSync;
  let backupCreated = false;

  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    const sourceStat = fs.statSync(source);
    const temporaryStat = fs.statSync(temporary);
    if (sourceStat.size !== temporaryStat.size || hashFileSync(source) !== hashFileSync(temporary)) {
      throw new Error(`Temporary Win7 installer verification failed: ${temporary}`);
    }

    if (fs.existsSync(destination)) {
      renameSync(destination, backup);
      backupCreated = true;
    }
    renameSync(temporary, destination);
    if (backupCreated) {
      fs.unlinkSync(backup);
      backupCreated = false;
    }
  } catch (error) {
    if (backupCreated) {
      try {
        if (fs.existsSync(destination)) {
          assertNotReparsePoint(destination, projectPaths, "Partially promoted Win7 installer");
          fs.unlinkSync(destination);
        }
        renameSync(backup, destination);
        backupCreated = false;
      } catch (restoreError) {
        throw new Error(
          `${error.message}; failed to restore previous Win7 installer: ${restoreError.message}`,
          { cause: error }
        );
      }
    }
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }

  console.log(`Win7 installer copied: ${destination}`);
  return destination;
}

function buildWin7(projectRoot = PROJECT_ROOT, runner = spawnSync, options = {}) {
  assertSupportedBuildNode(options.nodeVersion);
  const { stagePath, packageJson } = prepareWin7Stage(projectRoot, options);
  runBuildCommands(stagePath, runner, { ...options, projectRoot, packageJson });
  return copyWin7Artifact(stagePath, path.resolve(projectRoot), packageJson);
}

function parseArgs(args) {
  if (args.length === 0) return { prepareOnly: false };
  if (args.length === 1 && args[0] === "--prepare-only") return { prepareOnly: true };
  throw new Error(`Unknown argument: ${args.join(" ")}. Expected no arguments or --prepare-only.`);
}

function main(args = process.argv.slice(2)) {
  const { prepareOnly } = parseArgs(args);
  if (prepareOnly) {
    const { stagePath } = prepareWin7Stage(PROJECT_ROOT);
    console.log(`Win7 prepare-only complete: ${stagePath}`);
    return;
  }
  buildWin7(PROJECT_ROOT);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Win7 build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertSafeStagePath,
  assertSupportedBuildNode,
  buildWin7,
  copyStagingEntry,
  copyWin7Artifact,
  main,
  parseArgs,
  prepareWin7Stage,
  removeWin7Stage,
  runBuildCommands,
  runWin7RuntimeProbe,
  validateExtraResources,
  validateWin7Lockfile
};
