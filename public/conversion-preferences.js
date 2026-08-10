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

  function rememberTarget(preferences, extensions, target) {
    const next = { ...(preferences || {}) };
    const normalizedTarget = normalizeExtension(target);
    const normalizedExtensions = [...new Set((extensions || []).map(normalizeExtension).filter(Boolean))];
    if (!normalizedTarget || normalizedExtensions.length === 0) return next;
    for (const extension of normalizedExtensions) next[extension] = normalizedTarget;
    return next;
  }

  function preferredTarget(preferences, extensions, availableTargets) {
    const values = preferences && typeof preferences === "object" ? preferences : {};
    const normalizedExtensions = [...new Set((extensions || []).map(normalizeExtension).filter(Boolean))];
    if (normalizedExtensions.length === 0) return null;
    const remembered = normalizedExtensions.map((extension) => values[extension]);
    if (remembered.some((target) => !target) || !remembered.every((target) => target === remembered[0])) return null;
    const available = new Set((availableTargets || []).map((target) => String(target).toLowerCase()));
    return available.has(remembered[0]) ? remembered[0] : null;
  }

  return { STORAGE_KEY, normalizeExtension, readPreferences, rememberTarget, preferredTarget };
}));
