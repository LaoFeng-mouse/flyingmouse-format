const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { test } = require("node:test");

const { convertMflac, parseMflacFooter, parseV1KeyRegion, deriveQmcKey, musicexFallbackFilenames, loadQqMusicCredentials, tryDecryptCandidates } = require("../mflac-format");
const { QMC2MAP, QMC2RC4, createQMC2 } = require("../kgg-format");

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

test("loadQqMusicCredentials accepts the newer psrf_qqmusic_key cookie name", async () => {
  const dir = await tmpDir();
  try {
    const cookiePath = path.join(dir, "cookie.txt");
    await fsp.writeFile(cookiePath, "uin=3461577342; psrf_qqmusic_key=PSRF_NEW_VALUE456; pgv_pvid=IGNORED", "utf8");
    const creds = await loadQqMusicCredentials(cookiePath);
    assert.deepEqual(creds, { uin: "3461577342", authst: "PSRF_NEW_VALUE456" });
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

// ---- EncV2（mgg 新版）回归：fixture 是真实 EncV2 mgg 的 v1 key 区域（仅密钥材料，不含音频内容）----
const ENCV2_KEY_FIXTURE = path.join(__dirname, "fixtures", "mgg-encv2-key.bin");
const fixtureExists = require("node:fs").existsSync(ENCV2_KEY_FIXTURE);

test("parseV1KeyRegion detects EncV2 key region from a real mgg key fixture", { skip: !fixtureExists }, () => {
  const keyRegion = require("node:fs").readFileSync(ENCV2_KEY_FIXTURE);
  const parsed = parseV1KeyRegion(keyRegion);
  assert.equal(parsed.type, "encv2");
  assert.ok(parsed.ekey.length > 0, "EncV2 应解出内层 ekey");
});

test("deriveQmcKey produces a 256-byte QMC2 key from the EncV2 fixture", { skip: !fixtureExists }, () => {
  const keyRegion = require("node:fs").readFileSync(ENCV2_KEY_FIXTURE);
  const parsed = parseV1KeyRegion(keyRegion);
  const finalKey = deriveQmcKey(parsed.ekey);
  assert.equal(finalKey.length, 256);
  assert.ok(finalKey.length < 300, "256 字节 key 应走 QMC2MAP 路径");
});

test("convertMflac decrypts an EncV2 mgg built from the fixture key (OggS output)", { skip: !fixtureExists }, async () => {
  const keyRegion = require("node:fs").readFileSync(ENCV2_KEY_FIXTURE);
  const parsed = parseV1KeyRegion(keyRegion);
  const finalKey = deriveQmcKey(parsed.ekey);
  const cipher = finalKey.length < 300 ? new QMC2MAP(finalKey) : new QMC2RC4(finalKey);

  // 合成 OggS 音频（测试自造，无版权内容），用真实 key 加密
  const ogg = Buffer.concat([
    Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.alloc(2048, 0x5a)
  ]);
  const encrypted = Buffer.from(ogg);
  cipher.decrypt(encrypted, 0); // QMC2 XOR 加密与解密同函数

  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(keyRegion.length, 0);
  const file = Buffer.concat([encrypted, keyRegion, tail]);

  const dir = await tmpDir();
  try {
    const mggPath = path.join(dir, "sample.mgg");
    await fsp.writeFile(mggPath, file);
    const result = await convertMflac(mggPath);
    assert.equal(result.format, "ogg");
    const out = await fsp.readFile(result.nativePath);
    assert.equal(out.subarray(0, 4).toString("latin1"), "OggS");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("static: config exposes mgg input and server dispatches mgg to convertMflac", () => {
  const fs = require("node:fs");
  const configSource = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.ok(configSource.includes('"mflac", "mgg"'), "audioInput 应包含 mgg");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(
    serverSource.includes("unlockAudioInputs.has(inputExt)"),
    "server.js 应把 mgg 分发给解密链路"
  );
  const mflacSource = fs.readFileSync(path.join(__dirname, "..", "mflac-format.js"), "utf8");
  assert.ok(mflacSource.includes("QQMusic EncV2,Key:"), "mflac-format.js 应实现 EncV2 前缀处理");
});

test("static: config exposes mmp4 (musicex) input and server dispatches it to convertMflac", () => {
  const fs = require("node:fs");
  const configSource = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.ok(configSource.includes('"kgma", "mmp4"'), "audioInput 应包含 mmp4");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(
    serverSource.includes("unlockAudioInputs.has(inputExt)"),
    "server.js 应把 mmp4 分发给解密链路（musicex）"
  );
});

test("musicexFallbackFilenames 按音质从高到低生成降档候选", () => {
  const list = musicexFallbackFilenames("00225ydR0y8KTj");
  assert.deepEqual(
    list.map((x) => x.filename),
    ["F0M00225ydR0y8KTj.mflac", "O4M00225ydR0y8KTj.mgg", "M50000225ydR0y8KTj.mp3"]
  );
  assert.ok(list[0].label.includes("FLAC"), "优先 FLAC 无损档");
});

test("static: musicex 原档无权限时自动降档下载（F0M/O4M/M500）", () => {
  const fs = require("node:fs");
  const mflacSource = fs.readFileSync(path.join(__dirname, "..", "mflac-format.js"), "utf8");
  assert.ok(mflacSource.includes("collectMusicexCandidates"), "应存在 musicex 候选收集函数");
  assert.ok(mflacSource.includes("tryDecryptCandidates"), "应存在逐候选解密函数");
  assert.ok(mflacSource.includes("downloadMusicexFile"), "应存在 CDN 下载函数");
  assert.ok(mflacSource.includes('`F0M${mediaMid}.mflac`'), "降档应包含 F0M 档");
  assert.ok(mflacSource.includes("所有音质档位"), "全无权限时应报明确错误");
});

test("tryDecryptCandidates 原档乱码时回退到正确候选", () => {
  // 构造一个有效测试 ekey（32 零字节 base64），createQMC2 能据此创建 QMC2 流密码
  const ekey = Buffer.alloc(32).toString("base64");
  const cipher = createQMC2(ekey);
  assert.ok(cipher, "测试 ekey 应能创建 QMC2 cipher");

  // 正确候选：用 cipher 加密一段 fLaC 音频（QMC2 XOR 加解密同函数）
  const flac = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(64, 0x01)]);
  const encryptedFlac = Buffer.from(flac);
  cipher.decrypt(encryptedFlac, 0);

  // 乱码候选：有效 ekey，但文件内容是明确非音频的文本（模拟原档 ekey 错误 → 解密后不是音频）
  const garbageCandidate = { ekey, fileBuf: Buffer.from("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "latin1"), audioEnd: 32 };
  const goodCandidate = { ekey, fileBuf: encryptedFlac, audioEnd: encryptedFlac.length };

  // 乱码在前、正确在后 → 应跳过乱码、回退到正确候选
  const result = tryDecryptCandidates([garbageCandidate, goodCandidate]);
  assert.ok(result, "应跳过乱码候选、回退到正确候选");
  assert.equal(result.format, "flac");
  assert.equal(result.audio.subarray(0, 4).toString("latin1"), "fLaC");

  // 全部乱码 → 返回 null（交给上层报「无权限/下架」而非「解密乱码」）
  assert.equal(tryDecryptCandidates([garbageCandidate]), null, "全部乱码应返回 null");
  assert.equal(tryDecryptCandidates([]), null, "空候选应返回 null");
});
