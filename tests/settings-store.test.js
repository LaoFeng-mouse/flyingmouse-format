const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  mergeLegacySettings,
  readLastSaveDirectory,
  readSettings,
  updateSettings,
  writeLastSaveDirectory
} = require("../settings-store");

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
  assert.deepEqual(JSON.parse(await fsp.readFile(settingsPath, "utf8")), {
    schemaVersion: 2,
    lastSaveDirectory: selected,
    targetBySource: {}
  });
  assert.deepEqual((await fsp.readdir(path.dirname(settingsPath))).sort(), ["settings.json"]);

  await writeLastSaveDirectory(settingsPath, selectedAgain);
  assert.equal(await readLastSaveDirectory(settingsPath, fallback), selectedAgain);
  assert.deepEqual((await fsp.readdir(path.dirname(settingsPath))).sort(), ["settings.json"]);
});

test("stores target mappings and language without erasing the save directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-v2-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "settings.json");
  const directory = path.join(scratch, "Converted");
  await fsp.mkdir(directory);

  await writeLastSaveDirectory(settingsPath, directory);
  await updateSettings(settingsPath, {
    targetBySource: { PDF: "XLSX", jpeg: "PNG" },
    language: "en-US"
  });

  assert.deepEqual(await readSettings(settingsPath), {
    schemaVersion: 2,
    lastSaveDirectory: directory,
    targetBySource: { pdf: "xlsx", jpg: "png" },
    language: "en-US"
  });
});

test("legacy migration fills missing mappings without overwriting newer choices", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-migrate-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "settings.json");
  await updateSettings(settingsPath, { targetBySource: { pdf: "png" } });

  const merged = await mergeLegacySettings(settingsPath, {
    targetBySource: { pdf: "xlsx", flac: "mp3" },
    language: "zh-CN"
  });

  assert.deepEqual(merged.targetBySource, { pdf: "png", flac: "mp3" });
  assert.equal(merged.language, "zh-CN");
});

test("refuses to remember a path that is not an existing directory", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-invalid-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  await assert.rejects(
    writeLastSaveDirectory(path.join(scratch, "settings.json"), path.join(scratch, "missing")),
    /目录/
  );
});

// S2（2026-09-10 商店审计）：无旧设置可迁移时不得产生磁盘写入——0.6.4 商店版
// 每次启动都白写一次并走 EXDEV copy 回退，AppContainer 重定向盘上纯耗 IO。
test("empty legacy migration is idempotent and does not touch the disk", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-idempotent-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "settings.json");
  await updateSettings(settingsPath, { targetBySource: { pdf: "png" }, language: "zh-CN" });
  const mtimeBefore = (await fsp.stat(settingsPath)).mtimeMs;

  const merged = await mergeLegacySettings(settingsPath, { targetBySource: {}, language: null });
  assert.deepEqual(merged.targetBySource, { pdf: "png" });
  assert.equal(merged.language, "zh-CN");
  const mtimeAfter = (await fsp.stat(settingsPath)).mtimeMs;
  assert.equal(mtimeAfter, mtimeBefore, "内容未变时迁移不得重写 settings 文件");

  // 全新路径 + 空 legacy：连文件都不该被创建出来。
  const freshPath = path.join(scratch, "fresh-settings.json");
  await mergeLegacySettings(freshPath, {});
  await assert.rejects(fsp.access(freshPath), "空迁移不得创建 settings 文件");
});

// S3（2026-09-10 商店审计）：并发 read-modify-write 不得互相覆盖（原子 rename
// 解决不了旧快照竞争——两请求都读到同一基线，后写把先写的字段连带吃掉）。
// 复现审计场景：同时改语言和默认格式。targetBySource 本身是全量替换语义
// （前端发完整 map），跨字段共存才是这里要守的不变量。
test("concurrent setting updates all survive (per-path mutation lock)", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-settings-race-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const settingsPath = path.join(scratch, "settings.json");
  const directory = path.join(scratch, "Converted");
  await fsp.mkdir(directory);
  await updateSettings(settingsPath, { targetBySource: { pdf: "png" } });

  await Promise.all([
    updateSettings(settingsPath, { language: "zh-CN" }),
    updateSettings(settingsPath, { lastSaveDirectory: directory })
  ]);

  const final = await readSettings(settingsPath);
  assert.equal(final.language, "zh-CN", "并发的语言更新被覆盖丢失");
  assert.equal(final.lastSaveDirectory, directory, "并发的保存目录更新被覆盖丢失");
  assert.deepEqual(final.targetBySource, { pdf: "png" }, "无关字段不得被顺带抹掉");
});
