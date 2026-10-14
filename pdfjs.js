// pdfjs.js — 飞鼠格式 PDF.js 加载域：入口解析、打包/开发路径差异处理、模块加载器。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。

const path = require("path");
const fsp = require("fs/promises");
const { fileURLToPath, pathToFileURL } = require("url");

// PDF.js 6's Node factory treats a file URL string as a filesystem path, but
// the JS decoder fallback requires a file URL for dynamic import on Windows.
// Keep both paths local and use URL objects when reading decoder resources.
class LocalPdfjsBinaryDataFactory {
  constructor(options) {
    this.urls = options;
  }

  async fetch({ kind, filename }) {
    if (!["cMapUrl", "standardFontDataUrl", "wasmUrl"].includes(kind)
      || typeof filename !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(filename)
      || filename === "." || filename === "..") {
      throw new Error("Invalid PDF.js resource request");
    }
    const baseUrl = this.urls[kind];
    if (!baseUrl) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const resourceUrl = new URL(filename, baseUrl);
    if (resourceUrl.protocol !== "file:") throw new Error("PDF.js resources must be local files");
    return new Uint8Array(await fsp.readFile(resourceUrl));
  }
}

function getPdfjsDocumentOptions(options = {}) {
  return {
    ...options,
    wasmUrl: pathToFileURL(path.join(__dirname, "node_modules", "pdfjs-dist", "wasm") + path.sep).href,
    BinaryDataFactory: LocalPdfjsBinaryDataFactory,
    useWorkerFetch: false,
    isEvalSupported: false
  };
}

function normalizePdfjsEntry(value) {
  let normalized = String(value || "");
  if (normalized.startsWith("file:")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Fall through to text normalization for malformed file URLs.
    }
  }
  normalized = normalized.replaceAll("\\", "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original text when an error URL contains malformed escapes.
  }
  return normalized;
}

function isMissingPdfjsEntry(error, specifier) {
  if (!error || !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code)) {
    return false;
  }

  const expected = normalizePdfjsEntry(specifier);
  const matchesExpected = (value) => {
    const target = normalizePdfjsEntry(value);
    return target === expected || target.endsWith(`/${expected}`);
  };

  if (error.url && matchesExpected(error.url)) {
    return true;
  }

  const missingTarget = String(error.message || "").match(/Cannot find (?:module|package)\s+['"]([^'"]+)['"]/i);
  return Boolean(missingTarget && matchesExpected(missingTarget[1]));
}

function resolvePdfjsEntrySpecifiers(packageJsonResolver = require.resolve, appRoot = __dirname) {
  const packageJsonPath = path.resolve(packageJsonResolver("pdfjs-dist/package.json"));
  const expectedPackageJsonPath = path.resolve(appRoot, "node_modules", "pdfjs-dist", "package.json");
  const comparablePath = (filePath) => process.platform === "win32" ? filePath.toLowerCase() : filePath;
  if (comparablePath(packageJsonPath) !== comparablePath(expectedPackageJsonPath)) {
    throw new Error(
      `PDF.js package must resolve inside the app root at ${expectedPackageJsonPath}; got ${packageJsonPath}`
    );
  }

  const packageRoot = path.dirname(packageJsonPath);
  return {
    modernSpecifier: pathToFileURL(path.join(packageRoot, "legacy", "build", "pdf.mjs")).href,
    legacySpecifier: pathToFileURL(path.join(packageRoot, "legacy", "build", "pdf.js")).href
  };
}

async function loadPdfjsModule({
  appRoot = __dirname,
  importer = (specifier) => import(specifier),
  packageJsonResolver = require.resolve,
  modernSpecifier,
  legacySpecifier
} = {}) {
  if (!modernSpecifier || !legacySpecifier) {
    ({ modernSpecifier, legacySpecifier } = resolvePdfjsEntrySpecifiers(packageJsonResolver, appRoot));
  }
  let mod;
  try {
    mod = await importer(modernSpecifier);
  } catch (error) {
    if (!isMissingPdfjsEntry(error, modernSpecifier)) {
      throw error;
    }
    mod = await importer(legacySpecifier);
  }

  return mod.default || mod;
}

function createPdfjsLoader(options) {
  let cachedPdfjsPromise = null;
  return function loadPdfjs() {
    if (!cachedPdfjsPromise) {
      cachedPdfjsPromise = loadPdfjsModule(options);
    }
    return cachedPdfjsPromise;
  };
}

const loadPdfjs = createPdfjsLoader();

module.exports = {
  getPdfjsDocumentOptions,
  normalizePdfjsEntry,
  isMissingPdfjsEntry,
  resolvePdfjsEntrySpecifiers,
  loadPdfjsModule,
  createPdfjsLoader,
  loadPdfjs
};
