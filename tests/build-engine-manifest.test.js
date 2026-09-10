const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { readManifest, verifyIntegrity } = require("../store-engine-cache");

test("generated manifest includes real ICU names and detects a removed ICU DLL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-engine-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lo = path.join(root, "LibreOfficePortable", "App", "libreoffice");
  const program = path.join(lo, "program");
  const registry = path.join(lo, "share", "registry");
  await fs.mkdir(program, { recursive: true });
  await fs.mkdir(registry, { recursive: true });
  const names = ["soffice.com", "soffice.bin", "soffice.ini", "bootstraplo.dll", "sal3.dll", "mergedlo.dll", "vclplug_winlo.dll", "stocserviceslo.dll", "i18nlangtag.dll", "swlo.dll", "sclo.dll", "sdlo.dll", "icuuc78.dll", "icuin78.dll", "icudt78.dll"];
  for (const name of names) await fs.writeFile(path.join(program, name), `fixture ${name}`);
  await fs.writeFile(path.join(registry, "main.xcd"), "registry");
  const script = path.join(__dirname, "..", "scripts", "build-engine-manifest.js");
  execFileSync(process.execPath, [script, root], { windowsHide: true, stdio: "pipe" });
  const manifest = readManifest(root);
  assert.equal(Object.keys(manifest.files).filter((rel) => /\/icu/.test(rel)).length, 3);
  assert.ok(verifyIntegrity(root, manifest).ok);
  await fs.rm(path.join(program, "icuuc78.dll"));
  assert.equal(verifyIntegrity(root, manifest).ok, false);
  assert.throws(() => execFileSync(process.execPath, [script, root], { windowsHide: true, stdio: "pipe" }));
});
