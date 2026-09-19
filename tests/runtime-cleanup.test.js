// 2026-09-07 产品决策测试：转换产物在程序运行期间永不过期。
// 旧行为：cleanupOldFiles 按 TTL 把 downloads 登记表条目删除 → 用户稍晚保存得 404。
// 新行为：登记表条目不删；磁盘上只回收「不在登记表里的孤儿残留」；退出时 purge
// 本实例目录；启动时回收历史实例的 runtime 目录。
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
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

async function exitedRuntimePids() {
  // Keep both children alive until allocated so their PIDs cannot be reused
  // between fixtures. Fixed PIDs may belong to a real process on a CI runner.
  const children = Array.from({ length: 2 }, () => spawn(
    process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" }
  ));
  const exits = children.map((child) => once(child, "close"));
  for (const child of children) child.stdin.end();
  const results = await Promise.all(exits);
  for (const [index, child] of children.entries()) {
    assert.equal(results[index][0], 0, "fixture process must exit successfully");
    assert.ok(child.pid > 0, "fixture must have a real PID");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" },
      "fixture process must have exited before cleanup");
  }
  assert.notEqual(children[0].pid, children[1].pid);
  return children.map((child) => child.pid);
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
  const [stalePid, freshPid] = await exitedRuntimePids();
  const current = path.join(parent, `fm-runtime-${process.pid}`);
  const stale = path.join(parent, `fm-runtime-${stalePid}`);
  const fresh = path.join(parent, `fm-runtime-${freshPid}`);
  const foreign = path.join(parent, "something-else");
  for (const dir of [current, stale, fresh, foreign]) await fsp.mkdir(dir);
  await fsp.writeFile(path.join(stale, "leftover.bin"), "x");
  const old = new Date(Date.now() - 3 * DAY_MS);
  await fsp.utimes(stale, old, old);
  await purgeStaleRuntimeDirs({ runtimeDir: current });
  assert.ok(fs.existsSync(current));
  assert.equal(fs.existsSync(stale), false, "stale sibling must be reclaimed");
  assert.ok(fs.existsSync(fresh), "recent exited-instance residue stays inside the grace period");
  assert.ok(fs.existsSync(foreign), "non-matching dirs are never touched");
});

test("purgeStaleRuntimeDirs preserves a running instance even when its directory is old", async (t) => {
  const parent = await scratchDir(t, "stale-live");
  const current = path.join(parent, "fm-runtime-99999999");
  const live = path.join(parent, `fm-runtime-${process.pid}`);
  await fsp.mkdir(current);
  await fsp.mkdir(live);
  const product = path.join(live, "unsaved.pdf");
  await fsp.writeFile(product, "user result");
  const old = new Date(Date.now() - 3 * DAY_MS);
  await fsp.utimes(live, old, old);
  await purgeStaleRuntimeDirs({ runtimeDir: current });
  assert.equal(await fsp.readFile(product, "utf8"), "user result");
});

test("purgeStaleRuntimeDirs never treats arbitrary prefix matches as owned instances", async (t) => {
  const parent = await scratchDir(t, "stale-boundary");
  const current = path.join(parent, "fm-runtime-99999999");
  const backup = path.join(parent, "fm-runtime-backup");
  await fsp.mkdir(current);
  await fsp.mkdir(backup);
  const old = new Date(Date.now() - 3 * DAY_MS);
  await fsp.utimes(backup, old, old);
  await purgeStaleRuntimeDirs({ runtimeDir: current });
  assert.ok(fs.existsSync(backup));
  await purgeStaleRuntimeDirs({ runtimeDir: path.join(parent, "fm-runtime") });
  assert.ok(fs.existsSync(backup), "an unscoped standalone runtime must not sweep siblings");
});

test("stale cleanup immediately reclaims a marked dead PID but preserves invalid identity and live owners", async t => {
  const parent=await scratchDir(t,"shutdown-reclaim");
  const [deadPid,otherPid]=await exitedRuntimePids();
  const current=path.join(parent,'fm-runtime-99999999');await fsp.mkdir(current);
  const marker=require('../desktop-shutdown').PENDING_CLEANUP_FILE;
  const fixtures=[[deadPid,true],[otherPid,false],[process.pid,true]];
  for(const [pid,valid] of fixtures){
    const dir=path.join(parent,`fm-runtime-${pid}`);await fsp.mkdir(dir);
    const stat=await fsp.lstat(dir);
    await fsp.writeFile(path.join(dir,marker),JSON.stringify({schema:1,pid,dev:stat.dev,ino:valid?stat.ino:-1}));
    await fsp.writeFile(path.join(dir,'keep-or-reclaim'),'fixture');
  }
  await purgeStaleRuntimeDirs({runtimeDir:current});
  assert.equal(fs.existsSync(path.join(parent,`fm-runtime-${deadPid}`)),false);
  assert.equal(fs.existsSync(path.join(parent,`fm-runtime-${otherPid}`)),true);
  assert.equal(fs.existsSync(path.join(parent,`fm-runtime-${process.pid}`)),true);
});
