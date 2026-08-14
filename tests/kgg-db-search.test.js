const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { searchForKugouKeyDb } = require("../kgg-format");

function makeDb(root, subPath) {
  const dir = path.join(root, subPath);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "KGMusicV3.db");
  fs.writeFileSync(dbPath, "SQLite format 3\x00");
  return dbPath;
}

test("searchForKugouKeyDb finds KGMusicV3.db under a macOS-like nested path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-kggdb-"));

  // 模拟 Mac 沙盒容器路径：Containers/<bundle>/Data/Library/Application Support/<App>/KGMusicV3.db
  const deep = makeDb(root, "com.kugou.music/Data/Library/Application Support/KuGou");
  const found = searchForKugouKeyDb([root]);
  assert.equal(found, deep);
});

test("searchForKugouKeyDb prefers the most recently modified DB when several exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-kggdb2-"));

  const older = makeDb(root, "KuGou");
  const newer = makeDb(root, "other/kugou/nested");
  const past = new Date(Date.now() - 60000);
  const now = new Date();
  fs.utimesSync(older, past, past);
  fs.utimesSync(newer, now, now);

  const found = searchForKugouKeyDb([root]);
  assert.equal(found, newer);
});

test("searchForKugouKeyDb returns undefined when no DB exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-kggdb3-"));
  fs.mkdirSync(path.join(root, "unrelated", "dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "unrelated", "notes.txt"), "x");
  assert.equal(searchForKugouKeyDb([root]), undefined);
});
