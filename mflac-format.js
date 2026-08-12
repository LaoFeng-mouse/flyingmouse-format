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

const { ekeyDecrypt, createQMC2 } = require("./kgg-format");

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

// 调 QQ 音乐 GetEVkey 接口获取 ekey（仅传歌曲 ID 与文件名）
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
    const ekey = data?.req_1?.data?.midurlinfo?.[0]?.ekey;
    if (!ekey) throw qmcError("QQ 音乐接口未返回密钥，登录状态可能已过期。", "MFLAC_EKEY_NETWORK");
    return ekey;
  } finally {
    clearTimeout(timer);
  }
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
  let audioEnd = buf.length;

  if (footer.type === "v1") {
    const keyStart = buf.length - 4 - footer.keySize;
    audioEnd = keyStart;
    ekey = buf.subarray(keyStart, buf.length - 4).toString("base64");
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
    ekey = await fetchEkeyFromApi(creds, apiFilename, footer.mediaMid);
  } else {
    throw qmcError("无法识别这个 MFLAC 的加密版本（footer 缺失或格式未知）。");
  }

  const key = ekeyDecrypt(ekey);
  if (!key || key.length < 8) throw qmcError("MFLAC 密钥解析失败。");
  const qmc2 = createQMC2(ekey);
  if (!qmc2) throw qmcError("MFLAC 密钥不合法。");

  const audio = Buffer.from(buf.subarray(0, audioEnd));
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

module.exports = { convertMflac, parseMflacFooter, loadQqMusicCredentials, fetchEkeyFromApi };
