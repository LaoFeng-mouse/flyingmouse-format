const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { readLastSaveDirectory, writeLastSaveDirectory } = require("../settings-store");

test("falls back when settings are missing, damaged, or point to a non-directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "settings.json");
  const fallback = path.join(scratch, "Downloads");
  await fsp.mkdir(fallback);

  assert.equal(await readLastSaveDirectory(settingsPath, fallback), fallback);
  await fsp.writeFile(settingsPath, "not-json");
  assert.equal(await readLastSaveDirectory(settingsPath, fallback), fallback);
  await fsp.writeFile(settingsPath, JSON.stringify({ lastSaveDirectory: path.join(scratch, "missing") }));
  assert.equal(await readLastSaveDirectory(settingsPath, fallback), fallback);
  const filePath = path.join(scratch, "not-a-directory.txt");
  await fsp.writeFile(filePath, "x");
  await fsp.writeFile(settingsPath, JSON.stringify({ lastSaveDirectory: filePath }));
  assert.equal(await readLastSaveDirectory(settingsPath, fallback), fallback);
});

test("atomically stores and restores the last successful save directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-write-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "config", "settings.json");
  const fallback = path.join(scratch, "Downloads");
  const selected = path.join(scratch, "Converted");
  const selectedAgain = path.join(scratch, "Converted Again");
  await fsp.mkdir(fallback);
  await fsp.mkdir(selected);
  await fsp.mkdir(selectedAgain);

  await writeLastSaveDirectory(settingsPath, selected);

  assert.equal(await readLastSaveDirectory(settingsPath, fallback), selected);
  assert.deepEqual(JSON.parse(await fsp.readFile(settingsPath, "utf8")), { lastSaveDirectory: selected });
  assert.deepEqual((await fsp.readdir(path.dirname(settingsPath))).sort(), ["settings.json"]);

  await writeLastSaveDirectory(settingsPath, selectedAgain);
  assert.equal(await readLastSaveDirectory(settingsPath, fallback), selectedAgain);
  assert.deepEqual((await fsp.readdir(path.dirname(settingsPath))).sort(), ["settings.json"]);
});

test("refuses to remember a path that is not an existing directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-invalid-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  await assert.rejects(
    writeLastSaveDirectory(path.join(scratch, "settings.json"), path.join(scratch, "missing")),
    /目录/
  );
});
