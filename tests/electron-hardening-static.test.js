const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const { createPdfjsLoader, loadPdfjsModule } = require("../server");

const MODERN_PDFJS = "pdfjs-dist/legacy/build/pdf.mjs";
const LEGACY_PDFJS = "pdfjs-dist/legacy/build/pdf.js";

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
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.js/);
  assert.match(source, /createPdfjsLoader/);
});

test("PDF.js loader imports the modern layout when it resolves", async () => {
  const pdfjs = { getDocument() {} };
  const imports = [];
  const result = await loadPdfjsModule({
    resolver(specifier) {
      assert.strictEqual(specifier, MODERN_PDFJS);
      return "resolved-modern-pdfjs";
    },
    async importer(specifier) {
      imports.push(specifier);
      return pdfjs;
    }
  });

  assert.strictEqual(result, pdfjs);
  assert.deepStrictEqual(imports, [MODERN_PDFJS]);
});

test("PDF.js loader falls back to the legacy layout only when the modern entry is missing", async () => {
  const pdfjs = { getDocument() {} };
  const missing = Object.assign(new Error("modern entry missing"), { code: "MODULE_NOT_FOUND" });
  const imports = [];
  const result = await loadPdfjsModule({
    resolver() {
      throw missing;
    },
    async importer(specifier) {
      imports.push(specifier);
      return pdfjs;
    }
  });

  assert.strictEqual(result, pdfjs);
  assert.deepStrictEqual(imports, [LEGACY_PDFJS]);
});

test("PDF.js loader unwraps a CommonJS default export", async () => {
  const pdfjs = { getDocument() {} };
  const result = await loadPdfjsModule({
    resolver: () => "resolved-modern-pdfjs",
    importer: async () => ({ default: pdfjs })
  });

  assert.strictEqual(result, pdfjs);
});

test("PDF.js loader preserves a modern module runtime error without trying the legacy entry", async () => {
  const runtimeError = new Error("modern PDF.js initialization failed");
  const imports = [];
  const promise = loadPdfjsModule({
    resolver: () => "resolved-modern-pdfjs",
    async importer(specifier) {
      imports.push(specifier);
      throw runtimeError;
    }
  });

  await assert.rejects(promise, (error) => error === runtimeError);
  assert.deepStrictEqual(imports, [MODERN_PDFJS]);
});

test("PDF.js loader preserves a non-missing resolver error without importing either entry", async () => {
  const resolverError = Object.assign(new Error("resolver denied access"), { code: "EACCES" });
  const imports = [];
  const promise = loadPdfjsModule({
    resolver() {
      throw resolverError;
    },
    async importer(specifier) {
      imports.push(specifier);
      return {};
    }
  });

  await assert.rejects(promise, (error) => error === resolverError);
  assert.deepStrictEqual(imports, []);
});

test("PDF.js loader preserves a missing legacy entry error", async () => {
  const modernMissing = Object.assign(new Error("modern entry missing"), { code: "MODULE_NOT_FOUND" });
  const legacyMissing = Object.assign(new Error("legacy entry missing"), { code: "MODULE_NOT_FOUND" });
  const promise = loadPdfjsModule({
    resolver() {
      throw modernMissing;
    },
    async importer(specifier) {
      assert.strictEqual(specifier, LEGACY_PDFJS);
      throw legacyMissing;
    }
  });

  await assert.rejects(promise, (error) => error === legacyMissing);
});

test("PDF.js loader preserves a legacy module runtime error", async () => {
  const modernMissing = Object.assign(new Error("modern entry missing"), { code: "MODULE_NOT_FOUND" });
  const legacyError = new Error("legacy PDF.js initialization failed");
  const promise = loadPdfjsModule({
    resolver() {
      throw modernMissing;
    },
    async importer() {
      throw legacyError;
    }
  });

  await assert.rejects(promise, (error) => error === legacyError);
});

test("PDF.js loader lazily caches one promise across concurrent and repeated calls", async () => {
  const pdfjs = { getDocument() {} };
  let imports = 0;
  const loadPdfjs = createPdfjsLoader({
    resolver: () => "resolved-modern-pdfjs",
    async importer() {
      imports += 1;
      return pdfjs;
    }
  });

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
});

test("package bundles the AV3A helper and configures its runtime path", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  const main = readRoot("electron-main.js");
  assert.ok(packageJson.build.extraResources.some((item) => item.from === "bin/avs3" && item.to === "avs3"));
  assert.match(main, /FLYINGMOUSE_AVS3_DECODER_PATH/);
  assert.match(main, /avs3RM0Decoder\.exe/);
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
