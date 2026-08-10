const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const { pathToFileURL } = require("url");
const { createPdfjsLoader, loadPdfjsModule } = require("../server");

const MODERN_PDFJS = "pdfjs-dist/legacy/build/pdf.mjs";
const LEGACY_PDFJS = "pdfjs-dist/legacy/build/pdf.js";

function pdfjsTestOptions(importer) {
  return {
    importer,
    modernSpecifier: MODERN_PDFJS,
    legacySpecifier: LEGACY_PDFJS
  };
}

function readRoot(fileName) {
  return fs.readFileSync(path.join(__dirname, "..", fileName), "utf8");
}

test("main process enforces Electron trust boundaries", () => {
  const source = readRoot("electron-main.js");
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /will-navigate/);
  assert.match(source, /isTrustedRendererUrl/);
  assert.match(source, /resolveTrustedDownloadUrl/);
  assert.match(source, /isAllowedExternalUrl/);
  assert.match(source, /event\.senderFrame/);
  assert.match(source, /if \(isAllowedExternalUrl\(url\)\)/);
});

test("local service sends a restrictive content security policy", () => {
  const source = readRoot("server.js");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'self'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /frame-ancestors 'none'/);
});

test("PDF.js loader supports modern and Win7 legacy layouts", () => {
  const source = readRoot("server.js");
  assert.match(source, /pdfjs-dist\/package\.json/);
  assert.match(source, /"pdf\.mjs"/);
  assert.match(source, /"pdf\.js"/);
  assert.match(source, /isMissingPdfjsEntry/);
  assert.match(source, /createPdfjsLoader/);
});

test("PDF extraction disables PDF.js eval support", () => {
  const source = readRoot("server.js");
  const functionStart = source.indexOf("async function extractPdfRowsByPage");
  const functionEnd = source.indexOf("\nasync function ", functionStart + 1);
  const extractSource = source.slice(functionStart, functionEnd);

  assert.notStrictEqual(functionStart, -1);
  assert.notStrictEqual(functionEnd, -1);
  assert.match(
    extractSource,
    /pdfjsLib\.getDocument\(\{\s*data,\s*disableFontFace:\s*true,\s*useSystemFonts:\s*true,\s*isEvalSupported:\s*false\s*\}\)/s
  );
});

test("PDF.js loader imports the modern layout when it resolves", async () => {
  const pdfjs = { getDocument() {} };
  const imports = [];
  const result = await loadPdfjsModule(pdfjsTestOptions(async (specifier) => {
    imports.push(specifier);
    return pdfjs;
  }));

  assert.strictEqual(result, pdfjs);
  assert.deepStrictEqual(imports, [MODERN_PDFJS]);
});

test("PDF.js loader falls back to the legacy layout only when the modern entry is missing", async () => {
  const pdfjs = { getDocument() {} };
  const packageRoot = "D:\\app\\node_modules\\pdfjs-dist";
  const modernEntry = path.join(packageRoot, "legacy", "build", "pdf.mjs");
  const legacyEntry = path.join(packageRoot, "legacy", "build", "pdf.js");
  const modernUrl = pathToFileURL(modernEntry).href;
  const legacyUrl = pathToFileURL(legacyEntry).href;
  const missing = Object.assign(
    new Error(`Cannot find module '${modernEntry}' imported from D:\\app\\server.js`),
    { code: "ERR_MODULE_NOT_FOUND", url: modernUrl }
  );
  const imports = [];
  const result = await loadPdfjsModule({
    appRoot: "D:\\APP",
    packageJsonResolver(specifier) {
      assert.strictEqual(specifier, "pdfjs-dist/package.json");
      return path.join(packageRoot, "package.json");
    },
    async importer(specifier) {
      imports.push(specifier);
      if (specifier === modernUrl) throw missing;
      return pdfjs;
    }
  });

  assert.strictEqual(result, pdfjs);
  assert.deepStrictEqual(imports, [modernUrl, legacyUrl]);
});

test("PDF.js loader rejects a package resolved outside the app root before importing", async () => {
  const imports = [];
  const promise = loadPdfjsModule({
    appRoot: "D:\\repo\\output\\win7-stage",
    packageJsonResolver: () => "D:\\repo\\node_modules\\pdfjs-dist\\package.json",
    async importer(specifier) {
      imports.push(specifier);
      return {};
    }
  });

  await assert.rejects(promise, /PDF\.js package must resolve inside the app root/);
  assert.deepStrictEqual(imports, []);
});

test("PDF.js loader unwraps a CommonJS default export", async () => {
  const pdfjs = { getDocument() {} };
  const result = await loadPdfjsModule(pdfjsTestOptions(async () => ({ default: pdfjs })));

  assert.strictEqual(result, pdfjs);
});

test("PDF.js loader preserves a modern module runtime error without trying the legacy entry", async () => {
  const runtimeError = new Error("modern PDF.js initialization failed");
  const imports = [];
  const promise = loadPdfjsModule(pdfjsTestOptions(async (specifier) => {
    imports.push(specifier);
    throw runtimeError;
  }));

  await assert.rejects(promise, (error) => error === runtimeError);
  assert.deepStrictEqual(imports, [MODERN_PDFJS]);
});

test("PDF.js loader does not fall back when a dependency of the modern entry is missing", async () => {
  const dependencyError = Object.assign(
    new Error("Cannot find package 'canvas' imported from D:\\app\\node_modules\\pdfjs-dist\\legacy\\build\\pdf.mjs"),
    {
      code: "ERR_MODULE_NOT_FOUND",
      url: "file:///D:/app/node_modules/canvas/index.js"
    }
  );
  const imports = [];
  const promise = loadPdfjsModule(pdfjsTestOptions(async (specifier) => {
    imports.push(specifier);
    throw dependencyError;
  }));

  await assert.rejects(promise, (error) => error === dependencyError);
  assert.deepStrictEqual(imports, [MODERN_PDFJS]);
});

test("PDF.js loader preserves a missing legacy entry error", async () => {
  const modernMissing = Object.assign(new Error(`Cannot find module '${MODERN_PDFJS}'`), { code: "MODULE_NOT_FOUND" });
  const legacyMissing = Object.assign(new Error("legacy entry missing"), { code: "MODULE_NOT_FOUND" });
  const promise = loadPdfjsModule(pdfjsTestOptions(async (specifier) => {
    if (specifier === MODERN_PDFJS) throw modernMissing;
    throw legacyMissing;
  }));

  await assert.rejects(promise, (error) => error === legacyMissing);
});

test("PDF.js loader preserves a legacy module runtime error", async () => {
  const modernMissing = Object.assign(new Error(`Cannot find module '${MODERN_PDFJS}'`), { code: "MODULE_NOT_FOUND" });
  const legacyError = new Error("legacy PDF.js initialization failed");
  const promise = loadPdfjsModule(pdfjsTestOptions(async (specifier) => {
    if (specifier === MODERN_PDFJS) throw modernMissing;
    throw legacyError;
  }));

  await assert.rejects(promise, (error) => error === legacyError);
});

test("PDF.js loader lazily caches one promise across concurrent and repeated calls", async () => {
  const pdfjs = { getDocument() {} };
  let imports = 0;
  const loadPdfjs = createPdfjsLoader(pdfjsTestOptions(async () => {
    imports += 1;
    return pdfjs;
  }));

  assert.strictEqual(imports, 0);
  const first = loadPdfjs();
  const concurrent = loadPdfjs();
  assert.strictEqual(first, concurrent);
  assert.strictEqual(await first, pdfjs);
  assert.strictEqual(loadPdfjs(), first);
  assert.strictEqual(imports, 1);
});

test("package pins the expected Electron version and includes the security module", () => {
  const packageJson = JSON.parse(readRoot("package.json"));

  if (packageJson.name === "flyingmouse-format") {
    assert.match(packageJson.devDependencies.electron, /^\^?43\./);
  } else if (packageJson.name === "flyingmouse-format-win7") {
    assert.strictEqual(packageJson.devDependencies.electron, "22.3.27");
  } else {
    assert.fail(`unexpected package name: ${packageJson.name}`);
  }

  assert.ok(packageJson.build.files.includes("electron-security.js"));
  assert.strictEqual(packageJson.build.win.signExecutable, false);
  assert.strictEqual(packageJson.build.win.signtoolOptions?.certificateSha1, undefined);
});

test("package bundles the AV3A helper and configures its runtime path", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  const main = readRoot("electron-main.js");
  const runtimePaths = readRoot("runtime-paths.js");
  const platformResources = packageJson.name === "flyingmouse-format"
    ? packageJson.build.win.extraResources
    : packageJson.build.extraResources;
  const avs3Resources = platformResources.filter((item) => item.to === "avs3");
  assert.strictEqual(avs3Resources.length, 1);
  if (packageJson.name === "flyingmouse-format") {
    assert.strictEqual(avs3Resources[0].from, "bin/avs3");
  } else if (packageJson.name === "flyingmouse-format-win7") {
    assert.ok(path.isAbsolute(avs3Resources[0].from));
    assert.strictEqual(path.basename(avs3Resources[0].from), "avs3");
    assert.strictEqual(path.basename(path.dirname(avs3Resources[0].from)), "bin");
  } else {
    assert.fail(`unexpected package name: ${packageJson.name}`);
  }
  assert.match(main, /FLYINGMOUSE_AVS3_DECODER_PATH/);
  assert.match(runtimePaths, /avs3RM0Decoder\.exe/);
  assert.match(runtimePaths, /avs3Decoder:\s*null/);
});

test("save dialogs restore and update the last successful directory", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  const main = readRoot("electron-main.js");
  assert.ok(packageJson.build.files.includes("settings-store.js"));
  assert.match(main, /readLastSaveDirectory/);
  assert.match(main, /writeLastSaveDirectory/);
  assert.match(main, /path\.join\(lastSaveDirectory, fileName\)/);
  assert.match(main, /defaultPath: lastSaveDirectory/);
  assert.match(main, /writeLastSaveDirectory\(settingsPath, path\.dirname\(result\.filePath\)\)/);
  assert.match(main, /writeLastSaveDirectory\(settingsPath, directory\)/);
});

test("trusted IPC owns durable renderer settings", () => {
  const main = readRoot("electron-main.js");
  const preload = readRoot("preload.js");
  for (const channel of ["get-settings", "update-settings", "migrate-legacy-settings"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(\\"${channel}\\"`));
  }
  assert.match(main, /assertTrustedIpc\(event\)/);
  assert.match(preload, /getSettings/);
  assert.match(preload, /updateSettings/);
  assert.match(preload, /migrateLegacySettings/);
});

test("trusted IPC exports a sanitized diagnostics report to the remembered directory", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  const main = readRoot("electron-main.js");
  const preload = readRoot("preload.js");
  assert.ok(packageJson.build.files.includes("diagnostics.js"));
  assert.match(main, /ipcMain\.handle\("export-diagnostics"/);
  assert.match(main, /buildDiagnosticsReport/);
  assert.match(main, /readLastSaveDirectory/);
  assert.match(main, /writeLastSaveDirectory/);
  assert.match(main, /fs\.promises\.writeFile/);
  assert.match(preload, /exportDiagnostics/);
  assert.match(preload, /ipcRenderer\.invoke\("export-diagnostics"/);
});

test("runtime diagnostics read Sharp's supported runtime version API", () => {
  const server = readRoot("server.js");
  assert.doesNotMatch(server, /require\(["']sharp\/package\.json["']\)/);
  assert.match(server, /sharp\.versions\.sharp/);
});
