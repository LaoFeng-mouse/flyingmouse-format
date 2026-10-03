"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyInstalled } = require("./restore-pandoc");

module.exports = async function beforePack(context) {
  const root = context.packager.projectDir;
  const platform = context.electronPlatformName;
  // electron-builder's Arch enum: x64=1, arm64=3. Avoid the host architecture
  // when validating a requested cross-architecture package.
  const arch = context.arch === 3 ? "arm64" : context.arch === 1 ? "x64" : "unsupported";
  const resources = context.packager.config?.win?.extraResources || [];
  const resourcePath = (name) => {
    const configured = platform === "win32" && resources.find(item => typeof item === "object" && item.to === name)?.from;
    return configured ? path.resolve(root, configured) : path.join(root, "bin", name);
  };
  verifyInstalled(resourcePath("pandoc"), platform, arch);
  if (platform !== "win32") return;
  require("./restore-libraw").verifyInstalled(resourcePath("libraw"));
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-engine-manifest.js"), resourcePath("libreoffice")], {
    cwd: root, stdio: "inherit", windowsHide: true, timeout: 120000
  });
  if (result.error || result.status !== 0) throw result.error || new Error("LibreOffice package integrity manifest generation failed");
};
