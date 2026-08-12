// Kugou Music .kgg (v5) format support — converts to a playable audio file.
// Algorithm ported from unlock-music CLI derivatives (C++ AudioDecrypt + Go Kugo-Music-Converter),
// which are themselves ports of the DMCA-removed unlock-music project.
// Key mapping comes from the desktop client's encrypted SQLite database KGMusicV3.db
// (located under %APPDATA%\KuGou8\ by default).
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const initSqlJs = require("sql.js");

// --- constants (from KGG.h / database.go / QMC2.h) ---
const DB_PAGE_SIZE = 0x400;
const SQLITE_HEADER = Buffer.from("SQLite format 3\x00");
const MASTER_KEY = Buffer.from([0x1d, 0x61, 0x31, 0x45, 0xb2, 0x47, 0xbf, 0x7f, 0x3d, 0x18, 0x96, 0x72, 0x14, 0x4f, 0xe4, 0xbf]);
const EKEY_V2_PREFIX = "UVFNdXNpYyBFbmNWMixLZXk6";
const EKEY_V2_KEY1 = Buffer.from([0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28]);
const EKEY_V2_KEY2 = Buffer.from([0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54]);
const QMC_MAP_BOUNDARY = 0x7fff;
const QMC_MAP_INDEX_OFFSET = 71214;
const QMC_MAP_KEY_SIZE = 128;
const QMC_FIRST_SEGMENT = 0x80;
const QMC_OTHER_SEGMENT = 0x1400;
const QMC_RC4_STREAM_SIZE = QMC_OTHER_SEGMENT + 512;

function aesCbcDecrypt(data, key, iv) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function nextPageIV(seed) {
  // uint32 arithmetic
  const left = (seed * 0x9ef4) >>> 0;
  const right = (Math.floor(seed / 0xce26) * 0x7fffff07) >>> 0;
  let value = (left - right) >>> 0;
  if ((value & 0x80000000) === 0) return value >>> 0;
  return (value + 0x7fffff07) >>> 0;
}

function derivePageAESKey(seed, master) {
  const buf = Buffer.alloc(0x18);
  master.copy(buf, 0, 0, 0x10);
  buf.writeUInt32LE(seed, 0x10);
  buf.writeUInt32LE(0x546c4173, 0x14);
  return crypto.createHash("md5").update(buf).digest();
}

function derivePageAESIV(seed) {
  const iv = Buffer.alloc(0x10);
  seed = (seed + 1) >>> 0;
  for (let i = 0; i < 0x10; i += 4) {
    seed = nextPageIV(seed);
    iv.writeUInt32LE(seed, i);
  }
  return crypto.createHash("md5").update(iv).digest();
}

function validatePage1Header(header) {
  if (header.length < 0x18) return false;
  const o10 = header.readUInt32LE(0x10);
  const o14 = header.readUInt32LE(0x14);
  const v6 = ((o10 & 0xff) << 8) | ((o10 & 0xff00) << 16);
  return o14 === 0x20204000 && v6 - 0x200 <= 0xfe00 && (v6 & (v6 - 1)) === 0;
}

function decryptPage(buffer, pageNumber, master) {
  const key = derivePageAESKey(pageNumber, master);
  const iv = derivePageAESIV(pageNumber);
  const dec = aesCbcDecrypt(buffer, key, iv);
  dec.copy(buffer);
}

function decryptPcDatabase(buffer) {
  if (buffer.length >= SQLITE_HEADER.length && buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    return buffer; // not encrypted
  }
  if (buffer.length === 0 || buffer.length % DB_PAGE_SIZE !== 0) {
    throw new Error("kgg db: invalid database size");
  }
  const firstPage = Buffer.from(buffer.subarray(0, DB_PAGE_SIZE));
  if (!validatePage1Header(firstPage)) {
    throw new Error("kgg db: invalid page 1 header");
  }
  const expectedHdr = Buffer.from(firstPage.subarray(0x10, 0x18));
  const hdr = Buffer.from(firstPage.subarray(0, 0x10));
  // swap trick per reference: page[0x10..0x18] = page[0x08..0x10]
  hdr.subarray(0x08, 0x10).copy(firstPage, 0x10);
  decryptPage(firstPage.subarray(0x10), 1, MASTER_KEY);
  if (!firstPage.subarray(0x10, 0x18).equals(expectedHdr)) {
    throw new Error("kgg db: page 1 integrity check failed");
  }
  SQLITE_HEADER.copy(buffer, 0);
  firstPage.subarray(0x10).copy(buffer, 0x10);

  for (let pageNo = 2; pageNo <= buffer.length / DB_PAGE_SIZE; pageNo += 1) {
    decryptPage(buffer.subarray((pageNo - 1) * DB_PAGE_SIZE, pageNo * DB_PAGE_SIZE), pageNo, MASTER_KEY);
  }
  return buffer;
}

async function loadKeyMap(dbPath) {
  const raw = await fsp.readFile(dbPath);
  decryptPcDatabase(raw);
  const SQL = await initSqlJs();
  const db = new SQL.Database(raw);
  const results = db.exec(
    "SELECT EncryptionKeyId, EncryptionKey FROM ShareFileItems WHERE EncryptionKeyId IS NOT NULL AND EncryptionKeyId != '' AND EncryptionKey IS NOT NULL AND EncryptionKey != ''"
  );
  db.close();
  const map = {};
  if (results.length && results[0].values) {
    for (const row of results[0].values) {
      if (row[0] && row[1]) map[String(row[0])] = String(row[1]);
    }
  }
  return map;
}

function candidateDbPaths() {
  const candidates = [
    process.env.FLYINGMOUSE_KGG_DB_PATH,
    path.join(process.env.APPDATA || "", "KuGou8", "KGMusicV3.db"),
    path.join(process.env.LOCALAPPDATA || "", "KuGou8", "KGMusicV3.db"),
    path.join(os.homedir(), "AppData", "Roaming", "KuGou8", "KGMusicV3.db")
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

// --- TEA (tc_tea_cbc_decrypt) ---
const TEA_ROUNDS = 16;
const TEA_DELTA = 0x9e3779b9;
const TEA_EXPECTED_SUM = (TEA_ROUNDS * TEA_DELTA) >>> 0;

function teaSingleRound(value, sum, k1, k2) {
  const a = ((value << 4) + k1) >>> 0;
  const b = (value + sum) >>> 0;
  const c = ((value >>> 5) + k2) >>> 0;
  return (a ^ b ^ c) >>> 0;
}

function teaEcbDecrypt(value, key) {
  // value: BigInt 64-bit
  let y = Number((value >> 32n) & 0xffffffffn) >>> 0;
  let z = Number(value & 0xffffffffn) >>> 0;
  let sum = TEA_EXPECTED_SUM;
  for (let i = 0; i < TEA_ROUNDS; i += 1) {
    z = (z - teaSingleRound(y, sum, key[2], key[3])) >>> 0;
    y = (y - teaSingleRound(z, sum, key[0], key[1])) >>> 0;
    sum = (sum - TEA_DELTA) >>> 0;
  }
  return (BigInt(y) << 32n) | BigInt(z);
}

function teaCbcDecrypt(cipher, key) {
  if (cipher.length % 8 !== 0 || cipher.length < 16) return Buffer.alloc(0);
  let iv1 = 0n;
  let iv2 = 0n;
  const header = Buffer.alloc(16);
  const out = [];
  let pos = 0;

  function decryptRound(dst, src, isLast) {
    const iv1Next = BigInt(src.readUInt32BE(0)) << 32n | BigInt(src.readUInt32BE(4));
    const iv2Next = teaEcbDecrypt((iv1Next ^ iv2) & ((1n << 64n) - 1n), key);
    const plain = (iv2Next ^ iv1) & ((1n << 64n) - 1n);
    iv1 = iv1Next;
    iv2 = iv2Next;
    dst.writeUInt32BE(Number((plain >> 32n) & 0xffffffffn), 0);
    dst.writeUInt32BE(Number(plain & 0xffffffffn), 4);
  }

  decryptRound(header, cipher.subarray(0, 8));
  decryptRound(header.subarray(8), cipher.subarray(8, 16));
  pos = 16;

  const hdrSkip = 1 + (header[0] & 7) + 2; // kFixedSaltLen = 2
  const zeroPad = 7;
  const realLen = cipher.length - hdrSkip - zeroPad;
  const result = Buffer.alloc(realLen);

  let copyLen = Math.min(16 - hdrSkip, realLen);
  if (copyLen > 0) header.subarray(hdrSkip, hdrSkip + copyLen).copy(result, 0);

  let outPos = copyLen;
  let remaining = realLen - copyLen;
  while (remaining > 0 && pos + 8 <= cipher.length) {
    const block = Buffer.alloc(8);
    decryptRound(block, cipher.subarray(pos, pos + 8));
    pos += 8;
    const take = Math.min(8, remaining);
    block.subarray(0, take).copy(result, outPos);
    outPos += take;
    remaining -= take;
  }
  return result;
}

// --- ekey decrypt ---
function ekeyDecryptV1(ekey) {
  let result = Buffer.from(ekey, "base64");
  if (result.length < 8) return Buffer.alloc(0);
  const teaKey = [
    (0x69005600 | (result[0] << 16) | result[1]) >>> 0,
    (0x46003800 | (result[2] << 16) | result[3]) >>> 0,
    (0x2b002000 | (result[4] << 16) | result[5]) >>> 0,
    (0x15000b00 | (result[6] << 16) | result[7]) >>> 0
  ];
  const decrypted = teaCbcDecrypt(result.subarray(8), teaKey);
  return Buffer.concat([result.subarray(0, 8), decrypted]);
}

function ekeyDecrypt(ekey) {
  if (ekey.startsWith(EKEY_V2_PREFIX)) {
    const rest = ekey.slice(EKEY_V2_PREFIX.length);
    let result = teaCbcDecrypt(Buffer.from(rest, "utf8"), EKEY_V2_KEY1);
    result = teaCbcDecrypt(result, EKEY_V2_KEY2);
    return ekeyDecryptV1(result.toString("utf8"));
  }
  return ekeyDecryptV1(ekey);
}

// --- QMC2 ---
function qmc2Hash(key) {
  let hash = 1;
  for (const b of key) {
    if (b === 0) continue;
    const next = (hash * b) >>> 0;
    if (next <= hash) break;
    hash = next;
  }
  return hash;
}

function qmc2SegmentKey(keyHash, segmentId, seed) {
  if (seed === 0) return 0;
  return Math.floor((keyHash / (seed * (segmentId + 1))) * 100);
}

function rc4Keystream(key, len) {
  const n = key.length;
  const s = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    j = (j + s[i] + key[i]) % n;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = Buffer.alloc(len);
  let a = 0; let b = 0;
  for (let k = 0; k < len; k += 1) {
    a = (a + 1) % n;
    b = (b + s[a]) % n;
    const t = s[a]; s[a] = s[b]; s[b] = t;
    out[k] = s[(s[a] + s[b]) % n];
  }
  return out;
}

class QMC2RC4 {
  constructor(key) {
    this.key = Buffer.from(key);
    this.hash = qmc2Hash(this.key);
    this.stream = rc4Keystream(this.key, QMC_RC4_STREAM_SIZE);
  }

  decrypt(data, offset) {
    const n = this.key.length;
    let pos = 0;
    if (offset < QMC_FIRST_SEGMENT) {
      const processLen = Math.min(data.length, QMC_FIRST_SEGMENT - offset);
      for (let i = 0; i < processLen; i += 1) {
        const idx = qmc2SegmentKey(this.hash, offset, this.key[offset % n]) % n;
        data[i] ^= this.key[idx];
        offset += 1;
      }
      pos = processLen;
    }
    while (pos < data.length) {
      const segmentIdx = Math.floor(offset / QMC_OTHER_SEGMENT);
      const segmentOffset = offset % QMC_OTHER_SEGMENT;
      const skipLen = qmc2SegmentKey(this.hash, segmentIdx, this.key[segmentIdx % n]) & 0x1ff;
      const processLen = Math.min(data.length - pos, QMC_OTHER_SEGMENT - segmentOffset);
      for (let i = 0; i < processLen; i += 1) {
        data[pos + i] ^= this.stream[skipLen + segmentOffset + i];
      }
      offset += processLen;
      pos += processLen;
    }
  }
}

class QMC2MAP {
  constructor(key) {
    const n = key.length;
    this.keyMap = new Uint8Array(QMC_MAP_KEY_SIZE);
    for (let i = 0; i < QMC_MAP_KEY_SIZE; i += 1) {
      const j = (i * i + QMC_MAP_INDEX_OFFSET) % n;
      const shift = (j + 4) % 8;
      const b = key[j];
      this.keyMap[i] = ((b << shift) | (b >> shift)) & 0xff;
    }
  }

  decrypt(data, offset) {
    for (let i = 0; i < data.length; i += 1) {
      const idx = offset <= QMC_MAP_BOUNDARY ? offset : offset % QMC_MAP_BOUNDARY;
      data[i] ^= this.keyMap[idx % this.keyMap.length];
      offset += 1;
    }
  }
}

function createQMC2(ekey) {
  const key = ekeyDecrypt(ekey);
  if (!key.length) return null;
  if (key.length < 300) return new QMC2MAP(key);
  return new QMC2RC4(key);
}

// --- main kgg decrypt ---
function detectAudioFormat(buf) {
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (buf.length > 2 && buf.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

let cachedKeyMap = null;

async function getKeyMap() {
  if (cachedKeyMap) return cachedKeyMap;
  const dbPath = candidateDbPaths();
  if (!dbPath) {
    throw new Error("找不到酷狗密钥库 KGMusicV3.db（预期在 %APPDATA%\\KuGou8\\ 下）。请确认本机安装过酷狗音乐并下载过歌曲。");
  }
  cachedKeyMap = await loadKeyMap(dbPath);
  return cachedKeyMap;
}

async function convertKgg(inputPath) {
  const buf = await fsp.readFile(inputPath);
  if (buf.length < 76) throw new Error("KGG 文件不完整。");
  const headerLen = buf.readUInt32LE(16);
  const mode = buf.readUInt32LE(20);
  if (mode !== 5) {
    throw new Error(`暂不支持这个 KGG 版本（mode=${mode}，仅支持 v5）。`);
  }
  const hashLen = buf.readUInt32LE(68);
  const audioHash = buf.subarray(72, 72 + hashLen).toString("utf8");

  const keyMap = await getKeyMap();
  const ekey = keyMap[audioHash];
  if (!ekey) {
    throw new Error("在酷狗密钥库中找不到这首歌的密钥：可能是密钥库过期，或歌曲不是在本机酷狗客户端下载的。");
  }
  const qmc2 = createQMC2(ekey);
  if (!qmc2) throw new Error("KGG 密钥解析失败。");

  const audio = Buffer.from(buf.subarray(headerLen));
  qmc2.decrypt(audio, 0);
  const format = detectAudioFormat(audio);
  if (format === "unknown") {
    throw new Error("KGG 解密结果不是可识别的音频格式。");
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-kgg-"));
  const nativePath = path.join(tempDir, `native.${format}`);
  await fsp.writeFile(nativePath, audio);
  return { nativePath, format, tempDir };
}

module.exports = { convertKgg, loadKeyMap, candidateDbPaths, ekeyDecrypt, createQMC2 };
