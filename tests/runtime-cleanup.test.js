// 2026-09-07 产品决策测试：转换产物在程序运行期间永不过期。
// 旧行为：cleanupOldFiles 按 TTL 把 downloads 登记表条目删除 → 用户稍晚保存得 404。
// 新行为：登记表条目不删；磁盘上只回收「不在登记表里的孤儿残留」；退出时 purge
// 本实例目录；启动时回收历史实例的 runtime 目录。
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  cleanupOldFiles,
  purgeRuntimeDirs,
  purgeRuntimeDirsSync,
  purgeStaleRuntimeDirs
} = require("../server");

const DAY_MS = 1000 * 60 * 60 * 24;

async function scratchDir(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `fm-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

async function touch(filePath, { ageMs = 0, content = "x" } = {}) {
  await fsp.writeFile(filePath, content);
  const when = new Date(Date.now() - ageMs);
  await fsp.utimes(filePath, when, when);
}

test("cleanupOldFiles never removes registered products, however old", async (t) => {
  const dir = await scratchDir(t, "cleanup-keep");
  const registered = path.join(dir, "ancient.docx");
  await touch(registered, { ageMs: 10 * DAY_MS });
  const registry = new Map([["id1", { filePath: registered }]]);
  await cleanupOldFiles({ dirs: [dir], registry });
  assert.ok(fs.existsSync(registered), "registered product must survive any age");
});

test("cleanupOldFiles keeps unregistered files inside the grace period", async (t) => {
  const dir = await scratchDir(t, "cleanup-grace");
  const recent = path.join(dir, "fresh-upload.bin");
  await touch(recent, { ageMs: 1000 });
  await cleanupOldFiles({ dirs: [dir], registry: new Map() });
  assert.ok(fs.existsSync(recent));
});

test("cleanupOldFiles removes orphan residue past the grace period", async (t) => {
  const dir = await scratchDir(t, "cleanup-orphan");
  const orphan = path.join(dir, "stale-crash-part.bin");
  const orphanDir = path.join(dir, "stale.assets");
  await touch(orphan, { ageMs: 2 * DAY_MS });
  await fsp.mkdir(orphanDir);
  await touch(path.join(dir, "keep.md"), { ageMs: 2 * DAY_MS });
  const registry = new Map([["id2", { filePath: path.join(dir, "keep.md"), assetsDir: orphanDir }]]);
  await cleanupOldFiles({ dirs: [dir], registry });
  assert.equal(fs.existsSync(orphan), false, "orphan file must be reclaimed");
  assert.ok(fs.existsSync(orphanDir), "registered assets dir must survive");
  assert.ok(fs.existsSync(path.join(dir, "keep.md")));
});

test("purgeRuntimeDirsSync wipes and recreates instance dirs", async (t) => {
  const root = await scratchDir(t, "purge");
  const upload = path.join(root, "uploads");
  const out = path.join(root, "converted");
  await fsp.mkdir(upload);
  await fsp.mkdir(out);
  await fsp.writeFile(path.join(out, "product.docx"), "x");
  purgeRuntimeDirsSync({ dirs: [upload, out] });
  assert.equal(fs.existsSync(path.join(out, "product.docx")), false);
  assert.ok(fs.existsSync(out), "dir must be recreated");
});

test("purgeStaleRuntimeDirs reclaims old sibling instance dirs only", async (t) => {
  const parent = await scratchDir(t, "stale-parent");
  const current = path.join(parent, "fm-runtime-9999");
  const stale = path.join(parent, "fm-runtime-1111");
  const fresh = path.join(parent, "fm-runtime-2222");
  const foreign = path.join(parent, "something-else");
  for (const dir of [current, stale, fresh, foreign]) await fsp.mkdir(dir);
  await fsp.writeFile(path.join(stale, "leftover.bin"), "x");
  const old = new Date(Date.now() - 3 * DAY_MS);
  await fsp.utimes(stale, old, old);
  await purgeStaleRuntimeDirs({ runtimeDir: current });
  assert.ok(fs.existsSync(current));
  assert.equal(fs.existsSync(stale), false, "stale sibling must be reclaimed");
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(foreign), "non-matching dirs are never touched");
});
