(function exposeConversionPreferences(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlyingMouseConversionPreferences = api;
}(typeof globalThis === "object" ? globalThis : this, function createConversionPreferences() {
  const STORAGE_KEY = "flyingmouse.conversionPreferences.v1";
  const aliases = new Map([
    ["jpeg", "jpg"],
    ["markdown", "md"],
    ["htm", "html"],
    ["tif", "tiff"]
  ]);

  function normalizeExtension(value) {
    const extension = String(value || "").trim().toLowerCase().replace(/^\./, "");
    return aliases.get(extension) || extension;
  }

  function readPreferences(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function rememberTarget(storage, extensions, target) {
    const normalizedTarget = String(target || "").trim().toLowerCase();
    const normalizedExtensions = [...new Set((extensions || []).map(normalizeExtension).filter(Boolean))];
    if (!normalizedTarget || normalizedExtensions.length === 0) return;
    try {
      const preferences = readPreferences(storage);
      for (const extension of normalizedExtensions) preferences[extension] = normalizedTarget;
      storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // A blocked/full localStorage must not prevent conversion.
    }
  }

  function preferredTarget(storage, extensions, availableTargets) {
    const normalizedExtensions = [...new Set((extensions || []).map(normalizeExtension).filter(Boolean))];
    if (normalizedExtensions.length === 0) return null;
    const preferences = readPreferences(storage);
    const remembered = normalizedExtensions.map((extension) => preferences[extension]);
    if (remembered.some((target) => !target) || !remembered.every((target) => target === remembered[0])) return null;
    const available = new Set((availableTargets || []).map((target) => String(target).toLowerCase()));
    return available.has(remembered[0]) ? remembered[0] : null;
  }

  return { STORAGE_KEY, normalizeExtension, rememberTarget, preferredTarget };
}));
