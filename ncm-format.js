// NetEase Cloud Music .ncm format support (converts to a playable audio file).
// Layout (verified against a real official-client file, 2026-08):
//   magic "CTENFDAM"(8) + version(1) + keyLen(4) + key(keyLen) + metaLen(4) + meta(metaLen)
//   + crc(4) + unknown(5) + coverLen(4) + cover(coverLen) + audio
// Key: key data XOR 0x64 -> AES-128-ECB(CORE_KEY) -> keyBox;
//   rc4key = keyBox[17 .. keyBox.length - pkcs7PadLen]
// Audio: "RC4 变种" — one-shot 256-byte keystream (KSA once, keystream reused per 256-byte block).
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");
const NCM_MAGIC = "CTENFDAM";

function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// One-shot 256-byte keystream variant used by NCM (per unlock-music CLI ports).
function ncmKeyStream(rc4key) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + rc4key[i % rc4key.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const k = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    const a = (i + 1) & 255;
    const b = s[(a + s[a]) & 255];
    k[i] = s[(s[a] + b) & 255];
  }
  return k;
}

function ncmDecrypt(rc4key, data) {
  const k = ncmKeyStream(rc4key);
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 1) out[i] ^= k[i & 255];
  return out;
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 11 && buf.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function decodeMeta(metaData) {
  try {
    const xored = Buffer.from(metaData);
    for (let i = 0; i < xored.length; i += 1) xored[i] ^= 0x63;
    const b64 = xored.toString("utf8").replace(/^.{22}/s, "");
    const decrypted = aesEcbDecrypt(Buffer.from(b64, "base64"), META_KEY);
    // strip PKCS7 padding (last byte = pad length)
    const padLen = decrypted.length > 0 && decrypted[decrypted.length - 1] >= 1 && decrypted[decrypted.length - 1] <= 16
      ? decrypted[decrypted.length - 1]
      : 0;
    const payloadEnd = decrypted.length - padLen;
    const json = JSON.parse(decrypted.subarray(6, payloadEnd).toString("utf8"));
    return json;
  } catch {
    return null;
  }
}

function coverExtension(cover) {
  if (cover.length >= 3 && cover[0] === 0xff && cover[1] === 0xd8 && cover[2] === 0xff) return "jpg";
  if (cover.length >= 8 && cover.subarray(0, 8).equals(Buffer.from("89504E470D0A1A0A", "hex"))) return "png";
  return null;
}

// Try one header layout. Returns { audioData, format, meta } or null.
function tryDecrypt(buf, keyLenOff, keyStart) {
  const keyLen = buf.readUInt32LE(keyLenOff);
  if (keyLen <= 0 || keyLen > 8192) return null;
  if (keyStart + keyLen + 4 > buf.length) return null;

  let keyBox;
  try {
    const enc = Buffer.from(buf.subarray(keyStart, keyStart + keyLen));
    for (let i = 0; i < enc.length; i += 1) enc[i] ^= 0x64;
    keyBox = aesEcbDecrypt(enc, CORE_KEY);
  } catch {
    return null;
  }

  // RC4 key = keyBox[17 .. payload end] (payload excludes PKCS7 padding).
  const padLen = keyBox.length > 0 && keyBox[keyBox.length - 1] >= 1 && keyBox[keyBox.length - 1] <= 16
    ? keyBox[keyBox.length - 1]
    : 0;
  const payloadEnd = keyBox.length - padLen;
  const rc4key = keyBox.subarray(17, payloadEnd);
  if (rc4key.length < 4) return null;

  const metaOff = keyStart + keyLen;
  const metaLen = buf.readUInt32LE(metaOff);
  if (metaLen <= 0 || metaLen > 1 << 20) return null;
  if (metaOff + 4 + metaLen + 13 > buf.length) return null;

  const meta = decodeMeta(buf.subarray(metaOff + 4, metaOff + 4 + metaLen));

  // Skip crc(4) + unknown(5) + coverLen(4) + cover(coverLen).
  let audioOff = metaOff + 4 + metaLen + 4 + 5;
  let cover = null;
  if (audioOff + 4 <= buf.length) {
    const coverLen = buf.readUInt32LE(audioOff);
    audioOff += 4;
    if (coverLen > buf.length - audioOff) return null;
    if (coverLen > 0) {
      cover = Buffer.from(buf.subarray(audioOff, audioOff + coverLen));
      audioOff += coverLen;
    }
  }
  if (audioOff >= buf.length) return null;

  const audioData = ncmDecrypt(rc4key, buf.subarray(audioOff));
  const format = detectAudioFormat(audioData);
  if (format === "unknown") return null;
  return { audioData, format, meta, cover };
}

async function convertNcm(inputPath) {
  const buf = await fsp.readFile(inputPath);
  if (buf.subarray(0, 8).toString("latin1") !== NCM_MAGIC) {
    throw new Error("不是有效的网易云 NCM 文件（缺少 CTENFDAM 文件头）。");
  }
  // Candidate header layouts (key-length offset x key-data offset); audio magic validates.
  const layouts = [
    [10, 14],
    [9, 13],
    [8, 12],
    [8, 10],
    [10, 12],
    [12, 14],
    [12, 16]
  ];
  for (const [keyLenOff, keyStart] of layouts) {
    const result = tryDecrypt(buf, keyLenOff, keyStart);
    if (result) {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-ncm-"));
      const nativePath = path.join(tempDir, `native.${result.format}`);
      await fsp.writeFile(nativePath, result.audioData);
      let coverPath = null;
      if (result.cover && result.cover.length) {
        const ext = coverExtension(result.cover);
        if (ext) {
          coverPath = path.join(tempDir, `cover.${ext}`);
          await fsp.writeFile(coverPath, result.cover);
        }
      }
      return { nativePath, format: result.format, tempDir, meta: result.meta, coverPath };
    }
  }
  throw new Error("NCM 解密失败：文件可能不是官方网易云客户端下载的标准 NCM。");
}

module.exports = { convertNcm, detectAudioFormat };
