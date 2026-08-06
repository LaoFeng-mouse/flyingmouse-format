const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const sourceMouse = "D:\\鼠鼠打印\\assets\\mouse_avatar.png";
const outputDir = path.join(root, "public", "assets", "mouse-format");

const canvas = { width: 720, height: 540 };
const mouseBox = { left: 92, top: 34, width: 405 };

const actions = [
  { name: "idle", prop: "spark", tint: "#fffdf8" },
  { name: "upload", prop: "folder", tint: "#ffe0e4" },
  { name: "analyzing", prop: "magnifier", tint: "#dff5ee" },
  { name: "converting", prop: "machine", tint: "#fff2bc" },
  { name: "pdf-pages", prop: "pages", tint: "#dcecff" },
  { name: "ocr", prop: "txt", tint: "#dff5ee" },
  { name: "batch", prop: "cart", tint: "#fff2bc" },
  { name: "success", prop: "check", tint: "#ffe0e4" },
  { name: "error", prop: "warning", tint: "#dcecff" }
];

function svgFor(action) {
  return Buffer.from(`
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="none"/>
      <g opacity="0.95">
        <path d="M93 444 C146 511 501 514 575 443" fill="${action.tint}" stroke="#111111" stroke-width="11" stroke-linecap="round"/>
        <path d="M119 445 C111 473 134 497 184 505" fill="none" stroke="#111111" stroke-width="9" stroke-linecap="round"/>
        <path d="M525 444 C538 472 519 497 472 505" fill="none" stroke="#111111" stroke-width="9" stroke-linecap="round"/>
      </g>
      ${propSvg(action.prop)}
    </svg>
  `);
}

function propSvg(prop) {
  if (prop === "spark") {
    return `
      <g transform="translate(500 96)" fill="#e95f6d" stroke="#111111" stroke-width="7" stroke-linejoin="round">
        <path d="M47 0 L58 35 L94 46 L58 58 L47 94 L35 58 L0 46 L35 35 Z"/>
        <path d="M140 56 L148 79 L172 87 L148 95 L140 119 L132 95 L108 87 L132 79 Z"/>
      </g>`;
  }
  if (prop === "folder") {
    return `
      <g transform="translate(458 128)">
        <path d="M26 0 H92 L111 24 H174 Q188 24 188 38 V154 Q188 170 172 170 H20 Q4 170 4 154 V20 Q4 0 26 0 Z" fill="#ffe0e4" stroke="#111111" stroke-width="9" stroke-linejoin="round"/>
        <path d="M28 68 H160 M28 102 H130" stroke="#111111" stroke-width="8" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "magnifier") {
    return `
      <g transform="translate(464 112)">
        <rect x="0" y="0" width="158" height="118" rx="16" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <path d="M28 34 H116 M28 66 H94" stroke="#111111" stroke-width="8" stroke-linecap="round"/>
        <circle cx="55" cy="138" r="38" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <circle cx="55" cy="138" r="10" fill="#e95f6d"/>
        <path d="M83 166 L128 211" stroke="#111111" stroke-width="11" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "machine") {
    return `
      <g transform="translate(455 122)">
        <rect x="0" y="30" width="178" height="132" rx="17" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <path d="M22 73 H134 M22 108 H104" stroke="#111111" stroke-width="8" stroke-linecap="round"/>
        <circle cx="158" cy="12" r="18" fill="#e95f6d" stroke="#111111" stroke-width="7"/>
        <path d="M151 30 C124 54 120 78 140 98" fill="none" stroke="#111111" stroke-width="9" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "pages") {
    return `
      <g transform="translate(454 92)">
        <rect x="34" y="34" width="126" height="164" rx="12" fill="#ffffff" stroke="#111111" stroke-width="8"/>
        <rect x="18" y="18" width="126" height="164" rx="12" fill="#ffffff" stroke="#111111" stroke-width="8"/>
        <rect x="2" y="2" width="126" height="164" rx="12" fill="#ffffff" stroke="#111111" stroke-width="8"/>
        <path d="M27 47 H95 M27 82 H88 M27 117 H103" stroke="#111111" stroke-width="8" stroke-linecap="round"/>
        <path d="M102 142 L139 177" stroke="#e95f6d" stroke-width="10" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "txt") {
    return `
      <g transform="translate(450 112)">
        <rect x="0" y="0" width="176" height="132" rx="16" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <text x="32" y="84" font-family="Arial" font-size="48" font-weight="900" fill="#111111">TXT</text>
        <path d="M21 104 H147" stroke="#e95f6d" stroke-width="8" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "cart") {
    return `
      <g transform="translate(443 154)">
        <rect x="24" y="30" width="186" height="112" rx="17" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <rect x="46" y="0" width="118" height="55" rx="12" fill="#ffe0e4" stroke="#111111" stroke-width="8"/>
        <path d="M0 22 H42" stroke="#111111" stroke-width="10" stroke-linecap="round"/>
        <circle cx="73" cy="158" r="16" fill="#ffffff" stroke="#111111" stroke-width="8"/>
        <circle cx="168" cy="158" r="16" fill="#ffffff" stroke="#111111" stroke-width="8"/>
      </g>`;
  }
  if (prop === "check") {
    return `
      <g transform="translate(470 116)">
        <rect x="0" y="0" width="150" height="150" rx="18" fill="#ffe0e4" stroke="#111111" stroke-width="9"/>
        <path d="M39 80 L66 108 L113 44" fill="none" stroke="#e95f6d" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
  }
  if (prop === "warning") {
    return `
      <g transform="translate(472 116)">
        <rect x="0" y="0" width="150" height="150" rx="18" fill="#ffffff" stroke="#111111" stroke-width="9"/>
        <path d="M75 34 V88" stroke="#e95f6d" stroke-width="14" stroke-linecap="round"/>
        <circle cx="75" cy="115" r="9" fill="#e95f6d"/>
      </g>`;
  }
  throw new Error(`Unknown prop: ${prop}`);
}

async function build() {
  await fs.access(sourceMouse);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.copyFile(sourceMouse, path.join(outputDir, "source-mouse-avatar.png"));

  const baseMouse = await sharp(sourceMouse)
    .resize({ width: mouseBox.width, fit: "contain" })
    .png()
    .toBuffer();

  for (const action of actions) {
    const output = path.join(outputDir, `mouse-${action.name}.png`);
    await sharp({
      create: {
        width: canvas.width,
        height: canvas.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        { input: svgFor(action), left: 0, top: 0 },
        { input: baseMouse, left: mouseBox.left, top: mouseBox.top }
      ])
      .png()
      .toFile(output);
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
