"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertContained(root, candidate) {
  const rootPrefix = `${comparable(root)}${path.sep}`;
  const resolved = comparable(candidate);
  if (!resolved.startsWith(rootPrefix)) throw new Error("Document engine path escapes the staging root.");
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error("Document engine staging must not contain symbolic links.");
    assertContained(root, fs.realpathSync(candidate));
    if (entry.isDirectory()) files.push(...listFiles(root, candidate));
    else if (entry.isFile()) files.push(candidate);
    else throw new Error("Document engine staging contains an unsupported filesystem entry.");
  }
  return files;
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createLock(root, engineVersion) {
  const canonicalRoot = fs.realpathSync(root);
  const executable = path.join(canonicalRoot, "docstructure-engine.exe");
  const modelRoot = path.join(canonicalRoot, "models");
  if (!fs.statSync(executable).isFile()) throw new Error("docstructure-engine.exe is missing.");
  if (!fs.statSync(modelRoot).isDirectory()) throw new Error("models/ is missing.");

  const files = listFiles(canonicalRoot).map((file) => {
    const relative = path.relative(canonicalRoot, file).split(path.sep).join("/");
    const stat = fs.statSync(file);
    return { path: relative, size: stat.size, sha256: hashFile(file) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((entry) => entry.path.startsWith("models/"))) throw new Error("models/ contains no files.");
  return { version: "docstructure-engine-v1", platform: "win32-x64", engineVersion, files };
}

function verifyLock(root, lock) {
  const actual = createLock(root, lock.engineVersion);
  if (JSON.stringify(actual) !== JSON.stringify(lock)) throw new Error("Document engine lock verification failed.");
}

function option(tokens, name) {
  const index = tokens.indexOf(name);
  if (index < 0 || index + 1 >= tokens.length) throw new Error(`Missing ${name}.`);
  return tokens[index + 1];
}

function main(tokens = process.argv.slice(2)) {
  const root = option(tokens, "--root");
  const lockPath = option(tokens, "--lock");
  if (tokens.includes("--verify")) {
    verifyLock(root, JSON.parse(fs.readFileSync(lockPath, "utf8")));
    return;
  }
  const lock = createLock(root, option(tokens, "--engine-version"));
  const output = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, output);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { createLock, verifyLock };
