// pdfjs.js — Mahiro Format PDF.js 加载域：入口解析、打包/开发路径差异处理、模块加载器。
// 第三批抽取自 server.js（零逻辑改动，纯搬移）。

const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

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
  normalizePdfjsEntry,
  isMissingPdfjsEntry,
  resolvePdfjsEntrySpecifiers,
  loadPdfjsModule,
  createPdfjsLoader,
  loadPdfjs
};
