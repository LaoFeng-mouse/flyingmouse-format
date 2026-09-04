// 纯 JS BMP 解码器（零依赖）：把未压缩 BMP（BI_RGB）解码为 RGB raw buffer。
// sharp 0.35.3 的预编译构建不支持 BMP 输入（"Input file contains unsupported image format"），
// 而 BMP 是界面正式支持的图片输入格式，因此这里直接解码后交给 sharp 的 raw 通道继续。
const fs = require("fs");
const fsp = require("fs/promises");

function isBmpBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer.toString("latin1", 0, 2) === "BM";
}

// 只读文件头 2 字节判断是否为 BMP，避免把大图（50MP 级）整读进内存。
function isBmpFileSync(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(2);
    const read = fs.readSync(fd, header, 0, 2, 0);
    return read === 2 && header.toString("latin1") === "BM";
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function unsupported(message) {
  const error = new Error(message);
  error.code = "BMP_UNSUPPORTED_VARIANT";
  return error;
}

function decodeBmpToRaw(buffer) {
  if (!isBmpBuffer(buffer)) throw new Error("不是有效的 BMP 文件。");
  if (buffer.length < 54) throw new Error("BMP 文件头不完整。");

  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  // BITMAPCOREHEADER (12) 用 UInt16 的宽高，其它 DIB 用 Int32。
  const width = dibSize === 12 ? buffer.readUInt16LE(18) : buffer.readInt32LE(18);
  const heightRaw = dibSize === 12 ? buffer.readUInt16LE(22) : buffer.readInt32LE(22);
  const bitCount = dibSize === 12 ? buffer.readUInt16LE(24) : buffer.readUInt16LE(28);
  const compression = dibSize === 12 ? 0 : buffer.readUInt32LE(30);

  if (width <= 0 || heightRaw === 0 || width > 65535 || Math.abs(heightRaw) > 65535) {
    throw new Error(`BMP 尺寸不合法：${width}x${heightRaw}`);
  }
  if (compression !== 0) {
    throw unsupported("暂不支持压缩或特殊编码的 BMP（仅支持未压缩的 24/32 位及调色板 BMP）。");
  }
  if (![1, 4, 8, 24, 32].includes(bitCount)) {
    throw unsupported(`暂不支持 ${bitCount} 位 BMP。`);
  }

  const height = Math.abs(heightRaw);
  const topDown = heightRaw < 0;
  const rowBytes = Math.ceil((width * bitCount) / 8 / 4) * 4;
  const paletteCount = bitCount <= 8 ? (dibSize === 12 ? (bitCount === 1 ? 2 : bitCount === 4 ? 16 : 256) : 0) : 0;
  // 24/32 位无调色板；<=8 位读调色板（colorsUsed==0 时按 2^bitCount 全量）。
  let palette = [];
  let paletteEntries = 0;
  if (bitCount <= 8) {
    const maxEntries = bitCount === 1 ? 2 : bitCount === 4 ? 16 : 256;
    const declared = dibSize === 12 ? 0 : buffer.readUInt32LE(46);
    paletteEntries = declared > 0 ? Math.min(declared, maxEntries) : maxEntries;
    const paletteStart = 14 + dibSize;
    for (let index = 0; index < paletteEntries; index += 1) {
      const offset = paletteStart + index * 4;
      palette.push([buffer[offset + 2], buffer[offset + 1], buffer[offset]]); // BGR -> RGB
    }
  }

  // 32bpp 且存在非零 alpha 字节时按 BGRA 输出 4 通道（ICO 内嵌 DIB / 带透明的 BMP）；
  // 全零 alpha 的 32bpp BMP 是主流写法（alpha 未使用），保持 RGB 输出避免整图透明。
  // 扫描严格限制在每行的 width*4 像素区内：跳过行尾 padding，也绝不越过像素区
  // （ICO DIB 帧的 buffer 末尾还有 AND mask，非零 mask 位不能误触发 alpha 检测）。
  let useAlpha = false;
  if (bitCount === 32) {
    outer: for (let row = 0; row < height; row += 1) {
      const rowStart = pixelOffset + row * rowBytes;
      for (let col = 0; col < width; col += 1) {
        if (buffer[rowStart + col * 4 + 3] !== 0) {
          useAlpha = true;
          break outer;
        }
      }
    }
  }
  const channels = useAlpha ? 4 : 3;

  const required = pixelOffset + rowBytes * height;
  if (buffer.length < required) throw new Error("BMP 像素数据不完整。");

  const output = Buffer.alloc(width * height * channels);
  const pixelsPerRow = Math.ceil((width * bitCount) / 8);

  for (let row = 0; row < height; row += 1) {
    const sourceRow = topDown ? row : height - 1 - row;
    const srcStart = pixelOffset + sourceRow * rowBytes;
    const dstStart = row * width * channels;
    let srcIndex = srcStart;
    let dstIndex = dstStart;

    if (bitCount === 24) {
      for (let col = 0; col < width; col += 1) {
        output[dstIndex] = buffer[srcIndex + 2];
        output[dstIndex + 1] = buffer[srcIndex + 1];
        output[dstIndex + 2] = buffer[srcIndex];
        srcIndex += 3;
        dstIndex += 3;
      }
    } else if (bitCount === 32) {
      for (let col = 0; col < width; col += 1) {
        output[dstIndex] = buffer[srcIndex + 2];
        output[dstIndex + 1] = buffer[srcIndex + 1];
        output[dstIndex + 2] = buffer[srcIndex];
        if (useAlpha) output[dstIndex + 3] = buffer[srcIndex + 3];
        srcIndex += 4;
        dstIndex += channels;
      }
    } else if (bitCount === 8) {
      for (let col = 0; col < width; col += 1) {
        const entry = palette[buffer[srcIndex]] || [0, 0, 0];
        output[dstIndex] = entry[0];
        output[dstIndex + 1] = entry[1];
        output[dstIndex + 2] = entry[2];
        srcIndex += 1;
        dstIndex += 3;
      }
    } else if (bitCount === 4) {
      for (let col = 0; col < width; col += 1) {
        const byte = buffer[srcIndex + Math.floor(col / 2)];
        const index = col % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
        const entry = palette[index] || [0, 0, 0];
        output[dstIndex] = entry[0];
        output[dstIndex + 1] = entry[1];
        output[dstIndex + 2] = entry[2];
        dstIndex += 3;
      }
    } else {
      for (let col = 0; col < width; col += 1) {
        const byte = buffer[srcIndex + Math.floor(col / 8)];
        const bit = (byte >> (7 - (col % 8))) & 0x01;
        const entry = palette[bit] || [0, 0, 0];
        output[dstIndex] = entry[0];
        output[dstIndex + 1] = entry[1];
        output[dstIndex + 2] = entry[2];
        dstIndex += 3;
      }
    }
  }

  return { width, height, channels, data: output };
}

async function readBmpAsRaw(inputPath) {
  return decodeBmpToRaw(await fsp.readFile(inputPath));
}

function readBmpAsRawSync(inputPath) {
  return decodeBmpToRaw(fs.readFileSync(inputPath));
}

module.exports = { isBmpBuffer, isBmpFileSync, decodeBmpToRaw, readBmpAsRaw, readBmpAsRawSync };
