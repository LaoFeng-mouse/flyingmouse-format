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

test("every IPC handler checks the renderer trust boundary", () => {
  const source = readRoot("electron-main.js");
  const handlers = [...source.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(handlers.length >= 8, `expected at least 8 IPC handlers, got ${handlers.length}`);
  for (const name of handlers) {
    const handlerStart = source.indexOf(`ipcMain.handle("${name}"`);
    const handlerEnd = source.indexOf("\nipcMain.handle(", handlerStart + 1);
    const handlerSource = source.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
    assert.match(
      handlerSource,
      /assertTrustedIpc\(event\)/,
      `ipcMain.handle("${name}") must validate the renderer trust boundary`
    );
  }
});

test("local service sends a restrictive content security policy", () => {
  const source = readRoot("server.js");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'self'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /frame-ancestors 'none'/);
});

test("PDF.js loader supports modern and Win7 legacy layouts", () => {
  const source = readRoot("pdfjs.js");
  assert.match(source, /pdfjs-dist\/package\.json/);
  assert.match(source, /"pdf\.mjs"/);
  assert.match(source, /"pdf\.js"/);
  assert.match(source, /isMissingPdfjsEntry/);
  assert.match(source, /createPdfjsLoader/);
});

test("PDF extraction disables PDF.js eval support", () => {
  const source = readRoot("pdf-table.js");
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
  const appRoot = path.resolve(path.sep, "app");
  const packageRoot = path.join(appRoot, "node_modules", "pdfjs-dist");
  const modernEntry = path.join(packageRoot, "legacy", "build", "pdf.mjs");
  const legacyEntry = path.join(packageRoot, "legacy", "build", "pdf.js");
  const modernUrl = pathToFileURL(modernEntry).href;
  const legacyUrl = pathToFileURL(legacyEntry).href;
  const missing = Object.assign(
    new Error(`Cannot find module '${modernEntry}' imported from ${path.join(appRoot, "server.js")}`),
    { code: "ERR_MODULE_NOT_FOUND", url: modernUrl }
  );
  const imports = [];
  const result = await loadPdfjsModule({
    appRoot,
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
  const repositoryRoot = path.resolve(path.sep, "repo");
  const promise = loadPdfjsModule({
    appRoot: path.join(repositoryRoot, "output", "win7-stage"),
    packageJsonResolver: () => path.join(repositoryRoot, "node_modules", "pdfjs-dist", "package.json"),
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
  const missingDependency = path.resolve(path.sep, "app", "node_modules", "canvas", "index.js");
  const dependencyError = Object.assign(
    new Error(`Cannot find package 'canvas' imported from ${path.resolve(path.sep, "app", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")}`),
    {
      code: "ERR_MODULE_NOT_FOUND",
      url: pathToFileURL(missingDependency).href
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

test("structured PDF engine is standard Windows-only and never claimed by Win7 or macOS", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  const windows = packageJson.build.win.extraResources;
  assert.deepStrictEqual(windows.filter((item) => item.to === "docstructure"), [
    { from: "bin/docstructure", to: "docstructure" }
  ]);
  assert.strictEqual(packageJson.build.mac.extraResources.some((item) => item.to === "docstructure"), false);

  const { createWin7Package } = require("../win7-build-profile");
  const profile = createWin7Package(packageJson, path.resolve(__dirname, ".."));
  assert.strictEqual(profile.build.extraResources.some((item) => item.to === "docstructure"), false);
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

test("LibreOffice conversions without an output file surface the stable OFFICE_CONVERSION_FAILED code", () => {
  const server = readRoot("office-convert.js");
  const branch = /if \(!convertedPath\) \{\s*\n\s*throw new OfficeEngineError\(\s*"OFFICE_CONVERSION_FAILED"/.exec(server);
  assert.ok(branch, "findConvertedFile empty branch must throw the stable code");
  assert.doesNotMatch(server, /throw new Error\(\s*"文档转换失败，可能是不支持这个源格式或文件已损坏。"/);
});

test("auto-updater only runs on the standard Windows build (not mac/win7/store)", () => {
  const main = readRoot("electron-main.js");
  assert.match(main, /process\.windowsStore\) return/);
  // mac 无 latest-mac.yml，禁用自动更新避免 404 报错
  assert.match(main, /process\.platform === "darwin"\) return/);
  // win7 Legacy（Electron 22）禁用，避免 latest.yml 指向标准版（Electron 43）坑掉 Win7 用户
  assert.match(main, /process\.versions\.electron\.split/);
  assert.match(main, /< 30\) return/);
});

test("store build hides encrypted-audio unlock entry and rejects decryption", () => {
  const config = readRoot("config.js");
  const server = readRoot("server.js");
  // config 单独列出加密解锁格式（DRM 规避，商店版隐藏）
  assert.match(config, /unlockAudioInputs/);
  assert.match(config, /"ncm", "kgg", "mflac", "mgg", "kgma", "mmp4"/);
  // capabilities 商店版过滤加密格式
  assert.match(server, /process\.windowsStore \|\| !unlockAudioInputs\.has/);
  // 解密分发商店版拒绝，稳定错误码
  assert.match(server, /AUDIO_UNLOCK_UNAVAILABLE_ON_STORE/);
});
