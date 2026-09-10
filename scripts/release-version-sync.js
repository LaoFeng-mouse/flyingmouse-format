#!/usr/bin/env node
// release-version-sync.js — 版本 bump 原子化脚本（0.6.9 引入；0.6.10 复核 P5 改为真原子）。
// 背景：0.6.8 手工 bump（dd68899）漏改 win7-package-lock.json，Win7 构建校验把
// test / macOS×2 三个 CI job 全部拖红（docs/RELEASE.md 第 1 条要求的四文件一致，
// 靠人肉执行必然偶发漏项）。本脚本把全部落点一次改完：
//   package.json / package-lock.json（根+packages[""]）/ win7-package-lock.json（同）
//   / README.md 中英下载指引与发行文件名。
// 用法：node scripts/release-version-sync.js <new-version> [--dry-run]
// P5（2026-09-10 复核）：旧实现按序边校验边写盘，后序文件校验失败时前面已写入
// 的文件不回滚（实测 win7 lock 名称不合法 → package.json/根 lock 已变 0.6.10、
// 脚本却退出失败 = 半次升级）。现在分两阶段：
//   阶段一（零写入）：全部文件读入 → 校验 name/版本形态 → 在内存生成完整新内容
//     → README 回读断言（对内存字符串跑）→ 任何一步失败即刻退出，磁盘分毫未动。
//   阶段二（写盘+恢复）：逐文件写入；若中途 IO 失败（不可写/磁盘满），把本次
//     已写成功的文件逐一回滚为原内容后再退出失败。
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

function readJsonText(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return { text, data: JSON.parse(text) };
}

// 保持仓库现状：JSON 两空格缩进 + 原文件行尾风格 + 尾部换行。
function renderJson(originalText, obj) {
  const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(obj, null, 2);
  if (originalText.endsWith("\n")) text += "\n";
  return text.replace(/\n/g, eol);
}

const plan = []; // { rel, before, after, newText }
function planJson(rel, expectedName) {
  const { text, data } = readJsonText(rel);
  const before = data.version;
  if (data.name !== expectedName) throw new Error(`${rel} name=${data.name} 与预期 ${expectedName} 不符，中止。`);
  if (data.packages?.[""]?.name !== expectedName) throw new Error(`${rel} packages[""].name 不符，中止。`);
  if (!/^\d+\.\d+\.\d+$/.test(String(before))) throw new Error(`${rel} 当前版本非法: ${before}`);
  data.version = target;
  data.packages[""].version = target;
  plan.push({ rel, before, after: target, newText: renderJson(text, data) });
}

function planReadme() {
  const before = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const oldVersions = [...new Set([
    ...(before.match(/\bv\d+\.\d+\.\d+\b/g) || []).map((v) => v.slice(1)),
    ...(before.match(/(?<=Setup-)\d+\.\d+\.\d+(?=-)/g) || [])
  ].filter((v) => v !== target))];
  // 依赖版本（Electron 22.3.27 / Sharp 0.32.6 / PDF.js 2.16.105 / Turndown 7.2.0）
  // 两种形态都不命中，天然安全；其余裸 x.y.z 不动。
  const after = before
    .replace(/\bv\d+\.\d+\.\d+\b/g, `v${target}`)
    .replace(/(Setup-)\d+\.\d+\.\d+(-)/g, `$1${target}$2`);
  // 内存回读断言（旧实现写盘后才查残留，P5 前移到写入之前）。
  for (const stale of oldVersions) {
    if (after.includes(`v${stale}`) || after.includes(`Setup-${stale}-`)) {
      throw new Error(`README 仍残留旧版本 ${stale}，中止（未写入任何文件）。`);
    }
  }
  plan.push({
    rel: "README.md",
    before: before === after ? "无变化（已锚定版本）" : `版本串 ${JSON.stringify(oldVersions)} -> ${target}`,
    after: target,
    newText: after
  });
}

// ---- 阶段一：全部校验 + 内存生成（零写入） ----
const originals = new Map(); // rel -> 原文件内容（写盘失败时回滚用）
function snapshotOriginal(rel) {
  if (!originals.has(rel)) originals.set(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

try {
  const pkg = readJsonText("package.json");
  const pkgBefore = pkg.data.version;
  if (!/^\d+\.\d+\.\d+$/.test(pkgBefore)) throw new Error(`当前 package.json 版本非法: ${pkgBefore}`);
  snapshotOriginal("package.json");
  snapshotOriginal("package-lock.json");
  snapshotOriginal("win7-package-lock.json");
  snapshotOriginal("README.md");
  const pkgData = pkg.data;
  pkgData.version = target;
  plan.push({ rel: "package.json", before: pkgBefore, after: target, newText: renderJson(pkg.text, pkgData) });
  planJson("package-lock.json", pkg.data.name);
  planJson("win7-package-lock.json", "flyingmouse-format-win7");
  planReadme();
} catch (error) {
  console.error(`版本同步中止（未写入任何文件）：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

// 阶段一完成后的全量一致性断言：四个落点的内存产物必须都锚定 target。
{
  const pkgOut = JSON.parse(plan.find((c) => c.rel === "package.json").newText);
  for (const rel of ["package-lock.json", "win7-package-lock.json"]) {
    const lockOut = JSON.parse(plan.find((c) => c.rel === rel).newText);
    if (lockOut.version !== target || lockOut.packages[""].version !== target || pkgOut.version !== target) {
      console.error(`内存一致性断言失败: ${rel}（未写入任何文件）`);
      process.exit(1);
    }
  }
}

if (dryRun) {
  console.log(`[dry-run] 将修改 ${target}：`);
  for (const change of plan) console.log(`  - ${change.rel}: ${change.before} -> ${change.after}`);
  console.log("（--dry-run 未写入任何文件）");
  process.exit(0);
}

// ---- 阶段二：写盘；中途失败回滚已写文件 ----
const written = [];
try {
  for (const change of plan) {
    // A write may truncate the file and then throw (for example ENOSPC).
    // Include the attempted file in rollback before touching its bytes.
    written.push(change.rel);
    fs.writeFileSync(path.join(ROOT, change.rel), change.newText);
  }
} catch (error) {
  console.error(`写入 ${written[written.length - 1]} 失败，回滚本次尝试写入的 ${written.length} 个文件：${error instanceof Error ? error.message : error}`);
  for (const rel of written.reverse()) {
    try {
      fs.writeFileSync(path.join(ROOT, rel), originals.get(rel));
    } catch (rollbackError) {
      console.error(`  回滚 ${rel} 也失败（需手工恢复）：${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
    }
  }
  process.exit(1);
}

console.log(`已同步 ${target}：`);
for (const change of plan) console.log(`  - ${change.rel}: ${change.before} -> ${change.after}`);
