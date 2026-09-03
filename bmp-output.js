// 纯 JS BMP 编码器（零依赖）：把 RGB(A) raw buffer 编码为未压缩 24 位 BMP（BI_RGB）。
// sharp 0.35.3 的预编译构建不支持 BMP 输出（sharp.format 无 bmp、magick 输出也不可用），
// 而 BMP 是界面正式支持的图片格式——输入侧已有 bmp-input.js 解码，这里补齐输出侧。
// 24 位无压缩 BMP 是兼容性最好的子集：所有 Windows/WPS/浏览器都能打开。
function encodeBmpFromRaw({ width, height, data, channels = 3 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw new Error(`BMP 尺寸不合法：${width}x${height}`);
  }
  if (width * height * channels > data.length) {
    throw new Error("像素数据不完整，无法编码 BMP。");
  }

  // BMP 行必须 4 字节对齐；像素自底向上存储（heightRaw 为正）。
  const rowBytes = Math.ceil((width * 24) / 8 / 4) * 4;
  const paddingBytes = rowBytes - width * 3;
  const pixelOffset = 14 + 40; // 文件头 14 + BITMAPINFOHEADER 40
  const fileSize = pixelOffset + rowBytes * height;

  const out = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(0, 6); // reserved
  out.writeUInt32LE(pixelOffset, 10);

  // BITMAPINFOHEADER（40 字节）
  out.writeUInt32LE(40, 14); // biSize
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // 正数 = 自底向上
  out.writeUInt16LE(1, 26); // biPlanes
  out.writeUInt16LE(24, 28); // biBitCount
  out.writeUInt32LE(0, 30); // BI_RGB（未压缩）
  out.writeUInt32LE(rowBytes * height, 34); // biSizeImage
  out.writeInt32LE(2835, 38); // biXPelsPerMeter（72 DPI）
  out.writeInt32LE(2835, 42); // biYPelsPerMeter
  out.writeUInt32LE(0, 46); // biClrUsed
  out.writeUInt32LE(0, 50); // biClrImportant

  // 像素：BGR 顺序，自底向上，行尾补零对齐。带 alpha 通道的输入丢弃 alpha
  //（与 JPEG 目标的白色合成不同：BMP 24 位丢 alpha 是无损约定，主流查看器都这么处理）。
  for (let row = 0; row < height; row += 1) {
    const sourceRow = height - 1 - row; // 自底向上翻转
    const dstStart = pixelOffset + row * rowBytes;
    let srcIndex = sourceRow * width * channels;
    let dstIndex = dstStart;
    for (let col = 0; col < width; col += 1) {
      out[dstIndex] = data[srcIndex + 2]; // B
      out[dstIndex + 1] = data[srcIndex + 1]; // G
      out[dstIndex + 2] = data[srcIndex]; // R
      srcIndex += channels;
      dstIndex += 3;
    }
    // padding 已由 Buffer.alloc 置零
  }

  return out;
}

module.exports = { encodeBmpFromRaw };
