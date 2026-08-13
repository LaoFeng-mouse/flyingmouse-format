const childProcess = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const {
  RUNTIME_DIR,
  DOCSTRUCTURE_ENGINE_PATH,
  DOCSTRUCTURE_MODEL_DIR
} = require("./config");
const { structureError, validateStructureManifest } = require("./pdf-structure-contract");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const execFileAsync = promisify(childProcess.execFile);

const ERROR_MESSAGES = Object.freeze({
  PDF_STRUCTURE_ENGINE_MISSING: {
    zhCN: "PDF 结构识别引擎不可用。",
    enUS: "The PDF structure engine is unavailable."
  },
  PDF_STRUCTURE_MODEL_MISSING: {
    zhCN: "PDF 结构识别模型不可用。",
    enUS: "The PDF structure models are unavailable."
  },
  PDF_STRUCTURE_PARSE_FAILED: {
    zhCN: "PDF 结构识别失败。",
    enUS: "PDF structure recognition failed."
  },
  PDF_STRUCTURE_SCHEMA_INVALID: {
    zhCN: "PDF 结构识别结果无效。",
    enUS: "The PDF structure result is invalid."
  }
});

function stableError(code) {
  const messages = ERROR_MESSAGES[code];
  return structureError(code, messages.zhCN, messages.enUS);
}

async function isRegularFile(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directoryPath) {
  try {
    return (await fsp.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function runAndLoadManifest(inputPath, temporaryDirectory, options) {
  const runner = options.execFile || execFileAsync;
  const args = [
    "parse",
    "--input", inputPath,
    "--output", temporaryDirectory,
    "--models", options.modelDirectory,
    "--language", "ch"
  ];

  try {
    await runner(options.enginePath, args, {
      shell: false,
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true
    });
  } catch {
    throw stableError("PDF_STRUCTURE_PARSE_FAILED");
  }

  let serialized;
  try {
    serialized = await fsp.readFile(path.join(temporaryDirectory, "manifest.json"), "utf8");
  } catch {
    throw stableError("PDF_STRUCTURE_PARSE_FAILED");
  }

  let manifest;
  try {
    manifest = JSON.parse(serialized);
    return (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
  } catch {
    throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
  }
}

async function withStructuredPdf(inputPath, options = {}, consume) {
  if (typeof consume !== "function") throw new TypeError("consume must be a function");

  const enginePath = options.enginePath || DOCSTRUCTURE_ENGINE_PATH;
  const modelDirectory = options.modelDirectory || DOCSTRUCTURE_MODEL_DIR;
  const runtimeDir = options.runtimeDir || RUNTIME_DIR;
  if (!await isRegularFile(enginePath)) throw stableError("PDF_STRUCTURE_ENGINE_MISSING");
  if (!await isDirectory(modelDirectory)) throw stableError("PDF_STRUCTURE_MODEL_MISSING");

  await fsp.mkdir(runtimeDir, { recursive: true });
  const temporaryDirectory = await fsp.mkdtemp(path.join(runtimeDir, "fm-pdf-structure-"));
  try {
    const manifest = await runAndLoadManifest(inputPath, temporaryDirectory, {
      ...options,
      enginePath,
      modelDirectory
    });
    return await consume(manifest, temporaryDirectory);
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, withStructuredPdf };
