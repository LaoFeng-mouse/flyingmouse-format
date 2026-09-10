#!/usr/bin/env node
// build-engine-manifest.js — 打包期生成 LibreOffice 引擎关键文件清单（0.6.10 P3）。
// 运行时校验缓存/复制产物完整性；旧包没有有效清单时必须执行真实转换验证，
// 不能仅凭入口和 .complete 放行。
//
// 收录策略：
//   - 入口与启动骨架：soffice.com/.bin/.ini、bootstraplo/sal3/mergedlo/vclplug_winlo/
//     stocserviceslo、icu*、i18nlangtag
//   - Writer/Calc/Impress 组件（swlo/sclo/sdlo）——冒烟 CSV→PDF 用到 Calc+导出链，
//     真实转换用到 Writer/Impress
//   - 注册表资源：share/registry/*.xcd（过滤器/组件注册全在其中）
//   - 大小全记录；≤5MB 的加 sha256（mergedlo 147MB 级只 stat——全量哈希会拖垮
//     AppContainer 盘上的首启，大文件损坏由冒烟转换兜底）。
// 用法：node scripts/build-engine-manifest.js [bundleDir]   默认 bin/libreoffice
// 产物：<bundleDir>/engine-integrity.json（随 extraResources 进包）

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const bundleDir = path.resolve(process.argv[2] || path.join(ROOT, "bin", "libreoffice"));
const LO_ROOT = "LibreOfficePortable/App/libreoffice";
const HASH_SIZE_LIMIT = 5 * 1024 * 1024;

const CRITICAL_BASENAMES = [
  "soffice.com",
  "soffice.bin",
  "soffice.ini",
  "bootstraplo.dll",
  "sal3.dll",
  "mergedlo.dll",
  "vclplug_winlo.dll",
  "stocserviceslo.dll",
  "i18nlangtag.dll",
  "swlo.dll",
  "sclo.dll",
  "sdlo.dll",
  "gengal.exe"
];

function collect() {
  const programDir = path.join(bundleDir, ...LO_ROOT.split("/"), "program");
  const programRel = `${LO_ROOT}/program`;
  const shareRel = `${LO_ROOT}/share/registry`;
  if (!fs.existsSync(programDir)) {
    throw new Error(`引擎 program 目录不存在: ${programDir}（先恢复 bin/libreoffice 再生成清单）`);
  }
  const wanted = new Set(CRITICAL_BASENAMES);
  const found = new Map();
  for (const name of fs.readdirSync(programDir)) {
    const lower = name.toLowerCase();
    if (wanted.has(lower) || /^icu(uc|u|in|dt)\d+\.dll$/.test(lower)) found.set(lower, name);
  }
  const files = {};
  const missing = [];
  for (const family of ["(?:uc|u)", "in", "dt"]) {
    if (![...found.keys()].some((name) => new RegExp(`^icu${family}\\d+\\.dll$`).test(name))) {
      missing.push(`${programRel}/icu${family}*.dll`);
    }
  }
  for (const base of new Set([...wanted, ...found.keys()])) {
    const actual = found.get(base);
    if (base === "gengal.exe" && !actual) continue; // 可选辅助工具，不作关键项
    if (!actual) {
      missing.push(`${programRel}/${base}`);
      continue;
    }
    const rel = `${programRel}/${actual}`;
    const stat = fs.statSync(path.join(programDir, actual));
    const entry = { size: stat.size };
    if (stat.size <= HASH_SIZE_LIMIT) {
      entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(programDir, actual))).digest("hex");
    }
    files[rel] = entry;
  }
  // 注册表 xcd（存在哪些收哪些，main.xcd 必须在）
  const registryDir = path.join(bundleDir, ...shareRel.split("/"));
  if (fs.existsSync(registryDir)) {
    for (const name of fs.readdirSync(registryDir).filter((n) => n.endsWith(".xcd"))) {
      const stat = fs.statSync(path.join(registryDir, name));
      const entry = { size: stat.size };
      if (stat.size <= HASH_SIZE_LIMIT) {
        entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(registryDir, name))).digest("hex");
      }
      files[`${shareRel}/${name}`] = entry;
    }
    if (!fs.existsSync(path.join(registryDir, "main.xcd"))) missing.push(`${shareRel}/main.xcd`);
  } else {
    missing.push(`${shareRel}/ (registry 目录)`);
  }
  if (missing.length) {
    throw new Error(`来源引擎包本身缺少关键文件，禁止生成清单（这正是 P3 要挡的故障——先修 bundle）:\n  ${missing.join("\n  ")}`);
  }
  return files;
}

const manifest = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  hashSizeLimitBytes: HASH_SIZE_LIMIT,
  files: collect()
};
const outPath = path.join(bundleDir, "engine-integrity.json");
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`已生成 ${path.relative(ROOT, outPath)}：${Object.keys(manifest.files).length} 个关键文件（含 sha256: ${Object.values(manifest.files).filter((f) => f.sha256).length}）`);
