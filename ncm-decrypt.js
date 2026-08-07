// NetEase Cloud Music (.ncm) decryption — standard official-client format.
// Algorithm is the well-documented public one (AES-128-ECB + RC4 with 1024-byte keystream drop).
// Reference implementations were DMCA-removed from GitHub; this is an independent implementation.
// Robustness: candidate core-key lengths are validated by checking the decrypted audio magic,
// which is the strongest possible validator (a wrong key produces garbage, not audio headers).
const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");

function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function rc4Decrypt(data, key, drop = 1024) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  let a = 0;
  let b = 0;
  const prga = (count) => {
    for (let n = 0; n < count; n += 1) {
      a = (a + 1) & 0xff;
      b = (b + s[a]) & 0xff;
      const tmp = s[a];
      s[a] = s[b];
      s[b] = tmp;
    }
  };
  prga(drop);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const tmp = s[a];
    s[a] = s[b];
    s[b] = tmp;
    out[i] = data[i] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function decodeMeta(buf) {
  try {
    const metaBuf = aesEcbDecrypt(buf, META_KEY);
    for (let i = 0; i < metaBuf.length; i += 1) metaBuf[i] ^= 0x63;
    return JSON.parse(Buffer.from(metaBuf.toString("latin1").trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function tryDecrypt(buf, keyStart) {
  if (buf.length < keyStart + 4) return null;
  const keyLen = buf.readUInt32LE(8);
  if (keyLen <= 0 || keyLen > 8192) return null;
  if (keyStart + keyLen + 4 > buf.length) return null;

  let keyBox;
  try {
    keyBox = aesEcbDecrypt(buf.subarray(keyStart, keyStart + keyLen), CORE_KEY);
  } catch {
    return null;
  }
  for (let i = 0; i < keyBox.length; i += 1) keyBox[i] ^= 0x64;

  const metaOff = keyStart + keyLen;
  const metaLen = buf.readUInt32LE(metaOff);
  if (metaLen <= 0 || metaLen > 1 << 20) return null;
  if (metaOff + 4 + metaLen > buf.length) return null;

  const meta = decodeMeta(buf.subarray(metaOff + 4, metaOff + 4 + metaLen));

  let audioOff = metaOff + 4 + metaLen;
  if (meta && meta.albumCover && audioOff + 4 <= buf.length) {
    const imageLen = buf.readUInt32LE(audioOff);
    audioOff += 4 + imageLen;
  }
  if (audioOff >= buf.length) return null;
  const audioPart = buf.subarray(audioOff);

  // Candidate core-key lengths: last byte (documented), byte 16, byte 0.
  // Validate each by checking the decrypted audio magic — a wrong key yields no audio header.
  const candidates = [...new Set([keyBox[keyBox.length - 1], keyBox[16], keyBox[0]])]
    .filter((n) => Number.isInteger(n) && n >= 4 && n <= 64);
  for (const coreLen of candidates) {
    const audioData = rc4Decrypt(audioPart, keyBox.subarray(0, coreLen));
    const format = detectAudioFormat(audioData);
    if (format !== "unknown") {
      return { audioData, format, meta };
    }
  }
  return null;
}

async function decryptNcm(inputPath) {
  const buf = await fsp.readFile(inputPath);
  if (buf.subarray(0, 8).toString("latin1") !== "CTENFDAM") {
    throw new Error("不是有效的网易云 NCM 文件（缺少 CTENFDAM 文件头）。");
  }
  const result = tryDecrypt(buf, 10) || tryDecrypt(buf, 12);
  if (!result) {
    throw new Error("NCM 解密失败：文件可能不是官方网易云客户端下载的标准 NCM。");
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ncm-"));
  const nativePath = path.join(tempDir, `native.${result.format}`);
  await fsp.writeFile(nativePath, result.audioData);
  return { nativePath, format: result.format, tempDir, meta: result.meta };
}

module.exports = { decryptNcm };
