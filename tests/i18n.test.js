const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  readLanguage,
  saveLanguage,
  translate,
  createI18n
} = require("../public/i18n");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); }
  };
}

test("normalizes supported language families", () => {
  assert.equal(normalizeLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizeLanguage("zh-TW"), "zh-CN");
  assert.equal(normalizeLanguage("en-GB"), "en-US");
  assert.equal(normalizeLanguage("fr-FR"), "en-US");
});

test("saved language takes precedence over the system language", () => {
  const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: "en-US" });
  assert.equal(readLanguage(storage, "zh-CN"), "en-US");
  saveLanguage(storage, "zh-CN");
  assert.equal(storage.value(LANGUAGE_STORAGE_KEY), "zh-CN");
  assert.equal(readLanguage(storage, "en-US"), "zh-CN");
});

test("falls back safely when localStorage is blocked", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  assert.equal(readLanguage(blocked, "zh-CN"), "zh-CN");
  assert.doesNotThrow(() => saveLanguage(blocked, "en-US"));
});

test("translates placeholders and falls back to Chinese then the key", () => {
  const messages = {
    "zh-CN": { greeting: "你好，{name}", chineseOnly: "仅中文" },
    "en-US": { greeting: "Hello, {name}" }
  };
  assert.equal(translate(messages, "en-US", "greeting", { name: "Mouse" }), "Hello, Mouse");
  assert.equal(translate(messages, "en-US", "chineseOnly"), "仅中文");
  assert.equal(translate(messages, "en-US", "missing.key"), "missing.key");
});

test("creates a stateful translator without mutating storage during reads", () => {
  const storage = memoryStorage();
  const i18n = createI18n({
    storage,
    systemLanguage: "en-GB",
    messages: { "zh-CN": { action: "转换" }, "en-US": { action: "Convert" } }
  });
  assert.equal(i18n.language, "en-US");
  assert.equal(i18n.t("action"), "Convert");
  i18n.setLanguage("zh-CN");
  assert.equal(i18n.language, "zh-CN");
  assert.equal(i18n.t("action"), "转换");
  assert.equal(storage.value(LANGUAGE_STORAGE_KEY), "zh-CN");
});
