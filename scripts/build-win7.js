const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createWin7BuildProfile } = require("../win7-build-profile");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STAGE_BASENAME = "win7-stage";

function pathIsStrictlyInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeStagePath(stagePath, projectRoot = PROJECT_ROOT) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedOutput = path.resolve(resolvedRoot, "output");
  const resolvedStage = path.resolve(stagePath);

  if (!pathIsStrictlyInside(resolvedStage, resolvedOutput)) {
    throw new Error(`Win7 stage must be strictly inside ${resolvedOutput}: ${resolvedStage}`);
  }
  if (path.basename(resolvedStage) !== STAGE_BASENAME) {
    throw new Error(`Win7 stage basename must be ${STAGE_BASENAME}: ${resolvedStage}`);
  }
  return resolvedStage;
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

function copyStagingEntry(entry, projectRoot, stagePath) {
  assertSafeStagingEntry(entry);
  const source = path.resolve(projectRoot, entry);
  const destination = path.resolve(stagePath, entry);
  if (!pathIsStrictlyInside(source, projectRoot) || !pathIsStrictlyInside(destination, stagePath)) {
    throw new Error(`Staging entry escapes its allowed root: ${entry}`);
  }
  if (!fs.existsSync(source)) throw new Error(`Staging source does not exist: ${source}`);

  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, dereference: false });
  } else if (sourceStat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  } else {
    throw new Error(`Unsupported staging source type: ${source}`);
  }
}

function prepareWin7Stage(projectRoot = PROJECT_ROOT) {
  const resolvedRoot = path.resolve(projectRoot);
  const packagePath = path.join(resolvedRoot, "package.json");
  const stagePath = assertSafeStagePath(path.join(resolvedRoot, "output", STAGE_BASENAME), resolvedRoot);
  const basePackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const { packageJson, stagingEntries } = createWin7BuildProfile(basePackage, resolvedRoot);

  fs.rmSync(stagePath, { recursive: true, force: true });
  fs.mkdirSync(stagePath, { recursive: true });
  for (const entry of stagingEntries) copyStagingEntry(entry, resolvedRoot, stagePath);
  fs.writeFileSync(path.join(stagePath, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

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

function runBuildCommands(stagePath, runner = spawnSync) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  runChecked(
    npmCommand,
    ["install", "--no-audit", "--no-fund"],
    "npm install",
    stagePath,
    runner
  );
  runChecked(
    npmCommand,
    ["exec", "electron-builder", "--", "--win", "nsis", "--x64"],
    "electron-builder",
    stagePath,
    runner
  );
}

function expectedArtifactName(packageJson) {
  return `${packageJson.productName}-Setup-${packageJson.version}-win7-x64.exe`;
}

function copyWin7Artifact(stagePath, projectRoot, packageJson) {
  const resolvedRoot = path.resolve(projectRoot);
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
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Expected Win7 installer was not created: ${source}`);
  }

  fs.mkdirSync(rootDist, { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(`Win7 installer copied: ${destination}`);
  return destination;
}

function buildWin7(projectRoot = PROJECT_ROOT, runner = spawnSync) {
  const { stagePath, packageJson } = prepareWin7Stage(projectRoot);
  runBuildCommands(stagePath, runner);
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
  buildWin7,
  copyWin7Artifact,
  main,
  parseArgs,
  prepareWin7Stage,
  runBuildCommands
};
