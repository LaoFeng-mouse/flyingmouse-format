// 生成 Mahiro 主题 Microsoft Store APPX logo。
// 源：build/icon.png（512x512 Mahiro 头像，已通过 mahiro-assets.test.js 视觉回归）
// 用法：node scripts/gen-appx-logos.js
// 输出：build/appx/Square44x44Logo.png / Square150x150Logo.png / StoreLogo.png / Wide310x150Logo.png
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const OUT_DIR = path.join(ROOT, 'build', 'appx');

const SIZES = [
  { name: 'Square44x44Logo.png', w: 44, h: 44 },
  { name: 'Square150x150Logo.png', w: 150, h: 150 },
  { name: 'StoreLogo.png', w: 50, h: 50 },
  { name: 'Wide310x150Logo.png', w: 310, h: 150 }, // 宽 logo：方形 Mahiro 头像居中，左右透明
];

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`missing source icon: ${SRC}`);
  const meta = await sharp(SRC).metadata();
  if (meta.width !== 512 || meta.height !== 512) {
    throw new Error(`source icon must be 512x512, got ${meta.width}x${meta.height}`);
  }

  for (const { name, w, h } of SIZES) {
    const out = path.join(OUT_DIR, name);
    if (name === 'Wide310x150Logo.png') {
      // 310x150 透明画布，150x150 Mahiro 头像居中（left=(310-150)/2=80, top=0）
      const iconBuf = await sharp(SRC).resize(150, 150).png().toBuffer();
      await sharp({
        create: { width: 310, height: 150, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: iconBuf, left: 80, top: 0 }])
        .png()
        .toFile(out);
    } else {
      await sharp(SRC).resize(w, h).png().toFile(out);
    }
    const outMeta = await sharp(out).metadata();
    console.log(`OK ${name} -> ${outMeta.width}x${outMeta.height} (${fs.statSync(out).size} bytes)`);
  }
  console.log('DONE: 4 appx logos regenerated from Mahiro icon');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
