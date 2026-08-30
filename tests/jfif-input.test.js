const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");

const { convertImage } = require("../image");
const { imageInput } = require("../config");
const { categoryForExt, targetsForExt } = require("../utils");

// JFIF（JPEG File Interchange Format）是 JPEG 最常见的容器：内容就是标准 JPEG 数据。
// 这里用 sharp 生成 JPEG 像素，只把扩展名写成 .jfif，模拟真实 JFIF 文件。
function makeJfif(width, height) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 60 }
    }
  })
    .jpeg()
    .toBuffer();
}

test("jfif 已在 imageInput 白名单", () => {
  assert.equal(imageInput.has("jfif"), true);
});

test("JFIF 文件被归为 image 类并暴露完整图片目标集", () => {
  assert.equal(categoryForExt("jfif"), "image");
  const targets = targetsForExt("jfif", { ffmpeg: true, libreoffice: true, poppler: true, ocr: true });
  assert.ok(targets.includes("png"));
  assert.ok(targets.includes("jpg"));
  assert.ok(targets.includes("webp"));
  assert.ok(targets.includes("pdf"));
  assert.ok(targets.includes("ico"));
  assert.ok(targets.includes("zip"));
});

test(".jfif 图片可直接转换为 PNG（走 sharp 解码）", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-jfif-png-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const jfifPath = path.join(scratch, "test.jfif");
  const outPng = path.join(scratch, "out.png");
  fs.writeFileSync(jfifPath, await makeJfif(16, 16));

  const result = await convertImage(jfifPath, outPng, "png");
  assert.deepEqual(result.warnings, []);
  const meta = await sharp(outPng).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 16);
  assert.equal(meta.height, 16);
});
