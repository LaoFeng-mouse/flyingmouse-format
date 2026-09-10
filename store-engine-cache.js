// store-engine-cache.js — 商店（MSIX/AppContainer）环境下把只读 resources 里的
// LibreOffice 引擎复制到可写位并证明其可用（0.6.10 P3）。
//
// 0.6.9 旧逻辑的教训（2026-09-10 复核 P3）：接受缓存只看 `soffice.com 存在 +
// .complete 存在`，但 .complete 只证明「复制代码走完」，不证明「引擎能转换文件」：
//   - 缓存里缺关键 DLL/注册表资源 → 代码仍直接使用半套引擎；
//   - 来源包本身残缺但含 soffice.com → 复制完成照样写 .complete，还会清掉本来
//     可用的旧版本缓存。
// 新流程（评审建议原样落地）：
//   复制到 <final>.staging → 按打包期清单校验关键文件（大小，小文件加 sha256）
//   → 用最小 CSV 做一次真实 --convert-to pdf 并验证输出 → rename 发布为可用
//   缓存 → 写 .complete → 回收其余旧缓存目录。
// 任何一步失败：只清 staging，绝不发布半成品；旧缓存（若通过完整性校验）不受
// 影响。全部判定 fail-soft：清单缺失（旧包/dev 树）退回 0.6.9 行为但 smoke
// 仍然执行——「能转一个真文件」是最低可用标准。

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const MANIFEST_FILE = "engine-integrity.json";
const STAGING_SUFFIX = ".staging";
// 冒烟转换超时：商店盘冷启 LO + 建 profile 实测可达十几秒，给足余量；超时=不可用。
const SMOKE_TIMEOUT_MS = 90000;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readManifest(bundleDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, MANIFEST_FILE), "utf8"));
    if (!manifest || manifest.schema !== 1 || typeof manifest.files !== "object" || !manifest.files) return null;
    return manifest;
  } catch {
    return null;
  }
}

// 校验 manifest 收录的关键文件（相对 bundle 根）：必须存在、size 一致；
// 带 sha256 的（清单里均为几 MB 内的小文件）再比对哈希。大文件（mergedlo 等
// 147MB 级）只 stat 不读——全量哈希会在商店盘上拖垮首启，由冒烟转换兜底。
function verifyIntegrity(bundleDir, manifest) {
  if (!manifest) return { ok: true, checked: 0 };
  let checked = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const filePath = path.join(bundleDir, ...rel.split("/"));
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      if (typeof entry.size === "number" && stat.size !== entry.size) {
        return { ok: false, reason: `size 不符: ${rel} 实际 ${stat.size} 期望 ${entry.size}` };
      }
      if (entry.sha256 && sha256File(filePath) !== entry.sha256) {
        return { ok: false, reason: `sha256 不符: ${rel}` };
      }
      checked += 1;
    } catch {
      return { ok: false, reason: `关键文件缺失: ${rel}` };
    }
  }
  return { ok: true, checked };
}

// 真实冒烟：最小 CSV → PDF。走完整 soffice 启动链（bootstrap/vcl/uno/Calc 组件/
// PDF 导出过滤器），输出必须以 %PDF 开头且非空。options.smokeTest 供测试注入。
// 同步实现（execFileSync）：本函数在建窗前引导阶段调用，与旧实现的同步 cpSync
// 同量级阻塞；「首启同步等待」的体感优化另行立项，不混入本安全修复。
function defaultSmokeTest(sofficePath, options = {}) {
  const { exec = execFileSync, timeoutMs = SMOKE_TIMEOUT_MS, tmpRoot } = options;
  let workDir = null;
  try {
    workDir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), "fm-engine-smoke-"));
    const inDir = path.join(workDir, "in");
    const outDir = path.join(workDir, "out");
    const profileDir = path.join(workDir, "profile");
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir);
    fs.mkdirSync(profileDir);
    const csvPath = path.join(inDir, "smoke.csv");
    fs.writeFileSync(csvPath, "name,value\nflyingmouse,42\n", "utf8");
    exec(
      sofficePath,
      [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--nodefault",
        "--nolockcheck",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        csvPath
      ],
      { timeout: timeoutMs, windowsHide: true }
    );
    const pdfPath = path.join(outDir, "smoke.pdf");
    if (!fs.existsSync(pdfPath)) return { ok: false, reason: "冒烟转换无输出文件" };
    const head = fs.readFileSync(pdfPath).slice(0, 5).toString("latin1");
    if (!head.startsWith("%PDF")) return { ok: false, reason: "冒烟输出不是有效 PDF" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `冒烟转换失败: ${error instanceof Error ? error.message : error}` };
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// 已发布缓存的接受判定：入口 + .complete + （有清单时）关键文件完整性。
// 返回 false = 半套/损坏/过期，一律走重建。
function isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest }) {
  if (!fs.existsSync(destSoffice) || !fs.existsSync(completeMarker)) return false;
  if (!manifest) return true; // 旧包无清单可比（0.6.9 及更早缓存），入口存在即维持原判
  return verifyIntegrity(destBundle, manifest).ok;
}

// 主流程。所有路径由调用方（electron-main）注入，本模块不依赖 electron，可单测。
// 全同步：在建窗口前的引导阶段执行（与旧实现 cpSync 同一时机），避免异步化引入
// 「配置未就绪先开窗」的新竞态。返回 { path, source, reason? }。
function prepareWritableEngineBundle(options) {
  const {
    bundledBundle,
    bundledSofficePath,
    enginesRoot,
    bundleName,
    smokeTest = defaultSmokeTest,
    log = () => {},
    tmpRoot
  } = options;
  const destBundle = path.join(enginesRoot, bundleName);
  const stagingDir = `${destBundle}${STAGING_SUFFIX}`;
  const destSoffice = path.join(destBundle, "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
  const completeMarker = path.join(destBundle, ".complete");
  const stagingSoffice = path.join(stagingDir, "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
  // 清单以来源包为准（复制后 staging 里也有同一份，等价）。
  const manifest = readManifest(bundledBundle);

  try {
    if (isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest })) {
      return { path: destSoffice, source: "cache" };
    }
    // 不可用的同名发布目录（半套缓存被完整性判定拒绝）：先清掉再重建。
    fs.rmSync(destBundle, { recursive: true, force: true });
    // staging 残留（上次复制中途断电/杀进程）：一并清掉。
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destBundle), { recursive: true });
    log(`Extracting LibreOffice engine to staging: ${stagingDir}`);
    fs.cpSync(bundledBundle, stagingDir, { recursive: true });

    if (!fs.existsSync(stagingSoffice)) {
      // 来源包本身残缺——旧实现在这里才检查，且检查的是最终目录。
      throw new Error("soffice.com missing after engine extraction");
    }
    const integrity = verifyIntegrity(stagingDir, manifest);
    if (!integrity.ok) {
      throw new Error(`引擎完整性校验失败: ${integrity.reason}`);
    }
    if (integrity.checked) log(`Engine integrity verified: ${integrity.checked} critical files`);

    const smoke = smokeTest(stagingSoffice, { tmpRoot });
    if (!smoke.ok) {
      throw new Error(`引擎冒烟测试失败: ${smoke.reason || "unknown"}`);
    }
    log("Engine smoke conversion passed");

    fs.writeFileSync(path.join(stagingDir, ".complete"), `${bundleName}\n`, "utf8");
    // rename 发布：staging→最终目录一次到位，中途不存在「入口在但内容不全」的窗口。
    fs.renameSync(stagingDir, destBundle);

    // 新缓存发布成功后才回收其余旧目录（含仍在用的历史版本；本次 bundle 除外）。
    try {
      for (const name of fs.readdirSync(enginesRoot)) {
        if (name !== bundleName && !name.endsWith(STAGING_SUFFIX) && /^libreoffice(-|$)/.test(name)) {
          fs.rmSync(path.join(enginesRoot, name), { recursive: true, force: true });
        }
      }
    } catch {
      // 旧缓存回收失败不影响本次启动（顶多占盘）。
    }
    return { path: destSoffice, source: "published" };
  } catch (error) {
    // staging 整段丢弃即可——最终目录从未被动过，其余版本缓存也未被动过。
    log("LibreOffice writable-engine preparation failed; using bundled path", error);
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // 清理失败只可能来自更底层的 IO 问题，日志已留。
    }
    return { path: bundledSofficePath, source: "bundled", reason: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  MANIFEST_FILE,
  SMOKE_TIMEOUT_MS,
  defaultSmokeTest,
  isPublishedBundleUsable,
  prepareWritableEngineBundle,
  readManifest,
  verifyIntegrity
};
