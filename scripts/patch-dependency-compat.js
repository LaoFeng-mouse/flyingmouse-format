"use strict";

// 作者：牢蜂（LaoFeng）。仅供个人免费使用，禁止商业售卖/转卖/套壳。
// These reviewed consumer adaptations preserve upstream package metadata and
// keep the security implementations in the official upgraded dependencies.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const patchesDirectory = path.resolve(__dirname, "../third-party/dependency-patches");
const requiredPatchFiles = [
  "exceljs-parse-sax-compat.json",
  "exceljs-stream-buf-compat.json",
  "exceljs-workbook-reader-compat.json",
  "temp-rimraf-compat.json"
];
const actualPatchFiles = fs.readdirSync(patchesDirectory).filter(name => name.endsWith(".json")).sort();
if (JSON.stringify(actualPatchFiles) !== JSON.stringify(requiredPatchFiles)) {
  throw new Error("Dependency compatibility rule set is incomplete or unexpected; review all four required patches");
}
const patches = requiredPatchFiles.map(name => JSON.parse(fs.readFileSync(path.join(patchesDirectory, name), "utf8")));

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function physicalPath(file, directory = false) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Dependency compatibility check requires a physical ${directory ? "directory" : "file"}: ${resolved}`);
  }
  const real = fs.realpathSync.native(resolved);
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(real) !== normalize(resolved)) throw new Error(`Dependency path is redirected: ${resolved}`);
  return resolved;
}

function patchOne(patch, { root, modules, apply, requireBuild, omitDev }) {
  const packagePath = path.join(modules, patch.packageName);
  if (!fs.existsSync(packagePath) && patch.packageName === "temp" && omitDev && !requireBuild) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const entry = lock.packages?.["node_modules/temp"];
    if (entry?.dev !== true || entry.version !== patch.version || manifest.dependencies?.temp || manifest.optionalDependencies?.temp) {
      throw new Error("A missing temp package is not a verified omitted development dependency");
    }
    return { package: patch.packageName, version: patch.version, file: patch.file, status: "omitted-development-dependency" };
  }
  const packageRoot = physicalPath(path.join(modules, patch.packageName), true);
  const manifestFile = physicalPath(path.join(packageRoot, "package.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.name !== patch.packageName || manifest.version !== patch.version) {
    throw new Error(`Review a new compatibility patch before using ${manifest.name}@${manifest.version}`);
  }
  const target = physicalPath(path.join(packageRoot, patch.file));
  const before = fs.readFileSync(target);
  const actualHash = hash(before);
  if (actualHash === patch.afterSha256) return { package: patch.packageName, version: patch.version, file: patch.file, status: "verified", sha256: actualHash };
  if (actualHash !== patch.beforeSha256) throw new Error(`Unrecognized dependency content; refusing compatibility patch: ${patch.packageName}/${patch.file}`);
  if (!apply) throw new Error(`Dependency compatibility patch is missing. Run npm install or npm run postinstall before building.`);

  let content = before.toString("utf8");
  for (const replacement of patch.replacements) {
    if (content.split(replacement.from).length - 1 !== replacement.count) throw new Error("Upstream compatibility patch context changed");
    content = content.split(replacement.from).join(replacement.to);
  }
  const bytes = Buffer.from(content, "utf8");
  if (hash(bytes) !== patch.afterSha256) throw new Error("Compatibility patch output does not match its reviewed digest");

  const temporary = target + ".fmf-" + crypto.randomUUID() + ".tmp";
  let created = false;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: fs.statSync(target).mode });
    created = true;
    // npm runs postinstall serially. Still reject a replaced/edited input
    // between inspection and the atomic replacement.
    physicalPath(target);
    if (hash(fs.readFileSync(target)) !== patch.beforeSha256) throw new Error("Dependency changed during compatibility patch");
    fs.renameSync(temporary, target);
    created = false;
  } finally {
    if (created) fs.unlinkSync(temporary);
  }
  if (hash(fs.readFileSync(target)) !== patch.afterSha256) throw new Error("Dependency compatibility verification failed after writing");
  return { package: patch.packageName, version: patch.version, file: patch.file, status: "applied", sha256: patch.afterSha256 };
}

function verifyDependencyCompatibility({ root = path.resolve(__dirname, ".."), apply = false, requireBuild = false, omitDev = false } = {}) {
  const modules = physicalPath(path.join(root, "node_modules"), true);
  const targets = patches.map(patch => patchOne(patch, { root, modules, apply, requireBuild, omitDev }));
  return { passed: true, targets };
}

module.exports = { verifyDependencyCompatibility };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check") || args.length > 1) {
    console.error("Usage: node scripts/patch-dependency-compat.js [--check]");
    process.exitCode = 1;
  } else {
    const check = args.includes("--check");
    const omitDev = String(process.env.npm_config_omit || "").split(/[\s,]+/).includes("dev") || process.env.NODE_ENV === "production";
    try { console.log(JSON.stringify(verifyDependencyCompatibility({ apply: !check, requireBuild: check, omitDev }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
