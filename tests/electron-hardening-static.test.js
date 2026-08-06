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

test("package uses Electron 43 and includes the security module", () => {
  const packageJson = JSON.parse(readRoot("package.json"));
  assert.match(packageJson.devDependencies.electron, /^\^?43\./);
  assert.ok(packageJson.build.files.includes("electron-security.js"));
  assert.strictEqual(packageJson.build.win.signAndEditExecutable, false);
});
