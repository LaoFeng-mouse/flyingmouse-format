// kwm-format.js — 酷我音乐加密音频 .kwm 离线解密。
//
// KWM 是酷我音乐（现腾讯音乐 TME）的加密格式，magic 为 "yeelion-kuwo-tme"
// （或 "yeelion-kuwo\0\0\0\0"），头部固定 0x400 字节：
//   - 0x00-0x0F: magic
//   - 0x18-0x1F: 8 字节小端 key（uint64）
//   - 0x30-0x37: 码率+扩展名，如 "320MP3" / "320FLAC"
//   - 0x400 起: XOR 加密的音频数据
// 优先使用文件头 key 生成 mask；若已知旧版文件头 key 不可用，则参考
// music-geshizhuanhuan 的实现，从静音区重复密文块恢复 32 字节循环 mask，
// 并用解密后的音频容器魔数交叉验证候选，避免盲目输出乱码。
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { detectAudioFormat } = require("./audio-sniffer");

const KWM_HEADER_SIZE = 0x400;
const KWM_MAGIC_1 = "yeelion-kuwo-tme";
const KWM_MAGIC_2 = "yeelion-kuwo\x00\x00\x00\x00";
const KWM_PREDEFINED_KEY = "MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk"; // 32 字节
const KWM_KEY_SIZE = 32;
const KWM_MAX_SCAN_CHUNKS = 2048;


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

function decryptWithMask(body, mask) {
  const output = Buffer.from(body);
  for (let i = 0; i < output.length; i += 1) output[i] ^= mask[i & (KWM_KEY_SIZE - 1)];
  return output;
}

function formatWithMask(body, mask) {
  const probe = decryptWithMask(body.subarray(0, 4096), mask);
  return detectAudioFormat(probe, { skipLeadingZeros: true });
}

function recoverMask(body) {
  if (body.length < KWM_KEY_SIZE * 2) return null;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    const id = candidate.toString("hex");
    if (!seen.has(id)) {
      seen.add(id);
      candidates.push(Buffer.from(candidate));
    }
  };

  let previous = body.subarray(0, KWM_KEY_SIZE);
  const scanChunks = Math.min(KWM_MAX_SCAN_CHUNKS, Math.floor(body.length / KWM_KEY_SIZE));
  for (let chunkIndex = 1; chunkIndex < scanChunks; chunkIndex += 1) {
    const chunk = body.subarray(chunkIndex * KWM_KEY_SIZE, (chunkIndex + 1) * KWM_KEY_SIZE);
    if (chunk.equals(previous)) addCandidate(chunk);
    previous = chunk;
  }
  addCandidate(Buffer.concat([
    previous.subarray(KWM_KEY_SIZE / 2),
    previous.subarray(0, KWM_KEY_SIZE / 2)
  ]));

  const broadScanChunks = Math.min(64, Math.floor(body.length / KWM_KEY_SIZE));
  for (let chunkIndex = 0; chunkIndex < broadScanChunks; chunkIndex += 1) {
    addCandidate(body.subarray(chunkIndex * KWM_KEY_SIZE, (chunkIndex + 1) * KWM_KEY_SIZE));
  }
  return candidates.find((candidate) => formatWithMask(body, candidate) !== "unknown") || null;
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
  const body = buf.subarray(KWM_HEADER_SIZE);
  let mask = generateMask(Buffer.from(buf.subarray(0x18, 0x20)));
  let format = formatWithMask(body, mask);
  if (format === "unknown") {
    mask = recoverMask(body);
    if (!mask) throw new Error("KWM 解密结果不是可识别的音频格式。");
    format = formatWithMask(body, mask);
  }
  const audio = decryptWithMask(body, mask);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-kwm-"));
  const nativePath = path.join(tempDir, `native.${format}`);
  await fsp.writeFile(nativePath, audio);
  return { nativePath, format, tempDir };
}

module.exports = {
  convertKwm,
  generateMask,
  recoverMask,
  decryptWithMask,
  padOrTruncate,
  detectAudioFormat,
  KWM_HEADER_SIZE
};
