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
  if (["system", "light", "dark"].includes(stored.theme)) settings.theme = stored.theme;
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

function updateSettings(settingsPath, patch = {}) {
  return withSettingsLock(settingsPath, async () => {
    const current = await readSettings(settingsPath);
    const next = { ...current, schemaVersion: SCHEMA_VERSION };
    if (Object.prototype.hasOwnProperty.call(patch, "targetBySource")) {
      next.targetBySource = normalizeTargetMap(patch.targetBySource);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "language")) {
      if (patch.language === "zh-CN" || patch.language === "en-US") next.language = patch.language;
      else delete next.language;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "theme")) {
      next.theme = ["system", "light", "dark"].includes(patch.theme) ? patch.theme : "system";
    }
    if (Object.prototype.hasOwnProperty.call(patch, "lastSaveDirectory")) {
      if (!await isDirectory(patch.lastSaveDirectory)) {
        throw new Error("保存目录不存在或不是目录。");
      }
      next.lastSaveDirectory = patch.lastSaveDirectory;
    }
    await writeSettings(settingsPath, next);
    return next;
  });
}

// 语义比较（键序/格式无关）：merge 产物与磁盘现状等价时跳过写盘（S2 幂等迁移）。
// 0.6.4 商店版实证：迁移失败死循环期间每次启动都白写一次 + EXDEV 回退 copy，
// AppContainer 重定向盘上纯耗 IO；内容未变就不该有磁盘副作用。
function settingsContentEquals(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// S3：同一设置文件的「读→改→写」必须串行（2026-09-10 审计）。updateSettings 与
// mergeLegacySettings 都是 read-modify-write，IPC 并发（如同时改语言和默认格式）
// 会拿到同一旧快照、后写覆盖先写——单次 rename 原子性解决不了快照竞争。
// per-path promise 链把同路径变更排队执行；不同路径互不阻塞。
const mutationChains = new Map();

function withSettingsLock(settingsPath, task) {
  const key = path.resolve(settingsPath);
  const previous = mutationChains.get(key) || Promise.resolve();
  // 前序失败不阻断后续（链上挂 catch）。
  const current = previous.then(task, task);
  // 链尾无等待者时清掉 Map 条目防泄漏。P4（0.6.10 复核）：旧实现往 Map 存的是
  // `current.then(...)` 派生 Promise，清理却比较 `mutationChains.get(key) === current`
  // ——两个对象永不相等，清理条件从不成立，每个用过的设置路径永久留一项。
  // 现在把要清理的队尾 Promise 存进局部变量，存入与比较同一对象。
  const queued = current.then(
    () => { if (mutationChains.get(key) === queued) mutationChains.delete(key); },
    () => { if (mutationChains.get(key) === queued) mutationChains.delete(key); }
  );
  mutationChains.set(key, queued);
  return current;
}

function mergeLegacySettings(settingsPath, legacy = {}) {
  return withSettingsLock(settingsPath, async () => {
    const current = await readSettings(settingsPath);
    const legacyTargets = normalizeTargetMap(legacy.targetBySource);
    const next = {
      ...current,
      targetBySource: { ...legacyTargets, ...current.targetBySource }
    };
    if (!next.language && (legacy.language === "zh-CN" || legacy.language === "en-US")) {
      next.language = legacy.language;
    }
    // 没有旧设置（或旧值全被现有设置覆盖）时不产生任何写入；返回值照常，前端无感。
    if (settingsContentEquals(current, next)) return next;
    await writeSettings(settingsPath, next);
    return next;
  });
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
  writeLastSaveDirectory,
  // 测试/诊断专用：当前排队中的设置路径数（正常应为 0；P4 清理逻辑的回归探针）。
  _mutationChainsSize() {
    return mutationChains.size;
  }
};
