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
// 任何一步失败都不得发布半成品；清单缺失/损坏的旧包和已有缓存也必须通过
// 本次真实转换。清单条目通过不代表文字输出正确，缓存复用同样执行烟测。

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
    if (!isValidManifest(manifest)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function isValidManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || !manifest.files || Array.isArray(manifest.files)
    || typeof manifest.files !== "object" || !Object.keys(manifest.files).length) return false;
  return Object.entries(manifest.files).every(([rel, entry]) => {
    if (!rel || rel.includes("\\") || rel.includes(":") || path.posix.isAbsolute(rel)
      || rel.split("/").some((part) => !part || part === "." || part === "..")) return false;
    return entry && Number.isSafeInteger(entry.size) && entry.size >= 0
      && (!entry.sha256 || /^[a-f0-9]{64}$/i.test(entry.sha256));
  });
}

// 校验 manifest 收录的关键文件（相对 bundle 根）：必须存在、size 一致；
// 带 sha256 的（清单里均为几 MB 内的小文件）再比对哈希。大文件（mergedlo 等
// 147MB 级）只 stat 不读——全量哈希会在商店盘上拖垮首启，由冒烟转换兜底。
function verifyIntegrity(bundleDir, manifest) {
  if (!isValidManifest(manifest)) return { ok: false, checked: 0, reason: "清单缺失或无有效条目，必须执行实际转换验证" };
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

// 真实冒烟：最小 CSV → PDF，实际解析一页 PDF 并验证 flyingmouse 和 42 两个单元格。
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
    // Header checks accept truncated and blank PDFs. Parse the complete file and
    // verify the actual CSV cells in a separate bounded process (startup is sync).
    execFileSync(process.execPath, [path.join(__dirname, "engine-smoke-validator.js"), pdfPath], {
      timeout: Math.min(timeoutMs, 30000), windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `冒烟转换失败: ${error instanceof Error ? error.message : error}` };
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { /* A locked temporary profile must not override the validation result. */ }
    }
  }
}

// 已发布缓存的接受判定：入口 + .complete + （有清单时）关键文件完整性。
// 返回 false = 半套/损坏/过期，一律走重建。
function isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest, smokeTest = defaultSmokeTest, tmpRoot }) {
  if (!fs.existsSync(destSoffice) || !fs.existsSync(completeMarker)) return false;
  if (manifest && !verifyIntegrity(destBundle, manifest).ok) return false;
  // Legacy, corrupt and empty manifests have no integrity evidence. Even an
  // existing .complete marker cannot replace a real conversion on this launch.
  return smokeTest(destSoffice, { tmpRoot }).ok === true;
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
    if (isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest, smokeTest, tmpRoot })) {
      return { path: destSoffice, source: "cache" };
    }
    // Retain the previous directory until its replacement has passed validation.
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
    if (manifest && !integrity.ok) {
      throw new Error(`引擎完整性校验失败: ${integrity.reason}`);
    }
    if (integrity.checked) log(`Engine integrity verified: ${integrity.checked} critical files`);
    else log("Engine manifest unavailable; real conversion validation is required");

    const smoke = smokeTest(stagingSoffice, { tmpRoot });
    if (!smoke.ok) {
      throw new Error(`引擎冒烟测试失败: ${smoke.reason || "unknown"}`);
    }
    log("Engine smoke conversion passed");

    fs.writeFileSync(path.join(stagingDir, ".complete"), `${bundleName}\n`, "utf8");
    // rename 发布：staging→最终目录一次到位，中途不存在「入口在但内容不全」的窗口。
    fs.rmSync(destBundle, { recursive: true, force: true });
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
