"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const lock = require("../libraw-engine-lock.json");
const root = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function verifyArchive(bytes, asset, label) {
  if (hash(bytes) !== asset.sha256) throw new Error(`${label} archive SHA-256 mismatch`);
}

function verifyInstalled(directory, engineLock = lock) {
  for (const [name, entry] of Object.entries(engineLock.files)) {
    if (hash(fs.readFileSync(path.join(directory, name))) !== entry.sha256) {
      throw new Error(`LibRaw locked file mismatch: ${name}`);
    }
  }
  return path.join(directory, "dcraw_emu.exe");
}

async function downloadArchive(asset, destination, label, fetchArchive) {
  const response = await fetchArchive(asset.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${label} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArchive(bytes, asset, label);
  await fsp.writeFile(destination, bytes, { flag: "wx" });
  return destination;
}

function extractArchive(archive, destination) {
  // VSIX is a ZIP container. Use ZipFile instead of installing or executing it.
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:FMF_LIBRAW_ARCHIVE, $env:FMF_LIBRAW_STAGE)"], {
    windowsHide: true, stdio: "pipe", timeout: 120000,
    env: { ...process.env, FMF_LIBRAW_ARCHIVE: archive, FMF_LIBRAW_STAGE: destination }
  });
  if (result.error || result.status !== 0) throw result.error || new Error("LibRaw archive extraction failed");
}

// Options keep filesystem/network inputs isolated for restoration tests.
async function restore(archivePath, crtDirectory, options = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This LibRaw payload is Windows x64 only");
  const projectRoot = path.resolve(options.projectRoot || root);
  const engineLock = options.engineLock || lock;
  const fetchArchive = options.fetchArchive || globalThis.fetch;
  const output = path.join(projectRoot, "bin", "libraw");
  if (fs.existsSync(output)) return verifyInstalled(output, engineLock);
  if (Boolean(archivePath) !== Boolean(crtDirectory)) {
    throw new Error("Pass both <locked LibRaw zip> and <Microsoft VC143 x64 CRT directory>, or no arguments for locked downloads");
  }
  const buildRoot = path.join(projectRoot, "output");
  await fsp.mkdir(buildRoot, { recursive: true });
  const stage = await fsp.mkdtemp(path.join(buildRoot, "libraw-restore-"));
  try {
    const archive = archivePath ? path.resolve(archivePath)
      : await downloadArchive(engineLock.archive, path.join(stage, "libraw.zip"), "LibRaw", fetchArchive);
    verifyArchive(await fsp.readFile(archive), engineLock.archive, "LibRaw");
    let crtRoot = crtDirectory && path.resolve(crtDirectory);
    if (!crtRoot) {
      const crtArchive = await downloadArchive(engineLock.crtArchive, path.join(stage, "crt.vsix"), "Microsoft CRT", fetchArchive);
      const crtExtracted = path.join(stage, "crt");
      extractArchive(crtArchive, crtExtracted);
      crtRoot = path.join(crtExtracted, engineLock.crtArchive.directory);
    }
    const extracted = path.join(stage, "unpacked");
    extractArchive(archive, extracted);
    const prepared = path.join(stage, "payload"); await fsp.mkdir(prepared);
    for (const [name, entry] of Object.entries(engineLock.files)) {
      const source = entry.origin === "archive" ? archive
        : entry.origin === "crt" ? path.join(crtRoot, entry.source)
        : entry.origin === "repository" ? path.join(projectRoot, entry.source)
        : path.join(extracted, entry.source);
      await fsp.copyFile(source, path.join(prepared, name));
    }
    verifyInstalled(prepared, engineLock);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.rename(prepared, output);
    return verifyInstalled(output, engineLock);
  } finally {
    // Only the directory created by this invocation, inside the build root.
    if (path.dirname(stage) !== buildRoot) throw new Error("Unexpected LibRaw staging parent");
    await fsp.rm(stage, { recursive: true, force: true });
  }
}
module.exports = { verifyArchive, verifyInstalled, restore };
if (require.main === module) restore(process.argv[2], process.argv[3]).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
