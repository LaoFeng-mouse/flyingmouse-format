const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

async function isDirectory(directory) {
  try {
    return (await fsp.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function readLastSaveDirectory(settingsPath, fallbackDirectory) {
  try {
    const settings = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
    if (typeof settings.lastSaveDirectory === "string" && await isDirectory(settings.lastSaveDirectory)) {
      return settings.lastSaveDirectory;
    }
  } catch {
    // Missing/damaged settings fall back without blocking a save operation.
  }
  return fallbackDirectory;
}

async function writeLastSaveDirectory(settingsPath, directory) {
  if (!await isDirectory(directory)) throw new Error("保存目录不存在或不是目录。");
  const parent = path.dirname(settingsPath);
  await fsp.mkdir(parent, { recursive: true });
  const temporaryPath = `${settingsPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify({ lastSaveDirectory: directory }, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, settingsPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

module.exports = { readLastSaveDirectory, writeLastSaveDirectory };
