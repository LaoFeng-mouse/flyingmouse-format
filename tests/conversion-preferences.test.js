const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORAGE_KEY,
  normalizeExtension,
  rememberTarget,
  preferredTarget
} = require("../public/conversion-preferences");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); }
  };
}

test("normalizes equivalent source extensions", () => {
  assert.equal(normalizeExtension(".JPEG"), "jpg");
  assert.equal(normalizeExtension("markdown"), "md");
  assert.equal(normalizeExtension("HTM"), "html");
  assert.equal(normalizeExtension("tif"), "tiff");
});

test("remembers and restores a target independently for each source extension", () => {
  const storage = memoryStorage();
  rememberTarget(storage, ["mp3"], "wav");
  rememberTarget(storage, ["ncm"], "mp3");

  assert.equal(preferredTarget(storage, ["mp3"], ["wav", "flac"]), "wav");
  assert.equal(preferredTarget(storage, ["ncm"], ["mp3", "wav"]), "mp3");
});

test("manual changes overwrite the previous default and ignore unavailable targets", () => {
  const storage = memoryStorage();
  rememberTarget(storage, ["mp3"], "wav");
  rememberTarget(storage, ["mp3"], "flac");

  assert.equal(preferredTarget(storage, ["mp3"], ["wav", "flac"]), "flac");
  assert.equal(preferredTarget(storage, ["mp3"], ["wav"]), null);
});

test("mixed uploads restore only a target shared by every source extension", () => {
  const storage = memoryStorage();
  rememberTarget(storage, ["jpg", "png"], "pdf");
  assert.equal(preferredTarget(storage, ["jpg", "png"], ["pdf", "zip"]), "pdf");

  rememberTarget(storage, ["png"], "zip");
  assert.equal(preferredTarget(storage, ["jpg", "png"], ["pdf", "zip"]), null);
});

test("damaged or unavailable localStorage silently falls back", () => {
  const corrupt = memoryStorage({ [STORAGE_KEY]: "not-json" });
  assert.equal(preferredTarget(corrupt, ["mp3"], ["wav"]), null);

  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  assert.doesNotThrow(() => rememberTarget(blocked, ["mp3"], "wav"));
  assert.equal(preferredTarget(blocked, ["mp3"], ["wav"]), null);
});
