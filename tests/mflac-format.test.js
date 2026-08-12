const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { test } = require("node:test");

const { QmcMask, qmcMaskGetDefault, qmcMaskDetectMflac, convertMflac } = require("../mflac-format");

// 构造最小有效 flac 头（解密后前 4 字节必须是 fLaC）
function minimalFlac() {
  const head = Buffer.from("fLaC\x00\x00\x00\x22\x04\x00\x00\x00\x00", "latin1");
  const body = Buffer.alloc(1000, 0xaa);
  return Buffer.concat([head, body]);
}

test("QmcMask 44->128 展开后 Decrypt 具有 XOR 对称性（加密=解密）", () => {
  const mask = qmcMaskGetDefault();
  assert.equal(mask.Matrix128.length, 128);
  const data = Buffer.from("The quick brown fox jumps over the lazy dog 0123456789".repeat(20));
  const encrypted = mask.decrypt(data);
  const decrypted = mask.decrypt(encrypted);
  assert.deepEqual(decrypted, data);
});

test("mflac 合成样本可被 convertMflac 解密还原（尾 key + 探测 mask）", async () => {
  const flac = minimalFlac();
  const mask = qmcMaskGetDefault();
  const encrypted = mask.decrypt(flac);
  const key = Buffer.from(mask.Matrix128);
  const mflacBuf = Buffer.concat([encrypted, key, Buffer.alloc(4)]);
  mflacBuf.writeUInt32LE(key.length, mflacBuf.length - 4);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-test-"));
  try {
    const mflacPath = path.join(tempDir, "sample.mflac");
    await fsp.writeFile(mflacPath, mflacBuf);
    const result = await convertMflac(mflacPath);
    assert.equal(result.format, "flac");
    const decrypted = await fsp.readFile(result.nativePath);
    assert.deepEqual(decrypted, flac);
    await fsp.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("QMCv1（无尾 key）mflac 用默认 mask 解密", async () => {
  const flac = minimalFlac();
  const mask = qmcMaskGetDefault();
  const encrypted = mask.decrypt(flac);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-test-"));
  try {
    const mflacPath = path.join(tempDir, "legacy.mflac");
    await fsp.writeFile(mflacPath, encrypted);
    const result = await convertMflac(mflacPath);
    assert.equal(result.format, "flac");
    const decrypted = await fsp.readFile(result.nativePath);
    assert.deepEqual(decrypted, flac);
    await fsp.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("无法解密的输入以稳定错误码 MFLAC_DECRYPT_FAILED 报错", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-test-"));
  try {
    const badPath = path.join(tempDir, "bad.mflac");
    await fsp.writeFile(badPath, Buffer.alloc(256, 0x00));
    await assert.rejects(
      () => convertMflac(badPath),
      (error) => error.code === "MFLAC_DECRYPT_FAILED"
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
