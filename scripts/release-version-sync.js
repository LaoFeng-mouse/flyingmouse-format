#!/usr/bin/env node
// release-version-sync.js — 版本 bump 原子化脚本（0.6.9 稳定性线新增）。
// 背景：0.6.8 手工 bump（dd68899）漏改 win7-package-lock.json，Win7 构建校验把
// test / macOS×2 三个 CI job 全部拖红（docs/RELEASE.md 第 1 条要求的四文件一致，
// 靠人肉执行必然偶发漏项）。本脚本把全部落点一次改完：
//   package.json / package-lock.json（根+packages[""]）/ win7-package-lock.json（同）
//   / README.md 中英下载指引与发行文件名。
// 用法：node scripts/release-version-sync.js <new-version> [--dry-run]
// 校验：语义化版本 x.y.z；改完对读回的 JSON 做全等断言，防正则误伤。
// 注意：README 的旧版本串以文件自身为准（它可能滞后于 package.json——0.6.8 bump
// 时 README 停在 0.6.7 正是这次要防的漂移），逐串替换所有形如 x.y.z 的旧版本号。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const target = process.argv[2] || "";
const dryRun = process.argv.includes("--dry-run");

if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`用法: node scripts/release-version-sync.js <x.y.z> [--dry-run]（收到: ${target || "无"}）`);
  process.exit(1);
}

function readJson(rel) {
  return { file: path.join(ROOT, rel), data: JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) };
}

function writeJson(rel, obj) {
  // 保持仓库现状：JSON 两空格缩进 + CRLF 行尾 + 尾部换行（win7 lock 实测 \r\n）。
  const original = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(obj, null, 2);
  if (original.endsWith("\n") || original.endsWith("\r\n")) text += "\n";
  fs.writeFileSync(path.join(ROOT, rel), text.replace(/\n/g, eol));
}

const changes = [];

function bumpLockfile(rel, expectedName) {
  const { file, data } = readJson(rel);
  const before = data.version;
  if (data.name !== expectedName) throw new Error(`${rel} name=${data.name} 与预期 ${expectedName} 不符，中止。`);
  if (data.packages?.[""]?.name !== expectedName) throw new Error(`${rel} packages[""].name 不符，中止。`);
  data.version = target;
  data.packages[""].version = target;
  changes.push({ file, before, after: target });
  if (!dryRun) writeJson(rel, data);
}

// 1. package.json
const pkgPath = path.join(ROOT, "package.json");
const pkg = readJson("package.json");
const pkgBefore = pkg.data.version;
if (!/^\d+\.\d+\.\d+$/.test(pkgBefore)) throw new Error(`当前 package.json 版本非法: ${pkgBefore}`);
pkg.data.version = target;
changes.push({ file: pkgPath, before: pkgBefore, after: target });
if (!dryRun) writeJson("package.json", pkg.data);

// 2/3. 两个 lockfile（build-win7.js 校验 packages[""] 与根同名同版，必须同步）
bumpLockfile("package-lock.json", pkg.data.name);
bumpLockfile("win7-package-lock.json", "flyingmouse-format-win7");

// 4. README：按两种确定形态替换（行级保护作废——依赖版本与 Setup 文件名可能同
//    在一行，如 L86「Setup-0.6.7-win7…固定 Electron 22.3.27」）：
//    a) `v0.6.7`（下载指引 + 门禁叙述，唯一带 v 前缀的版本形态）
//    b) `Setup-0.6.7-`（中英全部发行资产文件名）
//    依赖版本（Electron 22.3.27 / Sharp 0.32.6 / PDF.js 2.16.105 / Turndown 7.2.0）
//    两种形态都不命中，天然安全；其余裸 x.y.z 不动。
const readmePath = path.join(ROOT, "README.md");
const readmeBefore = fs.readFileSync(readmePath, "utf8");
const readmeOldVersions = [...new Set([
  ...(readmeBefore.match(/\bv\d+\.\d+\.\d+\b/g) || []).map((v) => v.slice(1)),
  ...(readmeBefore.match(/(?<=Setup-)\d+\.\d+\.\d+(?=-)/g) || [])
].filter((v) => v !== target))];
const readmeAfter = readmeBefore
  .replace(/\bv\d+\.\d+\.\d+\b/g, `v${target}`)
  .replace(/(Setup-)\d+\.\d+\.\d+(-)/g, `$1${target}$2`);
changes.push({
  file: readmePath,
  before: readmeBefore === readmeAfter ? "无变化（已锚定版本）" : `版本串 ${JSON.stringify(readmeOldVersions)} -> ${target}`,
  after: target
});
if (!dryRun) fs.writeFileSync(readmePath, readmeAfter);

// 5. 回读断言：改后文件版本必须一致（脚本自身先执行 CI 守卫的不变量）。
if (!dryRun) {
  const check = [
    ["package.json", (d) => d.version],
    ["package-lock.json", (d) => `${d.version}|${d.packages[""].version}`],
    ["win7-package-lock.json", (d) => `${d.version}|${d.packages[""].version}`]
  ];
  for (const [rel, pick] of check) {
    const value = pick(readJson(rel).data);
    const expect = rel === "package.json" ? target : `${target}|${target}`;
    if (value !== expect) throw new Error(`回读校验失败: ${rel} = ${value}（期望 ${expect}）`);
  }
  const finalReadme = fs.readFileSync(readmePath, "utf8");
  for (const stale of readmeOldVersions) {
    if (finalReadme.includes(`v${stale}`) || finalReadme.includes(`Setup-${stale}-`)) {
      throw new Error(`README 仍残留旧版本 ${stale}`);
    }
  }
}

console.log(`${dryRun ? "[dry-run] 将修改" : "已同步"} ${target}：`);
for (const change of changes) console.log(`  - ${path.relative(ROOT, change.file)}: ${change.before} -> ${change.after}`);
if (dryRun) console.log("（--dry-run 未写入任何文件）");
