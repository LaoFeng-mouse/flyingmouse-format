"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const JSZip = require("jszip");
const { restore, verifyArchive, verifyInstalled } = require("../scripts/restore-libraw");
const lockedEngine = require("../libraw-engine-lock.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const windowsX64 = process.platform === "win32" && process.arch === "x64";

async function fixture(t) {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "fmf-libraw-restore-test-"));
  t.after(async () => {
    const resolved = await fsp.realpath(projectRoot);
    assert.equal(path.dirname(resolved), await fsp.realpath(os.tmpdir()));
    assert.match(path.basename(resolved), /^fmf-libraw-restore-test-/);
    await fsp.rm(resolved, { recursive: true, force: true });
  });
  const librawZip = new JSZip();
  librawZip.file("LibRaw/bin/dcraw_emu.exe", "synthetic decoder");
  const archive = await librawZip.generateAsync({ type: "nodebuffer" });
  const crtZip = new JSZip();
  crtZip.file("Contents/CRT/runtime.dll", "synthetic runtime");
  const crtArchive = await crtZip.generateAsync({ type: "nodebuffer" });
  await fsp.writeFile(path.join(projectRoot, "NOTICE.txt"), "synthetic notice");
  const engineLock = {
    archive: { url: "https://libraw.invalid/locked.zip", sha256: hash(archive) },
    crtArchive: { url: "https://microsoft.invalid/locked.vsix", sha256: hash(crtArchive), directory: "Contents/CRT" },
    files: {
      "dcraw_emu.exe": { origin: "extracted", source: "LibRaw/bin/dcraw_emu.exe", sha256: hash("synthetic decoder") },
      "runtime.dll": { origin: "crt", source: "runtime.dll", sha256: hash("synthetic runtime") },
      "LibRaw.zip": { origin: "archive", sha256: hash(archive) },
      "NOTICE.txt": { origin: "repository", source: "NOTICE.txt", sha256: hash("synthetic notice") }
    }
  };
  const calls = [];
  const fetchArchive = async url => {
    calls.push(url);
    assert.ok([engineLock.archive.url, engineLock.crtArchive.url].includes(url));
    const bytes = url === engineLock.archive.url ? archive : crtArchive;
    return { ok: true, arrayBuffer: async () => bytes };
  };
  return { projectRoot, engineLock, archive, crtArchive, calls, fetchArchive,
    output: path.join(projectRoot, "bin", "libraw") };
}

async function assertUnpublished(context) {
  assert.equal(fs.existsSync(context.output), false, "failed restoration must not publish a payload");
  const staging = path.join(context.projectRoot, "output");
  assert.deepEqual(fs.existsSync(staging) ? await fsp.readdir(staging) : [], []);
}

test("LibRaw and Microsoft runtime archives reject bytes that do not match their locks", () => {
  for (const [label, asset] of [["LibRaw", lockedEngine.archive], ["Microsoft CRT", lockedEngine.crtArchive]]) {
    assert.throws(() => verifyArchive(Buffer.from("not the official archive"), asset, label), /SHA-256 mismatch/);
  }
});

test("LibRaw no-argument restore extracts both locked archives and verifies existing payloads", { skip: !windowsX64 }, async t => {
  const context = await fixture(t);
  const executable = await restore(undefined, undefined, context);
  assert.equal(executable, path.join(context.output, "dcraw_emu.exe"));
  assert.deepEqual(context.calls, [context.engineLock.archive.url, context.engineLock.crtArchive.url]);
  assert.equal(verifyInstalled(context.output, context.engineLock), executable);
  context.fetchArchive = async () => { throw new Error("a valid installed payload must not download again"); };
  assert.equal(await restore(undefined, undefined, context), executable);
  await fsp.writeFile(path.join(context.output, "runtime.dll"), "changed runtime");
  await assert.rejects(restore(undefined, undefined, context), /locked file mismatch: runtime.dll/);
  assert.equal(await fsp.readFile(path.join(context.output, "runtime.dll"), "utf8"), "changed runtime");
});

for (const failedAsset of ["LibRaw", "Microsoft CRT"]) {
  test(`${failedAsset} download hash failure leaves no published engine`, { skip: !windowsX64 }, async t => {
    const context = await fixture(t);
    const goodFetch = context.fetchArchive;
    const rejectedUrl = failedAsset === "LibRaw" ? context.engineLock.archive.url : context.engineLock.crtArchive.url;
    context.fetchArchive = async url => url === rejectedUrl
      ? { ok: true, arrayBuffer: async () => Buffer.from("damaged download") } : goodFetch(url);
    await assert.rejects(restore(undefined, undefined, context), /archive SHA-256 mismatch/);
    await assertUnpublished(context);
  });
}

test("LibRaw rejects mismatched files even inside an archive whose SHA is correct", { skip: !windowsX64 }, async t => {
  const context = await fixture(t);
  context.engineLock.files["runtime.dll"].sha256 = hash("different expected runtime");
  await assert.rejects(restore(undefined, undefined, context), /locked file mismatch: runtime.dll/);
  await assertUnpublished(context);
});

test("LibRaw supports manually prepared locked archives and CRT directories without networking", { skip: !windowsX64 }, async t => {
  const context = await fixture(t);
  const archive = path.join(context.projectRoot, "manual.zip");
  const crtDirectory = path.join(context.projectRoot, "manual-crt");
  await fsp.writeFile(archive, context.archive);
  await fsp.mkdir(crtDirectory);
  await fsp.writeFile(path.join(crtDirectory, "runtime.dll"), "synthetic runtime");
  context.fetchArchive = async () => { throw new Error("manual restoration must not download"); };
  await assert.rejects(restore(archive, undefined, context), /Pass both/);
  await assertUnpublished(context);
  await restore(archive, crtDirectory, context);
  verifyInstalled(context.output, context.engineLock);
});

test("LibRaw download HTTP failure leaves no partial engine or staging directory", { skip: !windowsX64 }, async t => {
  const context = await fixture(t);
  context.fetchArchive = async () => ({ ok: false, status: 503 });
  await assert.rejects(restore(undefined, undefined, context), /download failed: HTTP 503/);
  await assertUnpublished(context);
});
