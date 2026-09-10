const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// 版本 bump 一致性守卫（2026-09-10，0.6.8 CI 红事故回归）：
// dd68899 bump 0.6.8 时漏改 win7-package-lock.json，build-win7 校验在 test/macos
// 全部 job 炸红。docs/RELEASE.md 第 1 条要求的「四文件一致」在这里变成可执行门禁。
// scripts/build-version-sync.js（npm run version:sync）从源头防止漂移，本测试兜底。

const ROOT = path.join(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

test("package.json 与 package-lock.json 版本一致", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, pkg.version, "package-lock.json 根 version 漂移");
  assert.equal(lock.packages[""].version, pkg.version, 'package-lock.json packages[""] version 漂移');
});

test("win7-package-lock.json 与主版本一致（Win7 构建校验的镜像断言）", () => {
  const pkg = readJson("package.json");
  const win7Lock = readJson("win7-package-lock.json");
  assert.equal(win7Lock.version, pkg.version, "win7-package-lock.json 根 version 漂移");
  assert.equal(win7Lock.packages[""].version, pkg.version, 'win7-package-lock.json packages[""] version 漂移');
});

test("README 下载指引与发行文件名锚定当前版本（防 0.6.7 残留复发）", () => {
  const version = readJson("package.json").version;
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, new RegExp(`下载 v${version.replace(/\./g, "\\.")} 对应系统的安装包`), "README 中文快速开始仍是旧版本");
  assert.ok(readme.includes(`-Setup-${version}-x64.exe`), "README 标准版资产名未锚定当前版本");
  assert.ok(readme.includes(`-Setup-${version}-win7-x64.exe`), "README Win7 资产名未锚定当前版本");
});
