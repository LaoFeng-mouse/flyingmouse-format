const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  convertVpr,
  decryptVprBuffer,
  detectAudioFormat,
  transformNibble,
  VPR_HEADER,
  VPR_MASK_DIFF,
  MASK_V2_PREDEF
} = require("../kgm-vpr-format");

function encryptVprAudio(plain, key, maskV2) {
  const encrypted = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    const mask = transformNibble(MASK_V2_PREDEF[i % MASK_V2_PREDEF.length] ^ maskV2[i >> 4]);
    const transformed = transformNibble(plain[i] ^ VPR_MASK_DIFF[i % VPR_MASK_DIFF.length] ^ mask);
    encrypted[i] = key[i % 17] ^ transformed;
  }
  return encrypted;
}

function makeFixture(plain, maskV2) {
  const headerLength = 0x40;
  const key = Buffer.from("0123456789abcdef\0", "latin1");
  const header = Buffer.alloc(headerLength);
  VPR_HEADER.copy(header);
  header.writeUInt32LE(headerLength, 0x10);
  key.copy(header, 0x1c, 0, 16);
  return Buffer.concat([header, encryptVprAudio(plain, key, maskV2)]);
}

test("decrypts a synthetic VPR container back to its audio bytes", () => {
  const plain = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from(Array.from({ length: 509 }, (_, i) => i & 0xff))]);
  const maskV2 = Buffer.from(Array.from({ length: Math.ceil(plain.length / 16) }, (_, i) => (i * 37) & 0xff));
  const fixture = makeFixture(plain, maskV2);

  assert.deepEqual(decryptVprBuffer(fixture, maskV2), plain);
  assert.equal(detectAudioFormat(plain), "mp3");
});

test("convertVpr uses the bundled mask and writes a playable native file", async () => {
  const plain = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(1021, 0x5a)]);
  const maskV2 = await fsp.readFile(path.join(__dirname, "..", "public", "assets", "kgm.mask"));
  const inputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mahiro-vpr-test-"));
  let converted;
  try {
    const inputPath = path.join(inputDir, "sample.vpr");
    await fsp.writeFile(inputPath, makeFixture(plain, maskV2));
    converted = await convertVpr(inputPath);
    assert.equal(converted.format, "mp3");
    assert.deepEqual(await fsp.readFile(converted.nativePath), plain);
  } finally {
    await fsp.rm(inputDir, { recursive: true, force: true });
    if (converted?.tempDir) await fsp.rm(converted.tempDir, { recursive: true, force: true });
  }
});

test("rejects invalid VPR headers", () => {
  assert.throws(
    () => decryptVprBuffer(Buffer.alloc(0x40), Buffer.alloc(4)),
    (error) => error.code === "VPR_INVALID_FILE"
  );
});

test("rejects files larger than the available mask coverage", () => {
  const plain = Buffer.concat([Buffer.from("fLaC", "latin1"), Buffer.alloc(40)]);
  const fixture = makeFixture(plain, Buffer.alloc(3));
  assert.throws(
    () => decryptVprBuffer(fixture, Buffer.alloc(2)),
    (error) => error.code === "VPR_MASK_RANGE_EXCEEDED"
  );
});
