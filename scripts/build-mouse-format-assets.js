const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const outputDir = path.join(root, "public", "assets", "mouse-format");
const sourceMouse = path.join(outputDir, "source-mouse-avatar.png");
const iconOutput = path.join(root, "build", "icon.png");

const canvas = { width: 720, height: 540 };
const mouseBox = { left: 92, top: 34, width: 405 };
const palette = {
  line: "#5a5069",
  ink: "#30283e",
  paper: "#fffafd",
  pink: "#ed8cac",
  pinkSoft: "#fde6ef",
  blueSoft: "#e4efff",
  greenSoft: "#e0f4ed",
  yellowSoft: "#fff0c7",
  lilacSoft: "#eee7ff"
};

const actions = [
  { name: "idle", prop: "spark", tint: palette.lilacSoft },
  { name: "upload", prop: "folder", tint: palette.pinkSoft },
  { name: "analyzing", prop: "magnifier", tint: palette.greenSoft },
  { name: "converting", prop: "machine", tint: palette.yellowSoft },
  { name: "pdf-pages", prop: "pages", tint: palette.blueSoft },
  { name: "ocr", prop: "txt", tint: palette.greenSoft },
  { name: "batch", prop: "cart", tint: palette.yellowSoft },
  { name: "success", prop: "check", tint: palette.pinkSoft },
  { name: "error", prop: "warning", tint: palette.blueSoft }
];

function svgFor(action) {
  return Buffer.from(`
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="none"/>
      <ellipse cx="330" cy="450" rx="238" ry="54" fill="${action.tint}" opacity="0.72"/>
      <ellipse cx="330" cy="447" rx="226" ry="43" fill="none" stroke="${palette.line}" stroke-width="7" opacity="0.9"/>
      <path d="M120 447 C118 472 139 491 183 500 M540 447 C540 472 517 492 475 500" fill="none" stroke="${palette.line}" stroke-width="7" stroke-linecap="round" opacity="0.8"/>
      ${propSvg(action.prop)}
    </svg>
  `);
}

function propSvg(prop) {
  const { line, ink, paper, pink, pinkSoft, blueSoft, yellowSoft } = palette;
  if (prop === "spark") {
    return `
      <g transform="translate(500 92)" fill="${pink}" stroke="${line}" stroke-width="6" stroke-linejoin="round">
        <path d="M47 0 L58 35 L94 46 L58 58 L47 94 L35 58 L0 46 L35 35 Z"/>
        <path d="M140 56 L148 79 L172 87 L148 95 L140 119 L132 95 L108 87 L132 79 Z" fill="${blueSoft}"/>
      </g>`;
  }
  if (prop === "folder") {
    return `
      <g transform="translate(458 128)">
        <path d="M26 0 H92 L111 24 H174 Q188 24 188 38 V154 Q188 170 172 170 H20 Q4 170 4 154 V20 Q4 0 26 0 Z" fill="${pinkSoft}" stroke="${line}" stroke-width="7" stroke-linejoin="round"/>
        <path d="M28 68 H160 M28 102 H130" stroke="${line}" stroke-width="7" stroke-linecap="round"/>
        <circle cx="154" cy="132" r="11" fill="${pink}"/>
      </g>`;
  }
  if (prop === "magnifier") {
    return `
      <g transform="translate(464 112)">
        <rect x="0" y="0" width="158" height="118" rx="18" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <path d="M28 34 H116 M28 66 H94" stroke="${line}" stroke-width="7" stroke-linecap="round"/>
        <circle cx="55" cy="138" r="38" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <circle cx="55" cy="138" r="10" fill="${pink}"/>
        <path d="M83 166 L128 211" stroke="${line}" stroke-width="9" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "machine") {
    return `
      <g transform="translate(455 122)">
        <rect x="0" y="30" width="178" height="132" rx="19" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <path d="M22 73 H134 M22 108 H104" stroke="${line}" stroke-width="7" stroke-linecap="round"/>
        <circle cx="158" cy="12" r="18" fill="${pink}" stroke="${line}" stroke-width="6"/>
        <path d="M151 30 C124 54 120 78 140 98" fill="none" stroke="${line}" stroke-width="8" stroke-linecap="round"/>
        <rect x="112" y="118" width="42" height="19" rx="9" fill="${yellowSoft}"/>
      </g>`;
  }
  if (prop === "pages") {
    return `
      <g transform="translate(454 92)">
        <rect x="34" y="34" width="126" height="164" rx="14" fill="${blueSoft}" stroke="${line}" stroke-width="7"/>
        <rect x="18" y="18" width="126" height="164" rx="14" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <rect x="2" y="2" width="126" height="164" rx="14" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <path d="M27 47 H95 M27 82 H88 M27 117 H103" stroke="${line}" stroke-width="7" stroke-linecap="round"/>
        <path d="M102 142 L139 177" stroke="${pink}" stroke-width="9" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "txt") {
    return `
      <g transform="translate(450 112)">
        <rect x="0" y="0" width="176" height="132" rx="18" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <text x="32" y="84" font-family="Bahnschrift, Arial" font-size="48" font-weight="700" fill="${ink}">TXT</text>
        <path d="M21 104 H147" stroke="${pink}" stroke-width="7" stroke-linecap="round"/>
      </g>`;
  }
  if (prop === "cart") {
    return `
      <g transform="translate(443 154)">
        <rect x="24" y="30" width="186" height="112" rx="19" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <rect x="46" y="0" width="118" height="55" rx="14" fill="${pinkSoft}" stroke="${line}" stroke-width="7"/>
        <path d="M0 22 H42" stroke="${line}" stroke-width="9" stroke-linecap="round"/>
        <circle cx="73" cy="158" r="16" fill="${blueSoft}" stroke="${line}" stroke-width="7"/>
        <circle cx="168" cy="158" r="16" fill="${blueSoft}" stroke="${line}" stroke-width="7"/>
      </g>`;
  }
  if (prop === "check") {
    return `
      <g transform="translate(470 116)">
        <rect x="0" y="0" width="150" height="150" rx="24" fill="${pinkSoft}" stroke="${line}" stroke-width="7"/>
        <path d="M39 80 L66 108 L113 44" fill="none" stroke="${pink}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
  }
  if (prop === "warning") {
    return `
      <g transform="translate(472 116)">
        <rect x="0" y="0" width="150" height="150" rx="24" fill="${paper}" stroke="${line}" stroke-width="7"/>
        <path d="M75 34 V88" stroke="${pink}" stroke-width="13" stroke-linecap="round"/>
        <circle cx="75" cy="115" r="9" fill="${pink}"/>
      </g>`;
  }
  throw new Error(`Unknown prop: ${prop}`);
}

function attireSvg() {
  return Buffer.from(`
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <g stroke="${palette.line}" stroke-linejoin="round">
        <path d="M187 318 Q294 355 414 316 L397 377 Q296 407 204 375 Z" fill="${palette.lilacSoft}" fill-opacity="0.94" stroke-width="6"/>
        <path d="M228 337 Q294 370 373 337 L357 374 Q295 395 242 374 Z" fill="${palette.blueSoft}" stroke-width="4"/>
        <path d="M272 349 C245 328 225 352 249 371 C263 381 280 369 294 356 C309 370 326 381 340 371 C364 352 344 328 317 349 L294 363 Z" fill="${palette.pink}" stroke-width="5"/>
        <circle cx="294" cy="359" r="10" fill="${palette.yellowSoft}" stroke-width="4"/>
        <path d="M394 98 C412 74 443 82 449 107 C427 108 409 117 396 133 C389 122 387 109 394 98 Z" fill="${palette.pink}" stroke-width="5"/>
        <path d="M407 104 L441 91" fill="none" stroke="${palette.paper}" stroke-width="5" stroke-linecap="round"/>
      </g>
      <g fill="${palette.paper}" opacity="0.92">
        <circle cx="221" cy="404" r="5"/>
        <circle cx="369" cy="403" r="5"/>
      </g>
    </svg>
  `);
}

async function build() {
  await fs.access(sourceMouse);
  await fs.mkdir(outputDir, { recursive: true });

  const baseMouse = await sharp(sourceMouse)
    .resize({ width: mouseBox.width, fit: "contain" })
    .png()
    .toBuffer();
  const attire = attireSvg();

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
        { input: baseMouse, left: mouseBox.left, top: mouseBox.top },
        { input: attire, left: 0, top: 0 }
      ])
      .png()
      .toFile(output);
  }

  await sharp(path.join(outputDir, "mouse-idle.png"))
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(iconOutput);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
