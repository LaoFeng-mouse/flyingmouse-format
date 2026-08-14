// kwm-format.js — 酷我音乐加密音频 .kwm 离线解密。
//
// KWM 是酷我音乐（现腾讯音乐 TME）的加密格式，magic 为 "yeelion-kuwo-tme"
// （或 "yeelion-kuwo\0\0\0\0"），头部固定 0x400 字节：
//   - 0x00-0x0F: magic
//   - 0x18-0x1F: 8 字节小端 key（uint64）
//   - 0x30-0x37: 码率+扩展名，如 "320MP3" / "320FLAC"
//   - 0x400 起: XOR 加密的音频数据
// 密钥 mask 生成：key 转十进制字符串，循环补齐/截断到 32 字节，
// 与预定义串 "MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk" 逐字节 XOR；
// 数据区逐字节 XOR mask[i & 0x1F]。
//
// 算法移植自 unlock-music 系实现（arcana6264/unlock_music 的
// decoder/src/algo/kwm/kwm.rs + kwm_cipher.rs）。
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const KWM_HEADER_SIZE = 0x400;
const KWM_MAGIC_1 = "yeelion-kuwo-tme";
const KWM_MAGIC_2 = "yeelion-kuwo\x00\x00\x00\x00";
const KWM_PREDEFINED_KEY = "MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk"; // 32 字节

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

// 把原始字节循环补齐或截断到指定长度（与 unlock-music pad_or_truncate 一致）。
function padOrTruncate(raw, length) {
  if (raw.length === 0) return Buffer.alloc(length);
  const out = Buffer.alloc(length);
  if (raw.length >= length) {
    raw.copy(out, 0, 0, length);
  } else {
    for (let i = 0; i < length; i++) out[i] = raw[i % raw.length];
  }
  return out;
}

// 由 8 字节 key 生成 32 字节 XOR mask。
function generateMask(key8) {
  const keyInt = key8.readBigUInt64LE();
  const keyStr = keyInt.toString(10);
  const keyBytes = padOrTruncate(Buffer.from(keyStr, "ascii"), 32);
  const mask = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    mask[i] = KWM_PREDEFINED_KEY.charCodeAt(i) ^ keyBytes[i];
  }
  return mask;
}

async function convertKwm(inputPath) {
  const buf = await fsp.readFile(inputPath);
  if (buf.length < KWM_HEADER_SIZE) {
    throw new Error("KWM 文件不完整。");
  }
  const magic = buf.subarray(0, 0x10).toString("latin1");
  if (magic !== KWM_MAGIC_1 && magic !== KWM_MAGIC_2) {
    throw new Error("不是合法的 KWM 加密音频文件。");
  }
  const key8 = Buffer.from(buf.subarray(0x18, 0x20));
  const mask = generateMask(key8);

  const audio = Buffer.from(buf.subarray(KWM_HEADER_SIZE));
  for (let i = 0; i < audio.length; i += 1) {
    audio[i] ^= mask[i & 0x1f];
  }

  const format = detectAudioFormat(audio);
  if (format === "unknown") {
    throw new Error("KWM 解密结果不是可识别的音频格式。");
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-kwm-"));
  const nativePath = path.join(tempDir, `native.${format}`);
  await fsp.writeFile(nativePath, audio);
  return { nativePath, format, tempDir };
}

module.exports = { convertKwm, generateMask, padOrTruncate, detectAudioFormat, KWM_HEADER_SIZE };
