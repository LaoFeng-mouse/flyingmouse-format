const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { convertKgma, kugoMd5, xorCollapseU32, detectAudioFormat } = require("../kgma-format");

test("kugoMd5 是标准 MD5 的 16-bit 字节序反转", () => {
  const input = Buffer.from([0x6c, 0x2c, 0x2f, 0x27]);
  const digest = crypto.createHash("md5").update(input).digest();
  const expected = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 2) {
    expected[i] = digest[14 - i];
    expected[i + 1] = digest[15 - i];
  }
  assert.deepEqual(kugoMd5(input), expected);
});

test("xorCollapseU32 折叠 4 字节 XOR", () => {
  assert.equal(xorCollapseU32(0), 0);
  assert.equal(xorCollapseU32(0x01020304), 0x01 ^ 0x02 ^ 0x03 ^ 0x04);
  assert.equal(xorCollapseU32(0xffffffff), 0xff ^ 0xff ^ 0xff ^ 0xff);
});

test("detectAudioFormat 识别 flac/mp3/ogg", () => {
  assert.equal(detectAudioFormat(Buffer.from("fLaC\x00\x00\x00\x00")), "flac");
  assert.equal(detectAudioFormat(Buffer.from("ID3\x04\x00")), "mp3");
  assert.equal(detectAudioFormat(Buffer.from("OggS\x00\x02")), "ogg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90])), "mp3");
  assert.equal(detectAudioFormat(Buffer.from([0x00, 0x01, 0x02, 0x03])), "unknown");
});

test("convertKgma 拒绝非 KGM 魔数", async () => {
  const bad = Buffer.alloc(0x40, 0x11);
  const tmp = path.join(require("node:os").tmpdir(), `kgma-bad-${process.pid}.kgma`);
  fs.writeFileSync(tmp, bad);
  try {
    await assert.rejects(() => convertKgma(tmp), /不是合法的 KGM\/KGMA/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma 拒绝非 v3 版本（如 KGG v5）", async () => {
  const buf = Buffer.alloc(1024 + 16, 0x22);
  Buffer.from([
    0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
    0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14
  ]).copy(buf, 0);
  buf.writeUInt32LE(1024, 0x10);
  buf.writeUInt32LE(5, 0x14); // KGG v5，非 KGMA v3
  const tmp = path.join(require("node:os").tmpdir(), `kgma-v5-${process.pid}.kgma`);
  fs.writeFileSync(tmp, buf);
  try {
    await assert.rejects(() => convertKgma(tmp), /仅支持 KGMA\/VPR v3/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma 拒绝非 slot=1", async () => {
  const buf = Buffer.alloc(1024 + 16, 0x33);
  Buffer.from([
    0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
    0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14
  ]).copy(buf, 0);
  buf.writeUInt32LE(1024, 0x10);
  buf.writeUInt32LE(3, 0x14);
  buf.writeUInt32LE(9, 0x18); // 非 1
  const tmp = path.join(require("node:os").tmpdir(), `kgma-slot-${process.pid}.kgma`);
  fs.writeFileSync(tmp, buf);
  try {
    await assert.rejects(() => convertKgma(tmp), /仅支持 1/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma 真实样本解密（fixture 保护）", { skip: !fs.existsSync(path.join(__dirname, "fixtures", "sample.kgma")) }, async () => {
  const fixture = path.join(__dirname, "fixtures", "sample.kgma");
  const { nativePath, format } = await convertKgma(fixture);
  try {
    assert.ok(["flac", "mp3", "ogg"].includes(format), `unexpected format ${format}`);
    const head = fs.readFileSync(nativePath).subarray(0, 4);
    if (format === "flac") assert.equal(head.toString("latin1"), "fLaC");
    if (format === "ogg") assert.equal(head.toString("latin1"), "OggS");
  } finally {
    fs.rmSync(path.dirname(nativePath), { recursive: true, force: true });
  }
});
