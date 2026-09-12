// audio-decrypt.js
// 本地音乐平台加密音频格式「去混淆」预处理（自用 · 非商用）。
//
// 作用：把 NCM / 酷我系列(mflac/mgg/kgma/kwm) 等混淆容器还原为原始音频(flac/mp3)，
//       还原结果作为临时文件交给 media.js 现有 FFmpeg 管线统一转 MP3。
//
// 算法说明：
//   - NCM(网易云)：使用 ncmdump-js（MIT License）解析并解密，内部为
//     AES-128-ECB(CORE_KEY) 解密 key data → RC4 seed → RC4 解密音频。
//     自行实现 NCM 时 key data 偏移在实践中与部分样本存在 2 字节差，
//     ncmdump-js 经过充分测试直接使用。
//   - 酷我系列：前 1024 字节与伪随机 mask 异或，之后为明文 flac/mp3（自实现）。
//
// 边界：仅处理本人已下载到本机、合法拥有的音频；禁止传播/转卖/商用/搭建在线服务。

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// NCM 解密使用 ncmdump-js（MIT License，https://www.npmjs.com/package/ncmdump-js）
// 该库经验证可正确处理本样本，无需自行维护存在偏移差异的算法实现。
let _ncmdumpJs = null;
function getNcmdump() {
  if (!_ncmdumpJs) {
    try {
      _ncmdumpJs = require("ncmdump-js");
    } catch (e) {
      throw new Error("ncmdump-js 未安装，请运行 npm install ncmdump-js");
    }
  }
  return _ncmdumpJs;
}

// 需要走「去混淆」预处理的输入扩展名
const ENCRYPTED_EXT = new Set(["ncm", "mflac", "mgg", "kgma", "kwm", "kgg", "vpr", "mmp4"]);

function isEncryptedAudio(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ENCRYPTED_EXT.has(ext);
}

function extForMagic(buf) {
  if (buf.indexOf(Buffer.from("fLaC")) >= 0) return "flac";
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "mp3"; // ID3
  if ((buf[0] & 0xff) === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "mp3";
}

// ---------- NCM（网易云音乐）----------
// ncmdump-js parseNcm(file: Uint8Array) -> { format, metadata, image, audio: Uint8Array }
function decryptNCMBuffer(buf) {
  const ncmdump = getNcmdump();
  let u8;
  if (buf instanceof Uint8Array) {
    u8 = buf;
  } else {
    u8 = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) u8[i] = buf[i];
  }
  const result = ncmdump.parseNcm(u8);
  return Buffer.from(result.audio);
}

// ---------- 酷我系列（kwm/kgma/mflac/mgg）----------
// 公开算法：前 1024 字节被 1024 字节 mask 异或，mask 由文件头某个字节(seed)经 LCG 生成
const KUWO_LCG_MULT = 0x343fd;
const KUWO_LCG_ADD = 0x269ec3;

function buildKuwoMask(seed) {
  const mask = new Uint8Array(1024);
  let s = seed & 0xffffffff;
  for (let i = 0; i < 1024; i++) {
    s = (Math.imul(s, KUWO_LCG_MULT) + KUWO_LCG_ADD) & 0xffffffff;
    mask[i] = (s >>> 16) & 0xff;
  }
  return mask;
}

function decryptKuwoBuffer(buf) {
  if (buf.length < 1024) return buf;
  const seed = buf[8] & 0xff;
  const table = buildKuwoMask(seed);
  for (let i = 0; i < 1024; i++) buf[i] ^= table[i];
  return buf;
}

// ---------- 主入口：解密到临时文件 ----------
async function maybeDecryptToTemp(inputPath, options = {}) {
  // 优先从 options.inputExt 获取扩展名（Multer 上传后路径无扩展名）
  const ext = (options.inputExt || path.extname(inputPath).slice(1) || "").toLowerCase();
  if (!ENCRYPTED_EXT.has(ext)) return null;
  const raw = await fs.promises.readFile(inputPath);

  let audioBuf = null;
  if (ext === "ncm") {
    audioBuf = decryptNCMBuffer(raw);
    if (!audioBuf || audioBuf.length < 1024) {
      throw new Error("NCM 解密失败：结果过短，可能文件损坏或 ncmdump-js 运行异常。");
    }
  } else if (ext === "mflac" || ext === "mgg" || ext === "kgma" || ext === "kwm") {
    audioBuf = decryptKuwoBuffer(Buffer.from(raw));
  } else {
    throw new Error(`暂未实现：${ext}（KGG 等需读取本机对应音乐客户端密钥库，另行处理）。`);
  }

  const detected = extForMagic(audioBuf);
  const tmpPath = path.join(
    os.tmpdir(),
    `fm-decrypt-${Date.now()}-${Math.random().toString(16).slice(2)}.${detected}`
  );
  await fs.promises.writeFile(tmpPath, audioBuf);
  return {
    tempPath: tmpPath,
    detectedFormat: detected,
    cleanup: async () => {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    },
  };
}

module.exports = { isEncryptedAudio, ENCRYPTED_EXT, maybeDecryptToTemp, decryptNCMBuffer, decryptKuwoBuffer };
