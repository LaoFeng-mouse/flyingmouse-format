// mflac（QQ 音乐加密 FLAC，QMC 系）解密。
// 算法来自 unlock-music（DMCA 下架前的公开实现）的 qmcMask.ts：
//   - mflac 文件尾部 4 字节是密钥长度，密钥在文件末尾
//   - 从音频数据前 0x8000 字节内按 128 步长探测 mask（解密后 FLAC 头 "fLaC" 匹配）
//   - 128 字节 mask 逐字节异或（带 0x8000 边界跳位）
// 纯本地离线实现，无需在线密钥 API。QMCv1（默认 mask）格式同样支持。
const path = require("path");
const fsp = require("fs/promises");

const FLAC_HEADER = Buffer.from("fLaC", "latin1");
const QMC_SEARCH_LEN = 0x8000;

// QMCv1 默认 mask 矩阵（44 字节，unlock-music QMCDefaultMaskMatrix）
const QMCDefaultMaskMatrix = [
  0xde, 0x51, 0xfa, 0xc3, 0x4a, 0xd6, 0xca, 0x90,
  0x7e, 0x67, 0x5e, 0xf7, 0xd5, 0x52, 0x84, 0xd8,
  0x47, 0x95, 0xbb, 0xa1, 0xaa, 0xc6, 0x66, 0x23,
  0x92, 0x62, 0xf3, 0x74, 0xa1, 0x9f, 0xf4, 0xa0,
  0x1d, 0x3f, 0x5b, 0xf0, 0x13, 0x0e, 0x09, 0x3d,
  0xf9, 0xbc, 0x00, 0x11
];

// AllMapping / Mask128to44（44 字节矩阵 <-> 128 字节矩阵的映射）
const AllMapping = [];
const Mask128to44 = [];
(function initMapping() {
  for (let i = 0; i < 128; i += 1) {
    const realIdx = (i * i + 27) % 256;
    if (AllMapping[realIdx]) AllMapping[realIdx].push(i);
    else AllMapping[realIdx] = [i];
  }
  let idx44 = 0;
  AllMapping.forEach((group) => {
    for (const i of group) Mask128to44[i] = idx44;
    idx44 += 1;
  });
})();

class QmcMask {
  constructor(matrix) {
    if (matrix.length === 44) this.Matrix128 = this.generate128(matrix);
    else if (matrix.length === 128) this.Matrix128 = Array.from(matrix);
    else throw new Error("invalid mask length");
  }

  decrypt(data) {
    const dst = Buffer.from(data);
    let index = -1;
    let maskIdx = -1;
    for (let cur = 0; cur < dst.length; cur += 1) {
      index += 1;
      maskIdx += 1;
      if (index === 0x8000 || (index > 0x8000 && (index + 1) % 0x8000 === 0)) {
        index += 1;
        maskIdx += 1;
      }
      if (maskIdx >= 128) maskIdx -= 128;
      dst[cur] ^= this.Matrix128[maskIdx];
    }
    return dst;
  }

  generate128(matrix44) {
    const matrix128 = new Array(128);
    let idx44 = 0;
    AllMapping.forEach((group) => {
      for (const m of group) matrix128[m] = matrix44[idx44];
      idx44 += 1;
    });
    return matrix128;
  }
}

function qmcMaskGetDefault() {
  return new QmcMask(QMCDefaultMaskMatrix);
}

// 从加密数据前 0x8000 字节内按 128 步长探测 mask：把该 128 字节块当作 Matrix128，
// 若解出前 4 字节等于 "fLaC" 即为有效 mask。
function qmcMaskDetectMflac(data) {
  const searchLen = Math.min(QMC_SEARCH_LEN, data.length);
  for (let blockIdx = 0; blockIdx < searchLen; blockIdx += 128) {
    try {
      const mask = new QmcMask(data.subarray(blockIdx, blockIdx + 128));
      if (mask.decrypt(data.subarray(0, FLAC_HEADER.length)).equals(FLAC_HEADER)) {
        return mask;
      }
    } catch {
      // try next block
    }
  }
  return null;
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function qmcError(message) {
  const error = new Error(message);
  error.code = "MFLAC_DECRYPT_FAILED";
  error.messages = {
    zhCN: message,
    enUS: "MFLAC decryption failed."
  };
  return error;
}

// 解密 mflac：返回 { nativePath, format, tempDir }，交由 ffmpeg 转目标格式
async function convertMflac(inputPath) {
  const buf = await fsp.readFile(inputPath);
  if (buf.length < 16) throw qmcError("MFLAC 文件不完整。");

  // 现代 mflac：尾部 4 字节是密钥长度，密钥在文件末尾
  const keyLen = buf.readUInt32LE(buf.length - 4);
  let audioData = buf;
  let mask = null;
  if (keyLen > 0 && keyLen < buf.length - 4) {
    const keyPos = buf.length - 4 - keyLen;
    audioData = buf.subarray(0, keyPos);
    mask = qmcMaskDetectMflac(audioData);
    if (!mask) {
      // 老版 mflac（无尾 key 或探测失败）：尝试默认 mask
      mask = qmcMaskGetDefault();
    }
  } else {
    // 无尾 key：QMCv1 默认 mask
    mask = qmcMaskGetDefault();
  }

  const decrypted = mask.decrypt(audioData);
  const format = detectAudioFormat(decrypted);
  if (format === "unknown") {
    throw qmcError("MFLAC 解密结果不是可识别的音频格式。该文件可能是新版 QQ 音乐加密格式（QMCv2），需要真实样本验证后支持。");
  }

  const tempDir = await fsp.mkdtemp(path.join(require("os").tmpdir(), "flyingmouse-mflac-"));
  const nativePath = path.join(tempDir, `native.${format}`);
  await fsp.writeFile(nativePath, decrypted);
  return { nativePath, format, tempDir };
}

module.exports = { convertMflac, QmcMask, qmcMaskDetectMflac, qmcMaskGetDefault };
