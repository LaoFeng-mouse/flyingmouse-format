// ico-format.js — ICO（Windows 图标）容器读写（零依赖，纯 Buffer 操作）。
// 背景：sharp 的预编译构建（libvips 8.18.3）不支持 ICO 输入/输出（sharp.format 无 ico），
// 而 ICO 本质是「容器」：ICONDIR + N 个 ICONDIRENTRY + 各帧数据（PNG 或 BMP DIB）。
// 本模块只做容器解析/组装，像素解码交给 sharp（PNG 帧）或 bmp-input（BMP DIB 帧）。
//
// 读：extractBestFrame 挑最大/最清晰帧——PNG 帧（现代 ICO，256×256 常为 PNG，带 alpha）优先，
//     兜底 BMP DIB 帧（老式 ICO，补 BITMAPFILEHEADER + 高度减半去除 AND mask 后交给 bmp-input）。
// 写：encodeIco 把多尺寸 PNG 帧（16/24/32/48/64/128/256）组装成 ICO 容器（PNG 帧内嵌，Vista+ 支持）。

const fs = require("fs");

const PNG_MAGIC = 0x89504e47; // \x89PNG

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

// 解析 ICO 目录，返回 { count, entries }。
// entry: { width, height, bytes, offset, png, data }
function parseIco(buffer) {
  if (!isIcoBuffer(buffer)) throw new Error("不是有效的 ICO 文件。");
  const count = buffer.readUInt16LE(4);
  if (count < 1 || count > 512) throw unsupported("ICO 图像帧数量异常。");
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    if (base + 16 > buffer.length) throw unsupported("ICO 目录项不完整。");
    const width = buffer[base] === 0 ? 256 : buffer[base];
    const height = buffer[base + 1] === 0 ? 256 : buffer[base + 1];
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (offset + bytes > buffer.length) throw unsupported("ICO 图像数据越界。");
    const data = buffer.subarray(offset, offset + bytes);
    const png = data.length >= 8 && data.readUInt32BE(0) === PNG_MAGIC;
    entries.push({ width, height, bytes, offset, png, data });
  }
  return { count, entries };
}

// 挑最清晰的一帧：PNG 帧优先（带 alpha），再按面积降序。
function selectBestEntry(entries) {
  if (!entries.length) throw unsupported("ICO 文件不包含任何图像帧。");
  const ranked = [...entries].sort((a, b) => {
    if (a.png !== b.png) return a.png ? -1 : 1;
    return (b.width * b.height) - (a.width * a.height);
  });
  return ranked[0];
}

// ICO 内嵌的 BMP 帧是 DIB（无 BITMAPFILEHEADER，且 biHeight = 2×实际高度，含 AND mask）。
// 补 14 字节文件头 + 高度减半，还原成 bmp-input 可解码的完整 BMP。
function dibToBmp(dib) {
  const dibSize = dib.readUInt32LE(0);
  const body = Buffer.from(dib);
  if (dibSize >= 40) {
    const biHeight = body.readInt32LE(8);
    if (Math.abs(biHeight) >= 2) body.writeInt32LE(Math.trunc(biHeight / 2), 8);
  } else if (dibSize === 12) {
    const biHeight = body.readUInt16LE(6);
    if (biHeight >= 2) body.writeUInt16LE(Math.trunc(biHeight / 2), 6);
  }
  const bitCount = dibSize === 12 ? body.readUInt16LE(10) : body.readUInt16LE(14);
  let paletteBytes = 0;
  if (bitCount <= 8) {
    const paletteCount = bitCount === 1 ? 2 : bitCount === 4 ? 16 : 256;
    paletteBytes = paletteCount * 4;
  }
  const pixelOffset = 14 + dibSize + paletteBytes;
  const header = Buffer.alloc(14);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(14 + body.length, 2);
  header.writeUInt32LE(0, 6); // reserved
  header.writeUInt32LE(pixelOffset, 10);
  return Buffer.concat([header, body]);
}

// 提取最佳帧。
// 返回 { png: boolean, width, height, data }：
//   - png=true 时 data 是完整 PNG 帧（可直接交给 sharp）
//   - png=false 时 data 是完整 BMP（已补文件头 + 高度减半，交给 bmp-input 解码）
function extractBestFrame(buffer) {
  const { entries } = parseIco(buffer);
  const best = selectBestEntry(entries);
  if (best.png) {
    return { png: true, width: best.width, height: best.height, data: Buffer.from(best.data) };
  }
  return { png: false, width: best.width, height: best.height, data: dibToBmp(best.data) };
}

// 提取全部帧（多尺寸 ICO 素材全集），按面积降序。
// 返回 [{ png, width, height, data }]——与 extractBestFrame 同构。
function extractAllFrames(buffer) {
  const { entries } = parseIco(buffer);
  return [...entries]
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
    .map((entry) => ({
      png: entry.png,
      width: entry.width,
      height: entry.height,
      data: entry.png ? Buffer.from(entry.data) : dibToBmp(entry.data)
    }));
}

// 把多尺寸 PNG 帧组装成 ICO 容器。pngFrames: [{ size, data }]，size ∈ [1,256]。
function encodeIco(pngFrames) {
  const frames = pngFrames.filter((f) => f && Buffer.isBuffer(f.data) && f.data.length > 0);
  if (!frames.length) throw new Error("没有可写入 ICO 的 PNG 帧。");
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
  parseIco,
  selectBestEntry,
  extractBestFrame,
  extractAllFrames,
  encodeIco
};
