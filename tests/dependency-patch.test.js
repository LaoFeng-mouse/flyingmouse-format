"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyDependencyCompatibility } = require("../scripts/patch-dependency-compat");

const root = path.resolve(__dirname, "..");

test("all real installed patches are verified and applying them again is inert", async () => {
  const checked = verifyDependencyCompatibility({ root, requireBuild: true });
  assert.equal(checked.targets.length, 4);
  assert.ok(checked.targets.every(item => item.status === "verified"));
  const targets = checked.targets.map(item => path.join(root, "node_modules", item.package, item.file));
  const before = await Promise.all(targets.map(target => fs.readFile(target)));
  assert.ok(verifyDependencyCompatibility({ root, apply: true, requireBuild: true }).targets.every(item => item.status === "verified"));
  assert.deepEqual(await Promise.all(targets.map(target => fs.readFile(target))), before);
});

test("a missing required rule refuses loading instead of silently reducing checks", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fmf-dependency-rule-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "scripts"));
  await fs.cp(path.join(root, "third-party/dependency-patches"), path.join(directory, "third-party/dependency-patches"), { recursive: true });
  await fs.copyFile(path.join(root, "scripts/patch-dependency-compat.js"), path.join(directory, "scripts/patch-dependency-compat.js"));
  await fs.unlink(path.join(directory, "third-party/dependency-patches/exceljs-stream-buf-compat.json"));
  const result = spawnSync(process.execPath, [path.join(directory, "scripts/patch-dependency-compat.js"), "--check"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rule set is incomplete or unexpected/);
});

test("only a verified dev-only temp omission is allowed, never for a build", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fmf-production-patch-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(path.join(root, "package.json"), path.join(directory, "package.json"));
  await fs.copyFile(path.join(root, "package-lock.json"), path.join(directory, "package-lock.json"));
  const descriptors = await fs.readdir(path.join(root, "third-party/dependency-patches"));
  for (const name of descriptors.filter(name => name.startsWith("exceljs-") && name.endsWith(".json"))) {
    const patch = JSON.parse(await fs.readFile(path.join(root, "third-party/dependency-patches", name), "utf8"));
    const dependency = path.join(directory, "node_modules", patch.packageName);
    await fs.mkdir(path.dirname(path.join(dependency, patch.file)), { recursive: true });
    await fs.copyFile(path.join(root, "node_modules", patch.packageName, "package.json"), path.join(dependency, "package.json"));
    await fs.copyFile(path.join(root, "node_modules", patch.packageName, patch.file), path.join(dependency, patch.file));
  }
  const checked = verifyDependencyCompatibility({ root: directory, omitDev: true });
  assert.equal(checked.targets.length, 4);
  assert.equal(checked.targets.filter(item => item.status === "omitted-development-dependency").length, 1);
  assert.equal(checked.targets.find(item => item.status === "omitted-development-dependency").package, "temp");
  assert.throws(() => verifyDependencyCompatibility({ root: directory, omitDev: true, requireBuild: true }), /ENOENT/);
  assert.throws(() => verifyDependencyCompatibility({ root: directory }), /ENOENT/);
  await fs.unlink(path.join(directory, "node_modules/exceljs/lib/utils/stream-buf.js"));
  assert.throws(() => verifyDependencyCompatibility({ root: directory, omitDev: true }), /ENOENT/);
});

test("edited real dependency copies are rejected without rewriting them", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fmf-dependency-patch-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const descriptors = await fs.readdir(path.join(root, "third-party/dependency-patches"));
  // Preserve actual upstream metadata instead of fabricating package versions.
  for (const name of descriptors.filter(name => name.endsWith(".json"))) {
    const patch = JSON.parse(await fs.readFile(path.join(root, "third-party/dependency-patches", name), "utf8"));
    const dependency = path.join(directory, "node_modules", patch.packageName);
    await fs.mkdir(path.dirname(path.join(dependency, patch.file)), { recursive: true });
    await fs.copyFile(path.join(root, "node_modules", patch.packageName, "package.json"), path.join(dependency, "package.json"));
    await fs.copyFile(path.join(root, "node_modules", patch.packageName, patch.file), path.join(dependency, patch.file));
  }
  const target = path.join(directory, "node_modules/temp/lib/temp.js");
  const changed = Buffer.concat([await fs.readFile(path.join(root, "node_modules/temp/lib/temp.js")), Buffer.from("\n// unexpected edit\n")]);
  await fs.writeFile(target, changed);
  assert.throws(() => verifyDependencyCompatibility({ root: directory, apply: true }), /Unrecognized dependency content/);
  assert.deepEqual(await fs.readFile(target), changed);
});

test("real temp callbacks, Promise cleanup, and sync cleanup work with current rimraf", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const temp=require('temp').track();
    (async()=>{
      const directory=await temp.mkdir('fmf-rimraf-async-');
      fs.writeFileSync(path.join(directory,'中文.txt'),'content');
      const file=await temp.open('fmf-rimraf-file-');fs.closeSync(file.fd);
      let calls=0;
      await new Promise((resolve,reject)=>temp.cleanup(error=>{calls++;error?reject(error):resolve();}));
      assert.equal(calls,1);assert.equal(fs.existsSync(directory),false);assert.equal(fs.existsSync(file.path),false);
      const promiseDirectory=await temp.mkdir('fmf-rimraf-promise-');
      await temp.cleanup();assert.equal(fs.existsSync(promiseDirectory),false);
      const syncDirectory=temp.mkdirSync('fmf-rimraf-sync-');
      fs.writeFileSync(path.join(syncDirectory,'.hidden'),'content');
      temp.cleanupSync();assert.equal(fs.existsSync(syncDirectory),false);
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
