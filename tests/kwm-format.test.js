const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");

const { convertKwm, generateMask, padOrTruncate, detectAudioFormat, KWM_HEADER_SIZE } = require("../kwm-format");

test("padOrTruncate 短串循环补齐到 32", () => {
  const out = padOrTruncate(Buffer.from("557589985", "ascii"), 32);
  const expected = Buffer.from("55758998555758998555758998555758", "ascii");
  assert.deepEqual(out, expected);
});

test("padOrTruncate 长串截断", () => {
  const out = padOrTruncate(Buffer.from("1234567890123456789012345678901234567890", "ascii"), 32);
  assert.equal(out.length, 32);
  assert.equal(out.toString("ascii"), "12345678901234567890123456789012");
});

test("padOrTruncate 空串补零", () => {
  const out = padOrTruncate(Buffer.alloc(0), 32);
  assert.equal(out.length, 32);
  assert.ok(out.every((byte) => byte === 0));
});

test("generateMask 与已知 key 的 mask 一致", () => {
  // 真实样本：白兰的-得意的笑.kwm 的 key（e1 25 3c 21 00 00 00 00），
  // 对应十进制 557589985，mask 由预定义串 XOR 循环 key 串得到。
  const key8 = Buffer.from([0xe1, 0x25, 0x3c, 0x21, 0x00, 0x00, 0x00, 0x00]);
  const mask = generateMask(key8);
  assert.equal(mask.length, 32);
  // 与真实文件解密结果交叉验证：数据区第一字节异或 mask[0] 应为 0x49（'I'，ID3 头）
  // 此处直接断言 mask 首字节 = 'M'(0x4d) ^ '5'(0x35) = 0x78
  assert.equal(mask[0], 0x4d ^ 0x35);
});

test("detectAudioFormat 识别 mp3/flac/ogg", () => {
  assert.equal(detectAudioFormat(Buffer.from("ID3\x04\x00\x00\x00")), "mp3");
  assert.equal(detectAudioFormat(Buffer.from("fLaC\x00\x00\x00\x00")), "flac");
  assert.equal(detectAudioFormat(Buffer.from("OggS\x00\x02")), "ogg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90])), "mp3");
  assert.equal(detectAudioFormat(Buffer.from([0x00, 0x01, 0x02, 0x03])), "unknown");
});

test("convertKwm 拒绝非 KWM 魔数", async () => {
  const bad = Buffer.alloc(KWM_HEADER_SIZE + 16, 0x11);
  const tmp = path.join(require("node:os").tmpdir(), `kwm-bad-${process.pid}.kwm`);
  fs.writeFileSync(tmp, bad);
  try {
    await assert.rejects(() => convertKwm(tmp), /不是合法的 KWM/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKwm 拒绝过短文件", async () => {
  const short = Buffer.alloc(16, 0x22);
  const tmp = path.join(require("node:os").tmpdir(), `kwm-short-${process.pid}.kwm`);
  fs.writeFileSync(tmp, short);
  try {
    await assert.rejects(() => convertKwm(tmp), /KWM 文件不完整/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKwm 合成样本往返解密（构造 KWM 再解回）", async () => {
  // 构造：头部 + XOR mask 后的音频数据，验证解密还原
  const key8 = Buffer.from([0xe1, 0x25, 0x3c, 0x21, 0x00, 0x00, 0x00, 0x00]);
  const mask = generateMask(key8);
  const plain = Buffer.concat([
    Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.from("fake audio payload for kwm roundtrip test", "ascii")
  ]);
  const encrypted = Buffer.from(plain);
  for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= mask[i & 0x1f];

  const header = Buffer.alloc(KWM_HEADER_SIZE, 0x00);
  Buffer.from("yeelion-kuwo-tme", "latin1").copy(header, 0);
  key8.copy(header, 0x18);
  Buffer.from("320MP3", "latin1").copy(header, 0x30);

  const sample = Buffer.concat([header, encrypted]);
  const tmp = path.join(require("node:os").tmpdir(), `kwm-roundtrip-${process.pid}.kwm`);
  fs.writeFileSync(tmp, sample);
  try {
    const result = await convertKwm(tmp);
    assert.equal(result.format, "mp3");
    const decrypted = fs.readFileSync(result.nativePath);
    assert.deepEqual(decrypted, plain);
    fs.rmSync(result.tempDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKwm 真实样本解密（fixture 保护）", { skip: !fs.existsSync(path.join(__dirname, "fixtures", "sample.kwm")) }, async () => {
  const result = await convertKwm(path.join(__dirname, "fixtures", "sample.kwm"));
  try {
    assert.ok(["mp3", "flac"].includes(result.format));
    const decrypted = fs.readFileSync(result.nativePath);
    assert.ok(decrypted.length > 1000);
  } finally {
    fs.rmSync(result.tempDir, { recursive: true, force: true });
  }
});
