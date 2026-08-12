const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { test } = require("node:test");

const { convertMflac, parseMflacFooter, loadQqMusicCredentials } = require("../mflac-format");

// 隔离真实桌面凭据：默认 cookie 路径指向不存在的文件，确保测试不读真实凭据、不发起网络请求。
const { before, after } = require("node:test");
const FAKE_COOKIE_ROOT = path.join(os.tmpdir(), `flyingmouse-mflac-cookie-${process.pid}`);
before(() => {
  process.env.FLYINGMOUSE_QQ_COOKIE = path.join(FAKE_COOKIE_ROOT, "QQ音乐_登录cookie.txt");
});
after(() => {
  delete process.env.FLYINGMOUSE_QQ_COOKIE;
});

function makeMusicexFile({ songId = 203452364, mediaMid = "001fTFGe0LqzdT", filename = "F0M00007VNd52q6aSX.mflac" } = {}) {
  const meta = Buffer.alloc(176);
  meta.writeUInt32LE(songId, 0x00);
  const midBuf = Buffer.from(`${mediaMid}\x00`, "utf16le");
  midBuf.copy(meta, 0x0c);
  const nameBuf = Buffer.from(`${filename}\x00`, "utf16le");
  nameBuf.copy(meta, 0x48);
  const footerSize = 16 + meta.length;
  const footer = Buffer.alloc(footerSize);
  meta.copy(footer, 0);
  footer.writeUInt32LE(footerSize, footer.length - 16);
  footer.writeUInt32LE(1, footer.length - 12); // version
  Buffer.from("musicex\x00", "latin1").copy(footer, footer.length - 8);
  return Buffer.concat([Buffer.alloc(1024, 0x11), footer]);
}

function makeV1File(key) {
  const audio = Buffer.alloc(1024, 0x22);
  const keyBuf = Buffer.from(key);
  const tail = Buffer.alloc(4 + keyBuf.length);
  keyBuf.copy(tail, 0);
  tail.writeUInt32LE(keyBuf.length, tail.length - 4);
  return Buffer.concat([audio, tail]);
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-test-"));
}

test("parseMflacFooter detects musicex footer and extracts song metadata", () => {
  const file = makeMusicexFile();
  const footer = parseMflacFooter(file);
  assert.equal(footer.type, "musicex");
  assert.equal(footer.songId, 203452364);
  assert.equal(footer.mediaMid, "001fTFGe0LqzdT");
  assert.equal(footer.filename, "F0M00007VNd52q6aSX.mflac");
});

test("parseMflacFooter detects QMC2 v1 footer (trailing keyLen + key)", () => {
  const file = makeV1File(Buffer.alloc(16, 0xab));
  const footer = parseMflacFooter(file);
  assert.equal(footer.type, "v1");
  assert.equal(footer.keySize, 16);
});

test("parseMflacFooter returns unknown for unrecognized trailing data", () => {
  const file = Buffer.alloc(1024, 0x33);
  assert.equal(parseMflacFooter(file).type, "unknown");
});

test("convertMflac rejects an unrecognized mflac with a stable error code", async () => {
  const dir = await tmpDir();
  try {
    const badPath = path.join(dir, "bad.mflac");
    await fsp.writeFile(badPath, Buffer.alloc(256, 0x00));
    await assert.rejects(
      () => convertMflac(badPath),
      (error) => error.code === "MFLAC_DECRYPT_FAILED"
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("convertMflac on musicex without credentials reports MFLAC_EKEY_REQUIRED", async () => {
  const dir = await tmpDir();
  try {
    const mflacPath = path.join(dir, "sample.mflac");
    await fsp.writeFile(mflacPath, makeMusicexFile());
    await assert.rejects(
      () => convertMflac(mflacPath, { cookiePath: path.join(dir, "no-such-cookie.txt") }),
      (error) => error.code === "MFLAC_EKEY_REQUIRED"
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadQqMusicCredentials parses uin and qm_keyst from a cookie file", async () => {
  const dir = await tmpDir();
  try {
    const cookiePath = path.join(dir, "cookie.txt");
    await fsp.writeFile(cookiePath, "uin=3461577342; qm_keyst=Q_H_L_TESTVALUE123; p_skey=IGNORED", "utf8");
    const creds = await loadQqMusicCredentials(cookiePath);
    assert.deepEqual(creds, { uin: "3461577342", authst: "Q_H_L_TESTVALUE123" });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadQqMusicCredentials returns null when no cookie file exists", async () => {
  const dir = await tmpDir();
  try {
    const creds = await loadQqMusicCredentials(path.join(dir, "missing.txt"));
    assert.equal(creds, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
