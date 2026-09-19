"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function findVcvars() {
  if (process.env.FLYINGMOUSE_VCVARS_PATH) return process.env.FLYINGMOUSE_VCVARS_PATH;
  if (process.env.VSINSTALLDIR) {
    const configured = path.join(process.env.VSINSTALLDIR, "VC/Auxiliary/Build/vcvars64.bat");
    if (fs.existsSync(configured)) return configured;
  }
  const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe");
  const result = spawnSync(vswhere, ["-latest", "-products", "*", "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
  { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Install MSVC x64 build tools and Windows SDK, or set FLYINGMOUSE_VCVARS_PATH.");
  }
  return path.join(result.stdout.trim(), "VC/Auxiliary/Build/vcvars64.bat");
}

// afterSign runs after Electron resources, ASAR integrity and fuses are finalized.
// Never attach in afterPack, and never pair a previous runtime with a new ASAR.
module.exports = async function attachWindowsLauncher(context) {
  if (context.electronPlatformName !== "win32") return;
  if (context.arch !== 1) throw new Error("The Windows compatibility launcher requires x64.");
  const root = context.packager.projectDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid launcher version.");
  if (context.packager.config.win?.signExecutable !== false) {
    throw new Error("The compatibility launcher currently requires an unsigned build (signExecutable:false).");
  }
  const entry = path.join(context.appOutDir, "FlyingMouse Format.exe");
  const runtime = path.join(context.appOutDir, "FlyingMouse Format Runtime.exe");
  if (!fs.existsSync(entry) || fs.existsSync(runtime)) throw new Error("Expected one fresh Electron executable.");
  const build = fs.mkdtempSync(path.join(path.dirname(context.appOutDir), "native-launcher-"));
  const local = context.packager.config.extraMetadata?.flyingMouseLocalAudio ?? manifest.flyingMouseLocalAudio ?? false;
  const resourceNames = ["icudtl.dat", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak", "v8_context_snapshot.bin",
    ...fs.readdirSync(path.join(context.appOutDir, "locales")).filter(name => name.endsWith(".pak")).sort().map(name => `locales/${name}`),
    ...fs.readdirSync(context.appOutDir).filter(name => name.endsWith(".dll")).sort()];
  const resourceEntries = resourceNames.map(name => {
    const file = path.join(context.appOutDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Invalid startup resource: ${name}`);
    return { path: name.replaceAll("/", "\\"), sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), executable: name.endsWith(".dll") };
  });
  fs.writeFileSync(path.join(build, "startup-build.h"), `#pragma once
#define FM_VERSION L"${manifest.version}"
#define FM_CHANNEL L"${local ? "local-music" : "public"}"
#define FM_LOG_FOLDER L"${local ? "FlyingMouse Format Local Music" : "FlyingMouseFormat"}"
#define FM_TITLE L"飞鼠格式${local ? "（本地音乐版）" : " / FlyingMouse Format"}"
static const std::vector<startup::Resource> FM_STARTUP_RESOURCES = {
${resourceEntries.map(item => `  { L${JSON.stringify(item.path)}, ${JSON.stringify(item.sha256)}, ${item.executable} },`).join("\n")}
};
`);
  fs.writeFileSync(path.join(build, "startup-resources.json"), JSON.stringify({ version: manifest.version, local, files: resourceEntries }, null, 2));
  const png = await require("sharp")(path.join(root, "build/icon.png")).resize(256, 256).png().toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(build, "launcher.ico"), Buffer.concat([header, png]));
  fs.writeFileSync(path.join(build, "launcher.rc"), `#include <windows.h>
1 ICON "launcher.ico"
1 VERSIONINFO
 FILEVERSION ${manifest.version.replace(/\./g, ",")},0
 PRODUCTVERSION ${manifest.version.replace(/\./g, ",")},0
 FILEOS VOS_NT_WINDOWS32
 FILETYPE VFT_APP
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "CompanyName", "LaoFeng (Non-Commercial)\\0"
   VALUE "FileDescription", "FlyingMouse Format\\0"
   VALUE "FileVersion", "${manifest.version}.0\\0"
   VALUE "InternalName", "FlyingMouse Format\\0"
   VALUE "OriginalFilename", "FlyingMouse Format.exe\\0"
   VALUE "ProductName", "FlyingMouse Format\\0"
   VALUE "ProductVersion", "${manifest.version}\\0"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
`);
  const vcvars = findVcvars();
  if (!fs.existsSync(vcvars)) throw new Error("MSVC environment script is missing.");
  const result = spawnSync(process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `""${path.join(root, "native/build.cmd")}""`], {
      cwd: root, windowsHide: true, windowsVerbatimArguments: true, stdio: "inherit",
      env: { ...process.env, FM_VCVARS: vcvars, FM_LAUNCHER_BUILD_DIR: build }
    });
  if (result.error || result.status !== 0) throw result.error || new Error("Native launcher build failed.");
  fs.renameSync(entry, runtime);
  try {
    fs.copyFileSync(path.join(build, "launcher.exe"), entry, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    fs.renameSync(runtime, entry);
    throw error;
  }
  console.log("Compatibility launcher attached; fresh Electron/ASAR pair preserved.");
};
