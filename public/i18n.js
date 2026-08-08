(function exposeI18n(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlyingMouseI18n = api;
}(typeof globalThis === "object" ? globalThis : this, function createI18nModule() {
  const LANGUAGE_STORAGE_KEY = "flyingmouse.language.v1";

  function normalizeLanguage(value) {
    return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }

  function readLanguage(storage, systemLanguage) {
    try {
      const saved = storage?.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === "zh-CN" || saved === "en-US") return saved;
    } catch {
      // A blocked localStorage must not prevent the application from loading.
    }
    return normalizeLanguage(systemLanguage);
  }

  function saveLanguage(storage, language) {
    try {
      storage?.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
    } catch {
      // Language persistence is optional.
    }
  }

  function interpolate(template, params) {
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params || {}, name) ? String(params[name]) : match
    ));
  }

  function translate(messages, language, key, params = {}) {
    const normalized = normalizeLanguage(language);
    const template = messages?.[normalized]?.[key] ?? messages?.["zh-CN"]?.[key] ?? key;
    return interpolate(template, params);
  }

  function createI18n({ storage, systemLanguage, messages }) {
    let language = readLanguage(storage, systemLanguage);
    return {
      get language() { return language; },
      t(key, params) { return translate(messages, language, key, params); },
      setLanguage(value) {
        language = normalizeLanguage(value);
        saveLanguage(storage, language);
        return language;
      }
    };
  }

  return {
    LANGUAGE_STORAGE_KEY,
    normalizeLanguage,
    readLanguage,
    saveLanguage,
    translate,
    createI18n
  };
}));
