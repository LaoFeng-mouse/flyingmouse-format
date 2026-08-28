const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_VERSION = 2;
const EXTENSION_ALIASES = new Map([
  ["jpeg", "jpg"],
  ["markdown", "md"],
  ["htm", "html"],
  ["tif", "tiff"]
]);

async function isDirectory(directory) {
  try {
    return (await fsp.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeExtension(value) {
  const extension = String(value || "").trim().toLowerCase().replace(/^\./, "");
  return EXTENSION_ALIASES.get(extension) || extension;
}

function normalizeTargetMap(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [source, target] of Object.entries(value)) {
    const normalizedSource = normalizeExtension(source);
    const normalizedTarget = normalizeExtension(target);
    if (/^[a-z0-9]+$/.test(normalizedSource) && /^[a-z0-9]+$/.test(normalizedTarget)) {
      result[normalizedSource] = normalizedTarget;
    }
  }
  return result;
}

async function readSettings(settingsPath) {
  let stored = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // Missing or damaged settings fall back without blocking the application.
  }

  const settings = {
    schemaVersion: SCHEMA_VERSION,
    targetBySource: normalizeTargetMap(stored.targetBySource)
  };
  if (typeof stored.lastSaveDirectory === "string" && await isDirectory(stored.lastSaveDirectory)) {
    settings.lastSaveDirectory = stored.lastSaveDirectory;
  }
  if (stored.language === "zh-CN" || stored.language === "en-US") {
    settings.language = stored.language;
  }
  return settings;
}

async function writeSettings(settingsPath, settings) {
  const parent = path.dirname(settingsPath);
  await fsp.mkdir(parent, { recursive: true });
  const temporaryPath = `${settingsPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(temporaryPath, settingsPath);
    } catch (err) {
      if (err && err.code === "EXDEV") {
        // Cross-device rename is not supported (Store AppContainer redirection / OneDrive KFM / junction).
        // Fall back to a copy so the settings write still succeeds; the outer finally removes the temp file.
        await fsp.copyFile(temporaryPath, settingsPath);
      } else {
        throw err;
      }
    }
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function updateSettings(settingsPath, patch = {}) {
  const current = await readSettings(settingsPath);
  const next = { ...current, schemaVersion: SCHEMA_VERSION };
  if (Object.prototype.hasOwnProperty.call(patch, "targetBySource")) {
    next.targetBySource = normalizeTargetMap(patch.targetBySource);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "language")) {
    if (patch.language === "zh-CN" || patch.language === "en-US") next.language = patch.language;
    else delete next.language;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastSaveDirectory")) {
    if (!await isDirectory(patch.lastSaveDirectory)) {
      throw new Error("保存目录不存在或不是目录。");
    }
    next.lastSaveDirectory = patch.lastSaveDirectory;
  }
  await writeSettings(settingsPath, next);
  return next;
}

async function mergeLegacySettings(settingsPath, legacy = {}) {
  const current = await readSettings(settingsPath);
  const legacyTargets = normalizeTargetMap(legacy.targetBySource);
  const next = {
    ...current,
    targetBySource: { ...legacyTargets, ...current.targetBySource }
  };
  if (!next.language && (legacy.language === "zh-CN" || legacy.language === "en-US")) {
    next.language = legacy.language;
  }
  await writeSettings(settingsPath, next);
  return next;
}

async function readLastSaveDirectory(settingsPath, fallbackDirectory) {
  const settings = await readSettings(settingsPath);
  return settings.lastSaveDirectory || fallbackDirectory;
}

async function writeLastSaveDirectory(settingsPath, directory) {
  return updateSettings(settingsPath, { lastSaveDirectory: directory });
}

module.exports = {
  SCHEMA_VERSION,
  mergeLegacySettings,
  normalizeExtension,
  normalizeTargetMap,
  readLastSaveDirectory,
  readSettings,
  updateSettings,
  writeLastSaveDirectory
};
