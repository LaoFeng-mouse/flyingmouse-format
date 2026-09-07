const childProcess = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const { RUNTIME_DIR, DOCSTRUCTURE_ENGINE_PATH, DOCSTRUCTURE_MODEL_DIR } = require("./config");
const { structureError, validateStructureManifest } = require("./pdf-structure-contract");
const logger = require("./logger");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const execFileAsync = promisify(childProcess.execFile);

const ERROR_MESSAGES = Object.freeze({
  PDF_STRUCTURE_ENGINE_MISSING: { zhCN: "PDF 结构化转换引擎不可用。", enUS: "The structured PDF conversion engine is unavailable." },
  PDF_STRUCTURE_MODEL_MISSING: { zhCN: "PDF 结构识别模型不可用。", enUS: "The PDF structure models are unavailable." },
  PDF_STRUCTURE_PARSE_FAILED: { zhCN: "PDF 结构识别失败。", enUS: "PDF structure recognition failed." },
  PDF_STRUCTURE_SCHEMA_INVALID: { zhCN: "PDF 结构识别结果无效。", enUS: "The PDF structure result is invalid." }
});

function stableError(code) {
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
    const real = await fileSystem.realpath(candidate);
    return comparablePath(real) === comparablePath(candidate);
  } catch {
    return false;
  }
}

function effectiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), DEFAULT_TIMEOUT_MS);
}

function createStructuredPdfBoundary(dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fsp;
  const defaultExecFile = dependencies.execFile || execFileAsync;
  const defaultEnginePath = dependencies.defaultEnginePath ?? DOCSTRUCTURE_ENGINE_PATH;
  const defaultModelDirectory = dependencies.defaultModelDirectory ?? DOCSTRUCTURE_MODEL_DIR;
  const defaultRuntimeDir = dependencies.defaultRuntimeDir ?? RUNTIME_DIR;

  async function runAndLoadManifest(inputPath, temporaryDirectory, options) {
    const runner = options.execFile || defaultExecFile;
    const args = ["parse", "--input", inputPath, "--output", temporaryDirectory,
      "--models", options.modelDirectory, "--language", "ch"];

    try {
      // Task 8's engine is contractually single-process and must not spawn descendants.
      // execFile owns and times out only this direct child; no shell or process-tree termination is used.
      await runner(options.enginePath, args, {
        shell: false,
        timeout: effectiveTimeout(options.timeoutMs),
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        windowsHide: true
      });
    } catch (cause) {
      // 引擎崩溃/超时以前被压成一句无信息量的失败文案（2026-09-07 实测 docstructure
      // 引擎对无文字层 PDF 偶发 segfault exit 139，重跑又能成功）。保留折叠语义
      // （不透传 stderr 给界面），但把退出码/信号写进 debug.log 供诊断，并按
      // 超时 vs 崩溃给出可区分的用户文案。超时=SIGTERM/SIGKILL 且 ETIMEDOUT；
      // 崩溃=SIGSEGV 等其他信号（killed 标志两种都可能为 true，不作判据）。
      const exitCode = cause?.code;
      const timedOut = cause?.code === "ETIMEDOUT"
        || (cause?.signal === "SIGTERM" || cause?.signal === "SIGKILL");
      logger.warn(`docstructure engine failed: exit=${String(exitCode)} signal=${String(cause?.signal)} input=${inputPath}`, cause);
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
      serialized = await fileSystem.readFile(path.join(temporaryDirectory, "manifest.json"), "utf8");
    } catch {
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    try {
      const manifest = JSON.parse(serialized);
      return (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
    } catch (error) {
      if (error?.code === "PDF_TABLE_OCR_LOW_QUALITY") throw error;
      throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
    }
  }

  return async function structuredPdfBoundary(inputPath, options = {}, consume) {
    if (typeof consume !== "function") throw new TypeError("consume must be a function");

    const enginePath = options.enginePath || defaultEnginePath;
    const modelDirectory = options.modelDirectory || defaultModelDirectory;
    const runtimeDir = options.runtimeDir || defaultRuntimeDir;
    if (!await isTrustedEntry(fileSystem, enginePath, "file")) throw stableError("PDF_STRUCTURE_ENGINE_MISSING");
    if (!await isTrustedEntry(fileSystem, modelDirectory, "directory")) throw stableError("PDF_STRUCTURE_MODEL_MISSING");

    let temporaryDirectory;
    try {
      await fileSystem.mkdir(runtimeDir, { recursive: true });
      temporaryDirectory = await fileSystem.mkdtemp(path.join(runtimeDir, "fm-pdf-structure-"));
    } catch {
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    let result;
    let operationError;
    try {
      const manifest = await runAndLoadManifest(inputPath, temporaryDirectory, { ...options, enginePath, modelDirectory });
      result = await consume(manifest, temporaryDirectory);
    } catch (error) {
      operationError = error;
    }

    let cleanupFailed = false;
    try {
      await fileSystem.rm(temporaryDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }

    if (operationError) throw operationError;
    if (cleanupFailed) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    return result;
  };
}

const withStructuredPdf = createStructuredPdfBoundary();

module.exports = { DEFAULT_MAX_BUFFER_BYTES, DEFAULT_TIMEOUT_MS, createStructuredPdfBoundary, withStructuredPdf };
