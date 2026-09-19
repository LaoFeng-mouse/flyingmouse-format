const childProcess = require("node:child_process");
const ownedTasks = require("./owned-tasks");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { RUNTIME_DIR, DOCSTRUCTURE_ENGINE_PATH, DOCSTRUCTURE_MODEL_DIR } = require("./config");
const { structureError, validateStructureManifest } = require("./pdf-structure-contract");
const { loadPdfjs } = require("./pdfjs");
const { throwIfCanceled } = require("./conversion-cancellation");
const { STRUCTURE_LIMITS } = require("./resource-policy");
const logger = require("./logger");
const ENGINE_PROFILE = require("./package.json").engineProfile;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
// AbortSignal can invoke execFile's callback before the process closes. Wait
// for close before deleting its private output directory.
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    ownedTasks.assertAccepting();
    let failure, output;
    const child = childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      failure = error;
      output = { stdout, stderr };
    });
    ownedTasks.trackProcess(child, { directOnly: true });
    child.once("close", () => failure ? reject(failure) : resolve(output));
  });
}
// The native engine rasterizes at 144 DPI. Keep these limits aligned with
// tools/docstructure-engine/flyingmouse_docstructure/normalize.py.
const STRUCTURED_PDF_LIMITS = Object.freeze({
  maxPages: 500, maxPagePixels: 50000000, maxTotalPixels: 100000000,
  // Pixel limits protect raster memory; this smaller work bound keeps normal
  // multi-page OCR well away from the unchanged ten-minute process timeout.
  maxBatchPages: 8,
  maxDimension: 16384, maxOutputBytes: 512 * 1024 * 1024,
  maxManifestBytes: 512 * 1024 * 1024, renderScale: 2
});
const REQUIRED_MODELS = Object.freeze([
  "layout_detection", "doc_orientation_classification", "doc_unwarping",
  "text_detection", "text_recognition", "table_classification",
  "wired_table_structure", "wireless_table_structure", "wired_table_cells",
  "wireless_table_cells", "seal_text_detection"
]);

const ERROR_MESSAGES = Object.freeze({
  PDF_STRUCTURE_ENGINE_MISSING: { zhCN: "PDF 结构化转换引擎不可用。", enUS: "The structured PDF conversion engine is unavailable." },
  PDF_STRUCTURE_MODEL_MISSING: { zhCN: "PDF 结构识别模型缺失或不完整，请修复或重新安装软件。", enUS: "The PDF structure models are missing or incomplete. Repair or reinstall the app." },
  PDF_STRUCTURE_RESOURCE_LIMIT: { zhCN: "PDF 超出结构识别资源限制（最多 500 页、单页 5000 万像素，按 144 DPI 计算，整份识别产物最多 512 MiB，并受内容数量限制）。长文件会自动分批；请拆分文件或减小过大的页面后重试。", enUS: "The PDF exceeds a structure resource limit (500 pages, 50 megapixels per page at 144 DPI, 512 MiB of output, or content-count limits). Long files are batched automatically. Split the file or reduce oversized pages." },
  PDF_STRUCTURE_PARSE_FAILED: { zhCN: "PDF 结构识别失败。", enUS: "PDF structure recognition failed." },
  PDF_STRUCTURE_SCHEMA_INVALID: { zhCN: "PDF 结构识别结果无效。", enUS: "The PDF structure result is invalid." }
});

function stableError(code, engineProfile = ENGINE_PROFILE) {
  if (code === "PDF_STRUCTURE_ENGINE_MISSING" && engineProfile === "lite") {
    return structureError(code,
      "轻量版未包含高级扫描表格识别引擎。扫描表格转 Excel 或精细版式 Word 需要安装完整版；普通 OCR 文字转换仍可使用。",
      "The Lite edition does not include the advanced scanned-table engine. Install the Full edition for scanned tables to Excel or detailed Word layouts; basic OCR text conversion remains available.");
  }
  const messages = ERROR_MESSAGES[code];
  return structureError(code, messages.zhCN, messages.enUS);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function isTrustedEntry(fileSystem, candidate, expectedKind) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    const stats = await fileSystem.lstat(candidate);
    if (stats.isSymbolicLink()) return false;
    if (expectedKind === "file" ? !stats.isFile() : !stats.isDirectory()) return false;
    if (expectedKind === "file" && stats.size === 0) return false;
    const real = await fileSystem.realpath(candidate);
    // macOS 的 /var、/tmp 是 /private/* 系统符号链接（/var/folders → /private/var/folders），
    // realpath 后前缀会变——不能与 candidate 逐字符比较；改为校验 realpath 结果自洽
    // （二次 realpath 稳定），防止符号链接链重定向攻击。
    const stable = await fileSystem.realpath(real);
    return comparablePath(stable) === comparablePath(real);
  } catch {
    return false;
  }
}

function effectiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), DEFAULT_TIMEOUT_MS);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative);
}

async function validateModelFiles(fileSystem, modelDirectory) {
  if (!await isTrustedEntry(fileSystem, modelDirectory, "directory")) return false;
  try {
    const root = await fileSystem.realpath(modelDirectory);
    let mapping = {};
    const mapPath = path.join(modelDirectory, "model-map.json");
    try {
      const mapStats = await fileSystem.lstat(mapPath);
      if (mapStats.isSymbolicLink() || !mapStats.isFile() || mapStats.size > 65536) return false;
      mapping = JSON.parse(await fileSystem.readFile(mapPath, "utf8"));
      if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) return false;
    } catch (error) { if (error.code !== "ENOENT") return false; }
    for (const name of REQUIRED_MODELS) {
      const raw = Object.hasOwn(mapping, name) ? mapping[name] : name;
      if (typeof raw !== "string" || !raw || /[:\0]/u.test(raw)
        || path.isAbsolute(raw) || raw.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..")) return false;
      const directory = path.join(modelDirectory, ...raw.replaceAll("\\", "/").split("/"));
      if (!await isTrustedEntry(fileSystem, directory, "directory")
        || !contained(root, await fileSystem.realpath(directory))) return false;
      for (const alternatives of [["inference.json", "inference.pdmodel"], ["inference.pdiparams"], ["inference.yml"]]) {
        let found = false;
        for (const filename of alternatives) {
          const candidate = path.join(directory, filename);
          if (await isTrustedEntry(fileSystem, candidate, "file")
            && contained(root, await fileSystem.realpath(candidate))
            && (await fileSystem.stat(candidate)).size > 0) { found = true; break; }
        }
        if (!found) return false;
      }
    }
    return true;
  } catch { return false; }
}

async function getStructuredPdfAvailability(options = {}) {
  const fileSystem = options.fileSystem || fsp;
  const enginePath = options.enginePath ?? DOCSTRUCTURE_ENGINE_PATH;
  const modelDirectory = options.modelDirectory ?? DOCSTRUCTURE_MODEL_DIR;
  const engineProfile = options.engineProfile ?? ENGINE_PROFILE;
  let errorCode;
  if (!await isTrustedEntry(fileSystem, enginePath, "file")) errorCode = "PDF_STRUCTURE_ENGINE_MISSING";
  else if (!await validateModelFiles(fileSystem, modelDirectory)) errorCode = "PDF_STRUCTURE_MODEL_MISSING";
  return { enabled: !errorCode, ...(errorCode ? { errorCode } : {}),
    ...(engineProfile === "lite" ? { profile: "lite" } : {}),
    modelValidation: "required-files", limits: STRUCTURED_PDF_LIMITS };
}

async function preflightStructuredPdf(inputPath, options = {}) {
  const fileSystem = options.fileSystem || fsp;
  let loading;
  try {
    throwIfCanceled(options.signal);
    const pdfjs = await (options.loadPdfjs || loadPdfjs)();
    loading = pdfjs.getDocument({ data: new Uint8Array(await fileSystem.readFile(inputPath)),
      isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const document = await loading.promise;
    if (document.numPages < 1) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    if (document.numPages > STRUCTURED_PDF_LIMITS.maxPages) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
    let totalPixels = 0;
    const batches = [];
    // Internal callers may request smaller batches, never raise the native
    // limit or lower render resolution. A valid page always fits alone.
    const batchBudget = Number.isSafeInteger(options.maxBatchPixels) && options.maxBatchPixels > 0
      ? Math.min(options.maxBatchPixels, STRUCTURED_PDF_LIMITS.maxTotalPixels)
      : STRUCTURED_PDF_LIMITS.maxTotalPixels;
    for (let number = 1; number <= document.numPages; number += 1) {
      throwIfCanceled(options.signal);
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: STRUCTURED_PDF_LIMITS.renderScale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      page.cleanup();
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw stableError("PDF_STRUCTURE_PARSE_FAILED");
      }
      totalPixels += width * height;
      if (width > STRUCTURED_PDF_LIMITS.maxDimension || height > STRUCTURED_PDF_LIMITS.maxDimension
        || width * height > STRUCTURED_PDF_LIMITS.maxPagePixels) {
        throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
      }
      let batch = batches.at(-1);
      if (!batch || batch.totalPixels + width * height > batchBudget
        || number - batch.startPage >= STRUCTURED_PDF_LIMITS.maxBatchPages) {
        batch = { startPage: number, endPage: number, totalPixels: 0 };
        batches.push(batch);
      }
      batch.endPage = number;
      batch.totalPixels += width * height;
    }
    throwIfCanceled(options.signal);
    return { pageCount: document.numPages, totalPixels, batches };
  } catch (error) {
    if (["PDF_STRUCTURE_RESOURCE_LIMIT", "CONVERSION_CANCELED"].includes(error?.code)) throw error;
    throw stableError("PDF_STRUCTURE_PARSE_FAILED");
  } finally {
    if (loading) await loading.destroy();
  }
}

function addContentBudget(manifest, totals) {
  for (const page of manifest.pages || []) {
    totals.blocks += page.blocks?.length || 0;
    for (const collection of [page.tables, page.tableCandidates]) {
      totals.tables += collection?.length || 0;
      for (const table of collection || []) totals.cells += table.cells?.length || 0;
    }
  }
  if (totals.blocks > STRUCTURE_LIMITS.maxTotalBlocks || totals.tables > STRUCTURE_LIMITS.maxTotalTables
    || totals.cells > STRUCTURE_LIMITS.maxTotalCells) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
}

function assertPageSequence(manifest, batch) {
  if (manifest.pages.length !== batch.endPage - batch.startPage + 1
    || manifest.pages.some((page, index) => page.pageNumber !== index + 1)) {
    throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
  }
}

function mergeBatch(merged, manifest, batch, directoryName) {
  if (!merged) merged = { ...manifest, pages: [], warnings: [], elapsedMs: 0 };
  for (const page of manifest.pages) {
    // Table IDs are scoped to their page by both writers; leave IDs and their
    // block references together. Only filesystem paths need batch namespaces.
    merged.pages.push({ ...page, pageNumber: page.pageNumber + batch.startPage - 1,
      referenceImage: `${directoryName}/${page.referenceImage}`,
      blocks: page.blocks.map(block => block.asset === undefined ? block
        : { ...block, asset: `${directoryName}/${block.asset}` }) });
  }
  merged.warnings.push(...(manifest.warnings || []));
  merged.elapsedMs += manifest.elapsedMs || 0;
  return merged;
}

function createStructuredPdfBoundary(dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fsp;
  const defaultExecFile = dependencies.execFile || execFileAsync;
  const defaultEnginePath = dependencies.defaultEnginePath ?? DOCSTRUCTURE_ENGINE_PATH;
  const defaultModelDirectory = dependencies.defaultModelDirectory ?? DOCSTRUCTURE_MODEL_DIR;
  const defaultRuntimeDir = dependencies.defaultRuntimeDir ?? RUNTIME_DIR;

  async function outputBytes(directory, signal) {
    const root = await fileSystem.realpath(directory);
    let bytes = 0, entries = 0;
    async function visit(current, depth) {
      if (depth > STRUCTURE_LIMITS.maxNestingDepth) throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
      for (const name of await fileSystem.readdir(current)) {
        throwIfCanceled(signal);
        if (++entries > STRUCTURE_LIMITS.maxManifestNodes) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
        const candidate = path.join(current, name);
        const stats = await fileSystem.lstat(candidate);
        if (stats.isSymbolicLink() || !contained(root, await fileSystem.realpath(candidate))) {
          throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
        }
        if (stats.isDirectory()) await visit(candidate, depth + 1);
        else if (stats.isFile()) bytes += stats.size;
        else throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
        if (!Number.isSafeInteger(bytes) || bytes > STRUCTURED_PDF_LIMITS.maxOutputBytes) {
          throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
        }
      }
    }
    await visit(directory, 0);
    return bytes;
  }

  async function runAndLoadManifest(inputPath, temporaryDirectory, options, totals, batch) {
    const runner = options.execFile || defaultExecFile;
    const args = ["parse", "--input", inputPath, "--output", temporaryDirectory,
      "--models", options.modelDirectory, "--language", "ch"];

    try {
      throwIfCanceled(options.signal);
      // Task 8's engine is contractually single-process and must not spawn descendants.
      // execFile owns and times out only this direct child; no shell or process-tree termination is used.
      await runner(options.enginePath, args, {
        shell: false,
        timeout: effectiveTimeout(options.timeoutMs),
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        windowsHide: true,
        signal: options.signal,
        env: { ...process.env, TEMP: options.nativeTemporaryDirectory,
          TMP: options.nativeTemporaryDirectory, TMPDIR: options.nativeTemporaryDirectory }
      });
      throwIfCanceled(options.signal);
    } catch (cause) {
      throwIfCanceled(options.signal);
      if (cause?.code === "CONVERSION_CANCELED") throw cause;
      // 引擎崩溃/超时以前被压成一句无信息量的失败文案（2026-09-07 实测 docstructure
      // 引擎对无文字层 PDF 偶发 segfault exit 139，重跑又能成功）。保留折叠语义
      // （不透传 stderr 给界面），但把退出码/信号写进 debug.log 供诊断，并按
      // 超时 vs 崩溃给出可区分的用户文案。超时=SIGTERM/SIGKILL 且 ETIMEDOUT；
      // 崩溃=SIGSEGV 等其他信号（killed 标志两种都可能为 true，不作判据）。
      const exitCode = cause?.code;
      const timedOut = cause?.code === "ETIMEDOUT"
        || (cause?.signal === "SIGTERM" || cause?.signal === "SIGKILL");
      logger.warn(`docstructure engine failed: exit=${String(exitCode)} signal=${String(cause?.signal)}`);
      // Numeric exit codes are the private native CLI protocol. Never infer them
      // by searching stderr, which may contain source text or arbitrary messages.
      const nativeCode = { 20: "PDF_STRUCTURE_MODEL_MISSING", 22: "PDF_STRUCTURE_SCHEMA_INVALID",
        23: "PDF_STRUCTURE_RESOURCE_LIMIT" }[exitCode];
      if (!timedOut && Number.isInteger(exitCode) && nativeCode) throw stableError(nativeCode);
      if (cause?.code === "ENOENT" || cause?.code === "EACCES" || cause?.code === "ENOEXEC") {
        throw stableError("PDF_STRUCTURE_ENGINE_MISSING");
      }
      if (!timedOut && exitCode === 21) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
      throw structureError(
        "PDF_STRUCTURE_PARSE_FAILED",
        timedOut
          ? "PDF 结构识别超时，请重试或拆分成较小的文件。"
          : "PDF 结构识别引擎意外退出，请重试转换（再次失败请重新生成该 PDF 或改用「PDF 转文本/Word（OCR）」）。",
        timedOut
          ? "PDF structure recognition timed out. Retry or split the file."
          : "The PDF structure engine exited unexpectedly. Retry the conversion."
      );
    }

    let serialized;
    try {
      const manifestPath = path.join(temporaryDirectory, "manifest.json");
      const manifestStats = await fileSystem.lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
      totals.manifestBytes += manifestStats.size;
      if (totals.manifestBytes > STRUCTURED_PDF_LIMITS.maxManifestBytes) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
      totals.outputBytes += await outputBytes(temporaryDirectory, options.signal);
      if (totals.outputBytes > STRUCTURED_PDF_LIMITS.maxOutputBytes) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
      serialized = await fileSystem.readFile(manifestPath, "utf8");
    } catch (error) {
      if (["PDF_STRUCTURE_RESOURCE_LIMIT", "PDF_STRUCTURE_SCHEMA_INVALID", "CONVERSION_CANCELED"].includes(error?.code)) throw error;
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    try {
      const manifest = JSON.parse(serialized);
      const normalized = await (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
      assertPageSequence(normalized, batch);
      addContentBudget(manifest, totals);
      return normalized;
    } catch (error) {
      if (["PDF_TABLE_OCR_LOW_QUALITY", "PDF_STRUCTURE_RESOURCE_LIMIT", "CONVERSION_CANCELED"].includes(error?.code)) throw error;
      throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
    }
  }

  return async function structuredPdfBoundary(inputPath, options = {}, consume) {
    if (typeof consume !== "function") throw new TypeError("consume must be a function");

    throwIfCanceled(options.signal);
    const enginePath = options.enginePath || defaultEnginePath;
    const modelDirectory = options.modelDirectory || defaultModelDirectory;
    const runtimeDir = options.runtimeDir || defaultRuntimeDir;
    const availability = await getStructuredPdfAvailability({ fileSystem, enginePath, modelDirectory,
      engineProfile: options.engineProfile });
    if (!availability.enabled) throw stableError(availability.errorCode, options.engineProfile);
    const plan = await (dependencies.preflightPdf || preflightStructuredPdf)(inputPath,
      { fileSystem, signal: options.signal, maxBatchPixels: options.maxBatchPixels });

    let temporaryDirectory, nativeTemporaryDirectory;
    try {
      await fileSystem.mkdir(runtimeDir, { recursive: true });
      temporaryDirectory = await fileSystem.mkdtemp(path.join(runtimeDir, "fm-pdf-structure-"));
      nativeTemporaryDirectory = await fileSystem.mkdtemp(path.join(runtimeDir, "fm-pdf-native-"));
    } catch {
      if (temporaryDirectory) await fileSystem.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    let result;
    let operationError;
    try {
      const batches = plan.batches || [{ startPage: 1, endPage: plan.pageCount }];
      const totals = { manifestBytes: 0, outputBytes: 0, blocks: 0, tables: 0, cells: 0 };
      const runOptions = { ...options, enginePath, modelDirectory, nativeTemporaryDirectory };
      let manifest;
      if (batches.length === 1) {
        manifest = await runAndLoadManifest(inputPath, temporaryDirectory, runOptions, totals, batches[0]);
      } else {
        const { PDFDocument } = require("pdf-lib");
        throwIfCanceled(options.signal);
        const sourceBytes = await fileSystem.readFile(inputPath);
        const inputDirectory = path.join(temporaryDirectory, "inputs");
        await fileSystem.mkdir(inputDirectory);
        for (let index = 0; index < batches.length; index += 1) {
          throwIfCanceled(options.signal);
          const batch = batches[index];
          const directoryName = `batch-${String(index + 1).padStart(3, "0")}`;
          const batchInput = path.join(inputDirectory, `${directoryName}.pdf`);
          const batchOutput = path.join(temporaryDirectory, directoryName);
          try {
            // Keep the original catalog (including optional-content visibility
            // and form appearance settings). copyPages alone loses that state.
            // Unreferenced source objects can remain in this temporary PDF, so
            // its byte size may approach the original; keep only one at a time.
            const document = await PDFDocument.load(sourceBytes, { updateMetadata: false });
            for (let page = document.getPageCount() - 1; page >= 0; page -= 1) {
              if (page < batch.startPage - 1 || page >= batch.endPage) document.removePage(page);
            }
            if (document.getPageCount() !== batch.endPage - batch.startPage + 1) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
            throwIfCanceled(options.signal);
            await fileSystem.writeFile(batchInput, await document.save({ addDefaultPage: false, updateFieldAppearances: false }));
            await fileSystem.mkdir(batchOutput);
          } catch (error) {
            if (error?.code === "CONVERSION_CANCELED") throw error;
            throw stableError("PDF_STRUCTURE_PARSE_FAILED");
          }
          const current = await runAndLoadManifest(batchInput, batchOutput, runOptions, totals, batch);
          throwIfCanceled(options.signal);
          manifest = mergeBatch(manifest, current, batch, directoryName);
          // Revalidate the entire accumulated document after every batch. This
          // preserves aggregate node/depth limits as well as safe asset paths.
          if (Buffer.byteLength(JSON.stringify(manifest)) > STRUCTURED_PDF_LIMITS.maxManifestBytes) {
            throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
          }
          await (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
          await fileSystem.rm(batchInput, { force: true });
        }
        manifest = await (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
      }
      throwIfCanceled(options.signal);
      result = await consume(manifest, temporaryDirectory);
      throwIfCanceled(options.signal);
    } catch (error) {
      operationError = error;
    }

    let cleanupFailed = false;
    for (const directory of [temporaryDirectory, nativeTemporaryDirectory]) {
      try {
        await fileSystem.rm(directory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }

    if (operationError) throw operationError;
    if (cleanupFailed) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    return result;
  };
}

const withStructuredPdf = createStructuredPdfBoundary();

module.exports = { DEFAULT_MAX_BUFFER_BYTES, DEFAULT_TIMEOUT_MS, REQUIRED_MODELS,
  STRUCTURED_PDF_LIMITS, getStructuredPdfAvailability, preflightStructuredPdf,
  createStructuredPdfBoundary, withStructuredPdf };
