const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { test } = require("node:test");

const { convertKgma, kugoMd5, xorCollapseU32, VPR_HEADER } = require("../kgma-format");
const { extFromName } = require("../utils");

const KGM_V3_SLOT2_KEY = Buffer.from([0x6c, 0x2c, 0x2f, 0x27]);
const FILE_BOX_SUFFIX = 0x6b;

// 加密 = 解密的逆序逆运算（`b ^= b << 4` 不是对合，不能照抄解密顺序）
// 解密顺序: ^fileBox → shift → ^slotBox → ^xorCollapse
// 加密顺序: ^xorCollapse → ^slotBox → shift → ^fileBox
function encryptV3Audio(plain, cryptoKey) {
  const slotBox = kugoMd5(KGM_V3_SLOT2_KEY);
  const fileBox = Buffer.concat([kugoMd5(cryptoKey), Buffer.from([FILE_BOX_SUFFIX])]);
  const out = Buffer.from(plain);
  for (let i = 0; i < out.length; i++) {
    let b = out[i];
    b ^= xorCollapseU32(i);
    b ^= slotBox[i % 16];
    b ^= (b << 4) & 0xff;
    b ^= fileBox[i % 17];
    out[i] = b;
  }
  return out;
}

function buildVprSample(plain, cryptoKey, audioOffset = 0x400) {
  const header = Buffer.alloc(audioOffset, 0x00);
  VPR_HEADER.copy(header, 0);
  header.writeUInt32LE(audioOffset, 0x10);
  header.writeUInt32LE(3, 0x14); // crypto version
  header.writeUInt32LE(1, 0x18); // crypto slot
  cryptoKey.copy(header, 0x2c);
  const encrypted = encryptV3Audio(plain, cryptoKey);
  return Buffer.concat([header, encrypted]);
}

test("extFromName 识别 .vpr.flac 双后缀为 vpr", () => {
  assert.equal(extFromName("林俊杰 - 达尔文.vpr.flac"), "vpr");
  assert.equal(extFromName("song.vpr"), "vpr");
  assert.equal(extFromName("song.flac"), "flac");
  assert.equal(extFromName("song.mp3"), "mp3");
});

test("convertKgma 拒绝非 KGM/VPR 魔数", async () => {
  const bad = Buffer.alloc(0x3c + 16, 0x11);
  const tmp = path.join(os.tmpdir(), `vpr-bad-${process.pid}.vpr`);
  fs.writeFileSync(tmp, bad);
  try {
    await assert.rejects(() => convertKgma(tmp), /不是合法的 KGM\/KGMA\/VPR/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma 拒绝过短文件", async () => {
  const short = Buffer.alloc(16, 0x22);
  const tmp = path.join(os.tmpdir(), `vpr-short-${process.pid}.vpr`);
  fs.writeFileSync(tmp, short);
  try {
    await assert.rejects(() => convertKgma(tmp), /文件不完整/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("convertKgma 合成 vpr 样本往返解密（构造 VPR 再解回）", async () => {
  const cryptoKey = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00]);
  const plain = Buffer.concat([
    Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x02\x00\x44\xac\x00\x00\x88\x58\x01\x00\x04\x00\x10\x00data", "latin1"),
    Buffer.from("fake audio payload for vpr roundtrip test", "ascii")
  ]);
  const sample = buildVprSample(plain, cryptoKey);
  const tmp = path.join(os.tmpdir(), `vpr-roundtrip-${process.pid}.vpr`);
  fs.writeFileSync(tmp, sample);
  try {
    const result = await convertKgma(tmp);
    assert.equal(result.format, "wav");
    const decrypted = fs.readFileSync(result.nativePath);
    assert.deepEqual(decrypted, plain);
    fs.rmSync(result.tempDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// 真实样本：VIPER HiFi 会员下载的 .vpr.flac（283MB，scripts/.raw-samples/ 不入库）。
// 缺失自动 skip（同 sample.kwm 纪律）；存在则验证解密产物为 FLAC。
const REAL_VPR = path.join(__dirname, "..", "scripts", ".raw-samples", "林俊杰-达尔文.vpr.flac");

test(
  "convertKgma 真实 vpr.flac 样本解密（fixture 保护）",
  { skip: !fs.existsSync(REAL_VPR) && "真实 vpr 样本缺失（scripts/.raw-samples/ 不入库）" },
  async () => {
    const result = await convertKgma(REAL_VPR);
    try {
      // VIPER HiFi 会员下载的 vpr 解密后是无损 WAV（283MB 样本已验证）
      assert.equal(result.format, "wav");
      const decrypted = fs.readFileSync(result.nativePath);
      assert.ok(decrypted.subarray(0, 4).toString("latin1") === "RIFF", "解密产物应为 RIFF/WAVE");
      assert.ok(decrypted.subarray(8, 12).toString("latin1") === "WAVE", "解密产物应为 RIFF/WAVE");
      assert.ok(decrypted.length > 1024 * 1024, "解密产物应超过 1MB");
    } finally {
      fs.rmSync(result.tempDir, { recursive: true, force: true });
    }
  }
);
