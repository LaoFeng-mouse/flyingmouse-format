const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

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
  assert.match(
    source,
    /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)\s*\.catch\(\(\) => import\("pdfjs-dist\/legacy\/build\/pdf\.js"\)\)\s*\.then\(\(mod\) => mod\.default \|\| mod\)/
  );
});

test("package uses Electron 43 and includes the security module", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  assert.match(packageJson.devDependencies.electron, /^\^?43\./);
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
