// mflac（QQ 音乐加密音频，QMC 系）解密。
// 支持三类变体：
//   - QMC2 v1（尾部 4 字节 keyLen + key 嵌入）：离线解密
//   - QTag（尾部 QTag 标记 + ekey 嵌入）：离线解密
//   - musicex（新版，尾部 "musicex" 标记，ekey 不嵌入）：需调 QQ 音乐官方
//     GetEVkey 接口用歌曲 ID 换取密钥（仅上传歌曲 ID/文件名，不上传音频内容；
//     需要本机存在 QQ 音乐登录凭据文件，默认读桌面 QQ音乐_登录cookie.txt）
// 解密算法与酷狗 KGG v5 同源（QMC2：ekeyDecrypt + QMC2MAP/QMC2RC4），复用 kgg-format.js。
const path = require("path");
const os = require("os");
const fsp = require("fs/promises");

const { ekeyDecrypt, createQMC2, QMC2MAP, QMC2RC4 } = require("./kgg-format");

const FLAC_HEADER = Buffer.from("fLaC", "latin1");
const OGG_HEADER = Buffer.from("OggS", "latin1");
const MUSICEX_MAGIC = Buffer.from("musicex\x00", "latin1");
const QMC2_ENCV2_PREFIX = "QQMusic EncV2,Key:";
const API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const API_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const API_PLATFORM = "20";

// 每次调用动态计算，便于测试通过 FLYINGMOUSE_QQ_COOKIE 覆盖（隔离真实桌面凭据）。
function getDefaultCookiePath() {
  return process.env.FLYINGMOUSE_QQ_COOKIE || path.join(os.homedir(), "Desktop", "QQ音乐_登录cookie.txt");
}

function qmcError(message, code = "MFLAC_DECRYPT_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.messages = {
    zhCN: message,
    enUS: code === "MFLAC_EKEY_NETWORK" ? "Could not fetch the encryption key from QQ Music API." : "MFLAC decryption failed."
  };
  return error;
}

// 解析尾部 footer：musicex / QTag / V1（keyLen）
// ---- 标准腾讯 TEA（unlock-music qmc_key.ts 移植，mgg/mflac EncV2 变体用）----
const TEA_DELTA = 0x9e3779b9;
const MIX_KEY1 = Buffer.from([0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28]);
const MIX_KEY2 = Buffer.from([0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54]);

class TeaCipher {
  constructor(key, rounds = 64) {
    if (key.length !== 16) throw new Error("incorrect key size");
    const k = new DataView(key.buffer, key.byteOffset, 16);
    this.k0 = k.getUint32(0, false);
    this.k1 = k.getUint32(4, false);
    this.k2 = k.getUint32(8, false);
    this.k3 = k.getUint32(12, false);
    this.rounds = rounds;
  }
  decrypt(dst, src) {
    let v0 = src.getUint32(0, false);
    let v1 = src.getUint32(4, false);
    let sum = (TEA_DELTA * this.rounds) / 2;
    for (let i = 0; i < this.rounds / 2; i += 1) {
      v1 -= ((v0 << 4) + this.k2) ^ (v0 + sum) ^ ((v0 >>> 5) + this.k3);
      v0 -= ((v1 << 4) + this.k0) ^ (v1 + sum) ^ ((v1 >>> 5) + this.k1);
      sum -= TEA_DELTA;
    }
    dst.setUint32(0, v0, false);
    dst.setUint32(4, v1, false);
  }
}

// 腾讯 TEA-CBC：密文格式 PadLen(1)+Padding(0-7)+Salt(2)+Body+Zero(7)
function decryptTencentTea(inBuf, key) {
  if (inBuf.length % 8 !== 0) throw new Error("inBuf size not a multiple of the block size");
  if (inBuf.length < 16) throw new Error("inBuf size too small");
  const blk = new TeaCipher(key, 32);
  const tmpBuf = new Uint8Array(8);
  const tmpView = new DataView(tmpBuf.buffer);
  blk.decrypt(tmpView, new DataView(inBuf.buffer, inBuf.byteOffset, 8));
  const nPadLen = tmpBuf[0] & 0x7;
  const outLen = inBuf.length - 1 - nPadLen - 2 - 7;
  const outBuf = new Uint8Array(outLen);
  let ivPrev = new Uint8Array(8);
  let ivCur = inBuf.slice(0, 8);
  let inBufPos = 8;
  let tmpIdx = 1 + nPadLen;
  const cryptBlock = () => {
    ivPrev = ivCur;
    ivCur = inBuf.slice(inBufPos, inBufPos + 8);
    for (let j = 0; j < 8; j += 1) tmpBuf[j] ^= ivCur[j];
    blk.decrypt(tmpView, tmpView);
    inBufPos += 8;
    tmpIdx = 0;
  };
  for (let i = 1; i <= 2; ) {
    if (tmpIdx < 8) { tmpIdx += 1; i += 1; } else { cryptBlock(); }
  }
  let outBufPos = 0;
  while (outBufPos < outLen) {
    if (tmpIdx < 8) {
      outBuf[outBufPos] = tmpBuf[tmpIdx] ^ ivPrev[tmpIdx];
      outBufPos += 1;
      tmpIdx += 1;
    } else {
      cryptBlock();
    }
  }
  return outBuf;
}

function simpleMakeKey(salt, length) {
  const keyBuf = [];
  for (let i = 0; i < length; i += 1) {
    const tmp = Math.tan(salt + i * 0.1);
    keyBuf[i] = 0xff & (Math.abs(tmp) * 100.0);
  }
  return keyBuf;
}

// 解析 v1 key 区域：新版（EncV2）key 区域是 base64 文本，解码后以
// "QQMusic EncV2,Key:" 开头；旧版 key 区域是二进制 ekey（32 字节）。
function parseV1KeyRegion(keyRegion) {
  let decoded;
  try {
    decoded = Buffer.from(keyRegion.toString("utf8"), "base64");
  } catch {
    return { type: "legacy" };
  }
  if (
    decoded.length >= QMC2_ENCV2_PREFIX.length &&
    decoded.subarray(0, QMC2_ENCV2_PREFIX.length).toString("latin1") === QMC2_ENCV2_PREFIX
  ) {
    let out = decryptTencentTea(decoded.subarray(QMC2_ENCV2_PREFIX.length), MIX_KEY1);
    out = decryptTencentTea(out, MIX_KEY2);
    // 第二层明文是 ekey 字节的逗号分隔十进制序列（如 "77,70,104,81,..."）
    const nums = out.toString("utf8").split(",").map((s) => parseInt(s, 10));
    const numBuf = Buffer.from(nums);
    const text = numBuf.toString("latin1");
    const ekey = /^[A-Za-z0-9+/=\r\n]+$/.test(text) ? Buffer.from(text, "base64") : numBuf;
    return { type: "encv2", ekey };
  }
  return { type: "legacy" };
}

// EncV2 内层派生（unlock-music QmcDeriveKey）：simpleKey(106,8) 交错 + TEA → 流密钥
function deriveQmcKey(ekeyBinary) {
  const simpleKey = simpleMakeKey(106, 8);
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    teaKey[i << 1] = simpleKey[i];
    teaKey[(i << 1) + 1] = ekeyBinary[i];
  }
  const sub = decryptTencentTea(ekeyBinary.subarray(8), teaKey);
  return Buffer.concat([ekeyBinary.subarray(0, 8), Buffer.from(sub)]);
}

function parseMflacFooter(buffer) {
  if (buffer.length >= 16 && buffer.subarray(buffer.length - 8).equals(MUSICEX_MAGIC)) {
    const version = buffer.readUInt32LE(buffer.length - 12);
    const footerSize = buffer.readUInt32LE(buffer.length - 16);
    if (version === 1 && footerSize >= 16 && footerSize <= buffer.length) {
      const metaStart = buffer.length - footerSize;
      const meta = buffer.subarray(metaStart, buffer.length - 16);
      const songId = meta.length > 4 ? meta.readUInt32LE(0) : 0;
      const readUtf16 = (offset, maxBytes) => {
        if (offset + 2 > meta.length) return "";
        const end = Math.min(meta.length, offset + maxBytes);
        let text = "";
        for (let i = offset; i + 1 < end; i += 2) {
          const code = meta.readUInt16LE(i);
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        return text;
      };
      const mediaMid = readUtf16(0x0c, 60);
      const filename = readUtf16(0x48, 68);
      return { type: "musicex", songId, mediaMid, filename, footerSize };
    }
  }
  if (buffer.length >= 12 && buffer.readUInt32LE(buffer.length - 4) === 0x67615451) {
    const metaSize = buffer.readUInt32BE(buffer.length - 8);
    const metaEnd = buffer.length - 8;
    const metaStart = metaEnd - metaSize;
    if (metaStart >= 0 && metaSize < 0x10000) {
      const meta = buffer.subarray(metaStart, metaEnd).toString("utf8");
      const parts = meta.split(",");
      if (parts.length >= 2) {
        return { type: "qtag", ekey: parts[0], songId: parts[1] };
      }
    }
  }
  const keySize = buffer.readUInt32LE(buffer.length - 4);
  if (keySize > 0 && keySize <= 0x400 && keySize < buffer.length - 8) {
    return { type: "v1", keySize };
  }
  return { type: "unknown" };
}

// 从用户 cookie 文件读取 QQ 音乐登录凭据（uin + authst 候选）
async function loadQqMusicCredentials(cookiePath) {
  const candidates = [cookiePath, getDefaultCookiePath()].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = await fsp.readFile(file, "utf8");
      const uinMatch = /(?:^|;\s*)uin=(\d+)/.exec(text);
      const authstMatch = /(?:^|;\s*)(qm_keyst|qqmusic_key)=([^;]+)/.exec(text);
      if (uinMatch && authstMatch) {
        return { uin: uinMatch[1], authst: authstMatch[2] };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// 调 QQ 音乐 GetEVkey 接口获取 ekey（仅传歌曲 ID 与文件名）。
// 返回 { ekey, purl, sip }；ekey 为空 = 该档位当前账号无权限（非网络错误，交给调用方降档）。
async function fetchEkeyFromApi(creds, filename, songMid) {
  const body = {
    comm: {
      authst: creds.authst,
      ct: "19",
      cv: "1859",
      uin: creds.uin,
      tme_login_type: "3"
    },
    req_1: {
      module: "music.vkey.GetEVkey",
      method: "CgiGetEVkey",
      param: {
        filename: [filename],
        guid: "10000",
        songmid: [songMid],
        songtype: [1],
        uin: creds.uin,
        loginflag: 1,
        platform: API_PLATFORM,
        ctx: 1
      }
    }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": API_UA,
        "Referer": "https://y.qq.com/"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw qmcError(`QQ 音乐接口返回 HTTP ${response.status}。`, "MFLAC_EKEY_NETWORK");
    const data = await response.json();
    const info = data?.req_1?.data?.midurlinfo?.[0] || {};
    const sip = data?.req_1?.data?.sip;
    return { ekey: info.ekey || "", purl: info.purl || "", sip: Array.isArray(sip) ? sip : [] };
  } finally {
    clearTimeout(timer);
  }
}

// musicex 无权限时的降档候选（同一首歌的较低音质档位，文件名 = 档位前缀 + songmid）
function musicexFallbackFilenames(mediaMid) {
  return [
    { filename: `F0M${mediaMid}.mflac`, label: "FLAC 无损" },
    { filename: `O4M${mediaMid}.mgg`, label: "OGG 高音质" },
    { filename: `M500${mediaMid}.mp3`, label: "MP3 320k" }
  ];
}

// 下载 QQ 音乐官方 CDN 加密文件（purl 相对路径 + sip 前缀逐个尝试）
async function downloadMusicexFile(purl, sip) {
  const bases = [...new Set([...(sip || []).filter(Boolean), "https://dl.stream.qqmusic.qq.com/"])];
  let lastError = null;
  for (const base of bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const resp = await fetch(base + purl, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 10000) return buf;
      throw new Error("下载内容过小");
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw qmcError(`下载加密音频失败：${lastError ? lastError.message : "未知错误"}。`, "MFLAC_EKEY_NETWORK");
}

// 解析 musicex 密钥：先原档，无权限自动降档下载；返回 { type, ekey, fileBuf?, audioEnd? }
async function resolveMusicex(creds, footer, originalFilename) {
  const first = await fetchEkeyFromApi(creds, originalFilename, footer.mediaMid);
  if (first.ekey) return { type: "direct", ekey: first.ekey };

  for (const fb of musicexFallbackFilenames(footer.mediaMid)) {
    const info = await fetchEkeyFromApi(creds, fb.filename, footer.mediaMid);
    if (!info.ekey || !info.purl) continue;
    const fileBuf = await downloadMusicexFile(info.purl, info.sip);
    // 下载档位的文件可能带 musicex footer，也可能是无 footer 的裸 QMC2 加密体
    const fbFooter = parseMflacFooter(fileBuf);
    const audioEnd = fbFooter.type === "musicex" ? fileBuf.length - fbFooter.footerSize : fileBuf.length;
    return {
      type: "downloaded",
      ekey: info.ekey,
      fileBuf,
      audioEnd,
      note: fb.label
    };
  }

  throw qmcError(
    "这首歌的所有音质档位（含 FLAC/OGG/MP3 降级）都无在线密钥权限，可能已下架或需单独购买；请确认账号权限后重试。",
    "MFLAC_EKEY_NETWORK"
  );
}

function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).equals(FLAC_HEADER)) return "flac";
  if (buf.length > 3 && buf.subarray(0, 4).equals(OGG_HEADER)) return "ogg";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

// 解密 mflac：返回 { nativePath, format, tempDir }
async function convertMflac(inputPath, options = {}) {
  const buf = await fsp.readFile(inputPath);
  if (buf.length < 16) throw qmcError("MFLAC 文件不完整。");
  const footer = parseMflacFooter(buf);
  let ekey = null;
  let qmc2 = null;
  let audioEnd = buf.length;
  let audioSource = buf;

  if (footer.type === "v1") {
    const keyStart = buf.length - 4 - footer.keySize;
    audioEnd = keyStart;
    const keyRegion = buf.subarray(keyStart, buf.length - 4);
    const parsed = parseV1KeyRegion(keyRegion);
    if (parsed.type === "encv2") {
      // mgg/mflac 新版（EncV2）：双 TEA + 逗号序列解析 + 内层派生 → 直接构造流密码
      const finalKey = deriveQmcKey(parsed.ekey);
      qmc2 = finalKey.length < 300 ? new QMC2MAP(finalKey) : new QMC2RC4(finalKey);
    } else {
      // 旧版：key 区域是二进制 ekey（32 字节），base64 编码后走 ekeyDecrypt
      ekey = keyRegion.toString("base64");
    }
  } else if (footer.type === "qtag") {
    ekey = footer.ekey;
    audioEnd = buf.length - 8 - (buf.readUInt32BE(buf.length - 8));
  } else if (footer.type === "musicex") {
    audioEnd = buf.length - footer.footerSize;
    const apiFilename = /\.(mgg|mflac|mgg0|mgg1|mggl|mflac0|mflach)$/i.test(footer.filename)
      ? footer.filename
      : `${footer.filename}${path.extname(inputPath) || ".mflac"}`;
    const creds = await loadQqMusicCredentials(options.cookiePath);
    if (!creds) {
      throw qmcError(
        "这个 MFLAC 是新版加密（musicex），需要 QQ 音乐登录凭据在线换取密钥；请把 QQ 音乐的登录 cookie 文件放到桌面（QQ音乐_登录cookie.txt）后重试。",
        "MFLAC_EKEY_REQUIRED"
      );
    }
    // 先原档换密钥；原档无权限时自动尝试同一首歌的其他音质档位（F0M 无损/O4M/M500）
    const resolved = await resolveMusicex(creds, footer, apiFilename);
    if (resolved.type === "downloaded") {
      audioSource = resolved.fileBuf;
      audioEnd = resolved.audioEnd;
    }
    ekey = resolved.ekey;
  } else {
    throw qmcError("无法识别这个 MFLAC 的加密版本（footer 缺失或格式未知）。");
  }

  if (!qmc2) {
    const key = ekeyDecrypt(ekey);
    if (!key || key.length < 8) throw qmcError("MFLAC 密钥解析失败。");
    qmc2 = createQMC2(ekey);
    if (!qmc2) throw qmcError("MFLAC 密钥不合法。");
  }

  const audio = Buffer.from(audioSource.subarray(0, audioEnd));
  qmc2.decrypt(audio, 0);
  const format = detectAudioFormat(audio);
  if (format === "unknown") {
    throw qmcError("MFLAC 解密结果不是可识别的音频格式。");
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-mflac-"));
  const nativePath = path.join(tempDir, `native.${format}`);
  await fsp.writeFile(nativePath, audio);
  return { nativePath, format, tempDir };
}

module.exports = { convertMflac, parseMflacFooter, parseV1KeyRegion, deriveQmcKey, loadQqMusicCredentials, fetchEkeyFromApi, musicexFallbackFilenames };
