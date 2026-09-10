const assert = require("node:assert/strict");
const { test } = require("node:test");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createSynchronizer, mergeSettings } = require("../public/settings-sync");
const { readSettings, updateSettings } = require("../settings-store");

test("unrelated patches never manufacture an empty source preference map", () => {
  assert.deepEqual(mergeSettings({}, { theme: "dark" }), { theme: "dark" });
  assert.deepEqual(mergeSettings({ theme: "dark" }, { language: "en-US" }), { theme: "dark", language: "en-US" });
});

test("real settings store preserves source preferences across theme failure, retry, and restart", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-settings-sync-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  const expected = { pdf: "docx", png: "webp", txt: "md" };
  await updateSettings(file, { targetBySource: expected, theme: "dark" });
  let state = await readSettings(file);
  let fail = true;
  const patches = [];
  const sync = createSynchronizer({ get: () => state, set: value => { state = value; }, save: async patch => {
    patches.push(patch);
    if (fail) { fail = false; throw Error("disk full"); }
    return updateSettings(file, patch);
  } });
  await assert.rejects(sync.persist({ theme: "light" }), /disk full/);
  assert.deepEqual(state.targetBySource, expected);
  await sync.persist({ language: "en-US" });
  assert.deepEqual(state.targetBySource, expected);
  const restarted = await readSettings(file);
  assert.deepEqual(restarted.targetBySource, expected);
  assert.equal(restarted.theme, "light");
  assert.equal(restarted.language, "en-US");
  assert.ok(patches.every(patch => !Object.hasOwn(patch, "targetBySource")));
});

test("a partial source edit sends the current complete map to the replacing main-process store", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-settings-partial-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  await updateSettings(file, { targetBySource: { pdf: "png", png: "webp" } });
  let state = await readSettings(file);
  const sync = createSynchronizer({ get: () => state, set: value => { state = value; }, save: patch => updateSettings(file, patch) });
  await sync.persist({ targetBySource: { pdf: "docx" } });
  await sync.persist({ theme: "dark" });
  assert.deepEqual((await readSettings(file)).targetBySource, { pdf: "docx", png: "webp" });
});

test("failed target edit is retried with the next language save without losing the local choice", async () => {
  let disk = { targetBySource: { pdf: "png" }, language: "zh-CN" };
  let state = structuredClone(disk);
  let fail = true;
  const sync = createSynchronizer({ get: () => state, set: value => { state = value; }, save: async patch => {
    if (fail) { fail = false; throw Error("disk full"); }
    disk = mergeSettings(disk, patch); return structuredClone(disk);
  } });
  await assert.rejects(sync.persist({ targetBySource: { pdf: "docx" } }), /disk full/);
  assert.equal(state.targetBySource.pdf, "docx");
  await sync.persist({ language: "en-US" });
  assert.equal(state.targetBySource.pdf, "docx");
  assert.equal(disk.targetBySource.pdf, "docx");
  assert.equal(disk.language, "en-US");
});

test("a slow success and subsequent failure cannot undo a newer target or theme choice", async () => {
  let state = { targetBySource: { pdf: "png" } };
  let release;
  let count = 0;
  const sync = createSynchronizer({ get: () => state, set: value => { state = value; }, save: async patch => {
    if (++count === 1) { await new Promise(r => { release = r; }); return { ...patch, lastSaveDirectory: "example" }; }
    throw Error("locked");
  } });
  const first = sync.persist({ targetBySource: { pdf: "docx" } });
  await new Promise(r => setImmediate(r));
  const second = sync.persist({ targetBySource: { pdf: "txt" }, theme: "dark" });
  const rejected = assert.rejects(second, /locked/);
  release(); await first; await rejected;
  assert.equal(state.targetBySource.pdf, "txt");
  assert.equal(state.theme, "dark");
  assert.equal(state.lastSaveDirectory, "example");
});

test("a delayed startup restore preserves even already acknowledged user edits", async () => {
  let state = { targetBySource: {} };
  const sync = createSynchronizer({ get: () => state, set: value => { state = value; }, save: async patch => patch });
  await sync.persist({ theme: "light", targetBySource: { pdf: "docx" } });
  sync.restore({ theme: "dark", language: "en-US", targetBySource: { pdf: "png", txt: "md" } });
  assert.equal(state.theme, "light");
  assert.deepEqual(state.targetBySource, { pdf: "docx", txt: "md" });
  assert.equal(state.language, "en-US");
});
