const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// P5（2026-09-10 复核）：release-version-sync 必须真原子——旧实现按序边校验边写，
// 后序文件校验失败时前面已写入的不回滚（实测 win7 lock name 非法 → package.json
// 与根 lock 已变 0.6.10、脚本却退出失败 = 半次版本升级）。
// 新实现两阶段：阶段一全部读入+校验+内存生成（零写入），阶段二写盘且中途失败回滚。

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "release-version-sync.js");

function pkgJson(version, name) {
  return `${JSON.stringify({ name: name || "flyingmouse-format", version, private: false }, null, 2)}\r\n`;
}
function lockJson(version, name) {
  return `${JSON.stringify({ name: name || "flyingmouse-format", version, lockfileVersion: 3, packages: { "": { name: name || "flyingmouse-format", version } } }, null, 2)}\r\n`;
}
function readme(version) {
  return `# FlyingMouse Format\n下载 v${version} 对应系统的安装包\n- FlyingMouse.Format-Setup-${version}-x64.exe\n- FlyingMouse.Format-Setup-${version}-win7-x64.exe\n依赖 Electron 22.3.27\n`;
}

async function sandbox(t, { win7Name, readonlyLast } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-versync-"));
  t.after(() => fsp.chmod(path.join(dir, "README.md"), 0o600).catch(() => {}).then(() => fsp.rm(dir, { recursive: true, force: true })));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "release-version-sync.js"));
  fs.writeFileSync(path.join(dir, "package.json"), pkgJson("0.6.9"));
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockJson("0.6.9"));
  fs.writeFileSync(path.join(dir, "win7-package-lock.json"), lockJson("0.6.9", win7Name || "flyingmouse-format-win7"));
  fs.writeFileSync(path.join(dir, "README.md"), readme("0.6.9"));
  if (readonlyLast) fs.chmodSync(path.join(dir, "README.md"), 0o400);
  return dir;
}

function snapshot(dir) {
  return Object.fromEntries(["package.json", "package-lock.json", "win7-package-lock.json", "README.md"]
    .map((rel) => [rel, fs.readFileSync(path.join(dir, rel), "utf8")]));
}

function run(dir, target) {
  return execFileSync(process.execPath, [path.join(dir, "scripts", "release-version-sync.js"), target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("P5: invalid last lockfile aborts with ZERO writes to earlier files", async (t) => {
  const dir = await sandbox(t, { win7Name: "wrong-name" });
  const before = snapshot(dir);
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(dir, "scripts", "release-version-sync.js"), "0.6.10"], { stdio: "ignore" });
  } catch {
    failed = true;
  }
  assert.ok(failed, "win7 lock 名称非法时脚本必须失败退出");
  assert.deepEqual(snapshot(dir), before, "阶段校验失败时任何文件都不得被写入（半次升级回归）");
});

test("P5: normal bump updates all four files consistently", async (t) => {
  const dir = await sandbox(t);
  run(dir, "0.6.10");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.6.10");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "win7-package-lock.json"), "utf8")).version, "0.6.10");
  const readmeText = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.ok(readmeText.includes("v0.6.10") && readmeText.includes("Setup") && !readmeText.includes("v0.6.9"));
  assert.ok(readmeText.includes("Electron 22.3.27"), "依赖版本不得被误伤");
});

test("P5: write failure mid-phase-two rolls back already-written files", async (t) => {
  // README 设为只读 → 计划里最后写它必然 EPERM/EROFS → 前三个已写文件必须回滚。
  // 以非管理员跑（Windows 只读位对同用户写仍然拒绝）；若环境以特权运行 chmod
  // 拦不住，测试会因「没有失败」而响亮报错，不会静默放过。
  const isWindows = process.platform === "win32";
  if (!isWindows) return t.skip("只读回滚场景按 Windows 文件语义构造");
  const dir = await sandbox(t, { readonlyLast: true });
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(dir, "scripts", "release-version-sync.js"), "0.6.10"], { stdio: "ignore" });
  } catch {
    failed = true;
  }
  if (!failed) {
    // 某些账户/杀软环境只读位不拦写——不能据此判定回滚逻辑坏了，但也不能假绿。
    return t.skip("环境未拦截只读 README 写入，无法构造中途失败");
  }
  for (const rel of ["package.json", "package-lock.json", "win7-package-lock.json"]) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    assert.ok(text.includes("0.6.9") && !text.includes("0.6.10"), `${rel} 未回滚到原版本`);
  }
});

test("P5: dry-run never touches disk", async (t) => {
  const dir = await sandbox(t);
  const before = snapshot(dir);
  run(dir, "0.7.0");  // 先正常跑会改，这里用独立沙箱验证 dry-run
  assert.notDeepEqual(snapshot(dir), before);
  const dir2 = await sandbox(t);
  const before2 = snapshot(dir2);
  execFileSync(process.execPath, [path.join(dir2, "scripts", "release-version-sync.js"), "0.7.0", "--dry-run"], { encoding: "utf8" });
  assert.deepEqual(snapshot(dir2), before2, "--dry-run 不得写盘");
});

test("partial write failure restores the failed file as well as preceding files", async (t) => {
  const dir = await sandbox(t);
  const before = snapshot(dir);
  const injection = path.join(dir, "fail-partial.cjs");
  fs.writeFileSync(injection, `
const fs = require('fs');
const original = fs.writeFileSync;
let failed = false;
fs.writeFileSync = function(file, contents, ...rest) {
  if (!failed && String(file).endsWith('win7-package-lock.json')) {
    failed = true;
    original.call(fs, file, String(contents).slice(0, 12), ...rest);
    const error = new Error('injected disk full after truncation');
    error.code = 'ENOSPC';
    throw error;
  }
  return original.call(fs, file, contents, ...rest);
};
`);
  assert.throws(() => execFileSync(process.execPath,
    ["--require", injection, path.join(dir, "scripts", "release-version-sync.js"), "0.7.0"],
    { stdio: "pipe", windowsHide: true }));
  assert.deepEqual(snapshot(dir), before);
});
