#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const lock = require("../pandoc-engine-lock.json");
const root = path.resolve(__dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fsp.rename(source, destination); }
    catch (error) {
      if (attempt >= 15 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function selectAsset(platform = process.platform, arch = process.arch) {
  const asset = lock.assets[`${platform}-${arch}`];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[\w.-]+$/.test(asset.file)) {
    throw new Error(`No locked Pandoc engine for ${platform}-${arch}`);
  }
  return asset;
}

function verifyArchive(bytes, asset) {
  if (sha256(bytes) !== asset.sha256) throw new Error("Pandoc archive SHA-256 mismatch; refusing extraction");
}

function verifyInstalled(directory, platform = process.platform, arch = process.arch) {
  const asset = selectAsset(platform, arch);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "engine-integrity.json"), "utf8"));
  const executable = path.join(directory, platform === "win32" ? "pandoc.exe" : "pandoc");
  if (receipt.version !== lock.version || receipt.archiveSha256 !== asset.sha256 ||
      receipt.executableSha256 !== sha256(fs.readFileSync(executable))) {
    throw new Error("Installed Pandoc does not match its locked installation receipt");
  }
  for (const name of ["COPYRIGHT.txt", "COPYING.rtf"]) {
    if (sha256(fs.readFileSync(path.join(directory, name))) !== sha256(fs.readFileSync(path.join(root, "third_party", "pandoc", name)))) {
      throw new Error(`Pandoc license is missing or changed: ${name}`);
    }
  }
  return executable;
}

async function restore(archivePath) {
  const asset = selectAsset();
  const output = path.join(root, "output");
  await fsp.mkdir(output, { recursive: true });
  const archive = archivePath ? path.resolve(archivePath) : path.join(output, asset.file);
  if (!fs.existsSync(archive)) {
    const response = await fetch(`https://github.com/${lock.repository}/releases/download/${lock.version}/${asset.file}`, {
      signal: AbortSignal.timeout(180000)
    });
    if (!response.ok) throw new Error(`Pandoc download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, asset);
    await fsp.writeFile(archive, bytes, { flag: "wx" });
  }
  verifyArchive(await fsp.readFile(archive), asset);
  const stage = await fsp.mkdtemp(path.join(output, "pandoc-stage-"));
  let preserveStage = false;
  try {
    const extraction = spawnSync("tar", ["-xf", archive, "-C", stage], { encoding: "utf8", windowsHide: true, timeout: 300000 });
    if (extraction.error || extraction.status !== 0) throw extraction.error || new Error(extraction.stderr);
    const basename = process.platform === "win32" ? "pandoc.exe" : "pandoc";
    const matches = [];
    async function walk(dir) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          // Official macOS archives include pandoc-lua -> pandoc. Do not copy
          // or traverse aliases; only accept links confined to this archive.
          const relative = path.relative(stage, await fsp.realpath(full));
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Pandoc archive link escapes its staging directory: ${entry.name}`);
          }
          continue;
        }
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === basename) matches.push(full);
      }
    }
    await walk(stage);
    if (matches.length !== 1) throw new Error(`Expected one Pandoc executable, found ${matches.length}`);
    const destination = path.join(root, "bin", "pandoc");
    const prepared = path.join(stage, "verified-installation");
    await fsp.mkdir(prepared);
    await fsp.copyFile(matches[0], path.join(prepared, basename));
    if (process.platform !== "win32") await fsp.chmod(path.join(prepared, basename), 0o755);
    for (const name of ["COPYRIGHT.txt", "COPYING.rtf"]) {
      await fsp.copyFile(path.join(root, "third_party", "pandoc", name), path.join(prepared, name));
    }
    await fsp.writeFile(path.join(prepared, "engine-integrity.json"), JSON.stringify({
      version: lock.version, archiveSha256: asset.sha256,
      executableSha256: sha256(await fsp.readFile(path.join(prepared, basename)))
    }, null, 2) + "\n");
    const executable = verifyInstalled(prepared);
    const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (probe.error || probe.status !== 0 || probe.stdout.split(/\r?\n/, 1)[0] !== `pandoc ${lock.version}`) {
      throw probe.error || new Error("Restored Pandoc version probe failed");
    }
    // Publish only an already verified installation. Keep the old directory
    // available for rollback if the final rename fails.
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    for (const dir of [path.dirname(destination), destination]) {
      if (fs.existsSync(dir) && (await fsp.lstat(dir)).isSymbolicLink()) throw new Error("Pandoc installation directory is a reparse point");
    }
    const previous = path.join(stage, "previous-installation");
    const hadPrevious = fs.existsSync(destination);
    if (hadPrevious) await renameWithRetry(destination, previous);
    try {
      await renameWithRetry(prepared, destination);
    } catch (error) {
      if (hadPrevious) {
        try { await renameWithRetry(previous, destination); }
        catch (rollbackError) {
          preserveStage = true;
          throw new Error(`Pandoc publication and rollback failed; previous installation retained at ${previous}: ${rollbackError.message}`, { cause: error });
        }
      }
      throw error;
    }
    console.log(`Verified Pandoc ${lock.version}: ${process.platform}-${process.arch}`);
  } finally {
    const actual = await fsp.realpath(stage);
    const parent = await fsp.realpath(output);
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith("pandoc-stage-")) throw new Error("Unsafe Pandoc stage cleanup");
    if (!preserveStage) await fsp.rm(actual, { recursive: true, force: true });
  }
}

module.exports = { selectAsset, verifyArchive, verifyInstalled, restore };
if (require.main === module) restore(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
