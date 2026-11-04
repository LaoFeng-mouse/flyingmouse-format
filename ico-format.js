// ico-format.js — ICO（Windows 图标）容器读写（零依赖，纯 Buffer 操作）。
// 背景：sharp 的预编译构建（libvips 8.18.3）不支持 ICO 输入/输出（sharp.format 无 ico），
// 而 ICO 本质是「容器」：ICONDIR + N 个 ICONDIRENTRY + 各帧数据（PNG 或 BMP DIB）。
// 本模块只做容器解析/组装，像素解码交给 sharp（PNG 帧）或 bmp-input（BMP DIB 帧）。
//
// 读：extractBestFrame 挑最大/最清晰帧——PNG 帧（现代 ICO，256×256 常为 PNG，带 alpha）优先，
//     兜底 BMP DIB 帧（老式 ICO，补 BITMAPFILEHEADER + 高度减半去除 AND mask 后交给 bmp-input）。
// 写：encodeIco 把多尺寸 PNG 帧（16/24/32/48/64/128/256）组装成 ICO 容器（PNG 帧内嵌，Vista+ 支持）。

const fs = require("fs");
const { decodeBmpToRaw } = require("./bmp-input");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ICO_BYTES = 64 * 1024 * 1024;

// ICO 魔数：reserved=0 + type=1（0x00 0x00 0x01 0x00）
function isIcoBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 6
    && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1;
}

// 只读文件头 6 字节判断是否为 ICO，避免把大文件整读进内存。
function isIcoFileSync(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(6);
    const read = fs.readSync(fd, header, 0, 6, 0);
    return read === 6 && header.readUInt16LE(0) === 0 && header.readUInt16LE(2) === 1;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function unsupported(message) {
  const error = new Error(message);
  error.code = "ICO_UNSUPPORTED_VARIANT";
  return error;
}

async function readIcoFile(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_ICO_BYTES) throw unsupported("ICO 文件超过 64 MiB 安全读取上限。");
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(data, offset, size - offset, offset);
      if (!bytesRead) throw unsupported("ICO 文件数据不完整。");
      offset += bytesRead;
    }
    return data;
  } finally {
    await handle.close();
  }
}

function validatePng(data, width, height) {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)
      || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR"
      || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
    throw unsupported("ICO 内嵌 PNG 的尺寸或文件头不正确。");
  }
}

// 解析 ICO 目录，返回 { count, entries }。
// entry: { width, height, bytes, offset, png, data }
function parseIco(buffer) {
  if (!isIcoBuffer(buffer)) throw unsupported("不是有效的 ICO 文件。");
  if (buffer.length > MAX_ICO_BYTES) throw unsupported("ICO 文件超过 64 MiB 安全读取上限。");
  const count = buffer.readUInt16LE(4);
  if (count < 1 || count > 512) throw unsupported("ICO 图像帧数量异常。");
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > buffer.length) throw unsupported("ICO 目录项不完整。");
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    if (base + 16 > buffer.length) throw unsupported("ICO 目录项不完整。");
    const width = buffer[base] === 0 ? 256 : buffer[base];
    const height = buffer[base + 1] === 0 ? 256 : buffer[base + 1];
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (!bytes || offset < directoryEnd || offset + bytes > buffer.length) throw unsupported("ICO 图像数据越界。");
    const data = buffer.subarray(offset, offset + bytes);
    const png = data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);
    if (png) validatePng(data, width, height);
    entries.push({ width, height, bytes, offset, png, bitCount: buffer.readUInt16LE(base + 6), data });
  }
  return { count, entries };
}

// 挑最清晰的一帧：面积最大优先，PNG 帧只在同尺寸时作为加分项（带 alpha、无需 DIB 转换）。
// 历史缺陷（2026-09-04 修）：原实现无条件 PNG 优先——混合 ICO（16px PNG + 256px BMP DIB，
// 常见于老图标工具产物）会只选中 16×16 小帧，转出的 PNG 被拉大后必然模糊（用户反馈「ico 太糊」的根因）。
function selectBestEntry(entries) {
  if (!entries.length) throw unsupported("ICO 文件不包含任何图像帧。");
  const ranked = [...entries].sort((a, b) => {
    const areaDiff = (b.width * b.height) - (a.width * a.height);
    if (areaDiff !== 0) return areaDiff;
    if (a.png !== b.png) return a.png ? -1 : 1;
    return (b.bitCount || 0) - (a.bitCount || 0);
  });
  return ranked[0];
}

// ICO 内嵌的 BMP 帧是 DIB（无 BITMAPFILEHEADER，且 biHeight = 2×实际高度，含 AND mask）。
// 补 14 字节文件头 + 高度减半，还原成 bmp-input 可解码的完整 BMP。
function dibToBmp(dib, width, height) {
  if (dib.length < 12) throw unsupported("ICO 位图文件头不完整。");
  const dibSize = dib.readUInt32LE(0);
  if (![12, 40, 52, 56, 108, 124].includes(dibSize) || dibSize > dib.length) throw unsupported("ICO 位图文件头不支持或不完整。");
  const core = dibSize === 12;
  const dibWidth = core ? dib.readUInt16LE(4) : dib.readInt32LE(4);
  const dibHeight = core ? dib.readUInt16LE(6) : dib.readInt32LE(8);
  const bitCount = dib.readUInt16LE(core ? 10 : 14);
  if (dibWidth !== width || Math.abs(dibHeight) !== height * 2
      || dib.readUInt16LE(core ? 8 : 12) !== 1) throw unsupported("ICO 位图尺寸与目录不一致。");
  if (![1, 4, 8, 24, 32].includes(bitCount) || (!core && dib.readUInt32LE(16) !== 0)) {
    throw unsupported("暂不支持此 ICO 位图编码；支持 PNG 和未压缩的 1/4/8/24/32 位图标。");
  }
  const declaredColors = core ? 0 : dib.readUInt32LE(32);
  const paletteCount = bitCount <= 8 ? (declaredColors || 2 ** bitCount) : declaredColors;
  if (paletteCount > (bitCount <= 8 ? 2 ** bitCount : 256)) throw unsupported("ICO 调色板大小不正确。");
  const sourcePixels = dibSize + paletteCount * (core ? 3 : 4);
  const rowBytes = Math.ceil(width * bitCount / 32) * 4;
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const maskOffset = sourcePixels + rowBytes * height;
  if (maskOffset + maskRowBytes * height > dib.length) throw unsupported("ICO 像素或透明蒙版不完整。");
  // Normalize CORE (three-byte palette) and INFO headers to one safe BMP layout.
  const bodyHeader = Buffer.alloc(40);
  bodyHeader.writeUInt32LE(40, 0);
  bodyHeader.writeInt32LE(width, 4);
  bodyHeader.writeInt32LE(dibHeight < 0 ? -height : height, 8);
  bodyHeader.writeUInt16LE(1, 12);
  bodyHeader.writeUInt16LE(bitCount, 14);
  bodyHeader.writeUInt32LE(paletteCount, 32);
  const palette = Buffer.alloc(paletteCount * 4);
  for (let i = 0; i < paletteCount; i++) dib.copy(palette, i * 4, dibSize + i * (core ? 3 : 4), dibSize + i * (core ? 3 : 4) + 3);
  const pixels = dib.subarray(sourcePixels, maskOffset);
  const pixelOffset = 14 + 40 + palette.length;
  const header = Buffer.alloc(14);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(pixelOffset + pixels.length, 2);
  header.writeUInt32LE(0, 6); // reserved
  header.writeUInt32LE(pixelOffset, 10);
  return {
    data: Buffer.concat([header, bodyHeader, palette, pixels]),
    andMask: Buffer.from(dib.subarray(maskOffset, maskOffset + maskRowBytes * height)),
    maskRowBytes, topDown: dibHeight < 0
  };
}

function decodedEntry(entry) {
  const { png, width, height, data } = entry;
  return png ? { png, width, height, data: Buffer.from(data) }
    : { png, width, height, ...dibToBmp(data, width, height) };
}

function decodeIcoBitmap(frame) {
  const raw = decodeBmpToRaw(frame.data);
  // Windows uses meaningful 32-bit alpha in preference to the legacy mask.
  if (raw.channels === 4) return raw;
  const data = Buffer.alloc(raw.width * raw.height * 4);
  for (let y = 0; y < raw.height; y++) for (let x = 0; x < raw.width; x++) {
    const i = y * raw.width + x;
    raw.data.copy(data, i * 4, i * 3, i * 3 + 3);
    const row = frame.topDown ? y : raw.height - 1 - y;
    const masked = frame.andMask[row * frame.maskRowBytes + (x >> 3)] & (0x80 >> (x & 7));
    data[i * 4 + 3] = masked ? 0 : 255;
  }
  return { width: raw.width, height: raw.height, channels: 4, data };
}

// 提取最佳帧。
// 返回 { png: boolean, width, height, data }：
//   - png=true 时 data 是完整 PNG 帧（可直接交给 sharp）
//   - png=false 时 data 是完整 BMP（已补文件头 + 高度减半，交给 bmp-input 解码）
function extractBestFrame(buffer) {
  const { entries } = parseIco(buffer);
  const best = selectBestEntry(entries);
  return decodedEntry(best);
}

// 提取全部帧（多尺寸 ICO 素材全集），按面积降序。
// 返回 [{ png, width, height, data }]——与 extractBestFrame 同构。
function extractAllFrames(buffer) {
  const { entries } = parseIco(buffer);
  return [...entries]
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
    .map(decodedEntry);
}

// 把多尺寸 PNG 帧组装成 ICO 容器。pngFrames: [{ size, data }]，size ∈ [1,256]。
function encodeIco(pngFrames) {
  if (!Array.isArray(pngFrames) || !pngFrames.length || pngFrames.length > 512) throw unsupported("ICO 输出帧数量不正确。");
  const frames = pngFrames;
  for (const frame of frames) {
    if (!frame || !Number.isInteger(frame.size) || frame.size < 1 || frame.size > 256 || !Buffer.isBuffer(frame.data)) throw unsupported("ICO 输出尺寸或图像数据不正确。");
    validatePng(frame.data, frame.size, frame.size);
  }
  if (frames.reduce((sum, frame) => sum + frame.data.length + 16, 6) > MAX_ICO_BYTES) throw unsupported("ICO 输出超过安全上限。");
  const count = frames.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(count, 4);
  const chunks = [dir];
  let offset = 6 + count * 16;
  frames.forEach((frame, i) => {
    const base = 6 + i * 16;
    const w = frame.size >= 256 ? 0 : frame.size;
    dir[base] = w;
    dir[base + 1] = w;
    dir[base + 2] = 0; // colorCount
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bitCount
    dir.writeUInt32LE(frame.data.length, base + 8); // bytesInRes
    dir.writeUInt32LE(offset, base + 12); // imageOffset
    chunks.push(frame.data);
    offset += frame.data.length;
  });
  return Buffer.concat(chunks);
}

module.exports = {
  isIcoBuffer,
  isIcoFileSync,
  readIcoFile,
  decodeIcoBitmap,
  parseIco,
  selectBestEntry,
  extractBestFrame,
  extractAllFrames,
  encodeIco
};
