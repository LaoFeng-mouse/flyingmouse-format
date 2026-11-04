// 相机 RAW 原片（cr2/nef/arw/dng 等）支持回归测试
// - 纯逻辑：categoryForExt / targetsForExt 对 RAW 扩展名的分类与目标
// - 静态断言：dcraw 调用参数（sRGB）、config rawInput、capability 暴露
// - 运行时（仅当 dcraw 引擎存在）：伪 RAW 文件应报解码失败而非静默成功
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { categoryForExt, targetsForExt } = require("../utils");
const { rawInput, DCRAW_PATH, CR2_DECODER_PATH } = require("../config");
const { prepareImageInput } = require("../image");
const { convertImage } = require("../image");
const sharp = require("sharp");

const RAW_EXTS = ["cr2", "cr3", "crw", "nef", "arw", "dng", "raf", "rw2", "orf", "pef", "srw", "3fr", "erf", "fff", "iiq", "kdc", "mef", "mrw", "x3f"];

test("rawInput 白名单覆盖常见相机 RAW 扩展名", () => {
  for (const ext of RAW_EXTS) {
    assert.ok(rawInput.has(ext), `rawInput 应包含 ${ext}`);
  }
});

test("categoryForExt 把 RAW 扩展名归为 image", () => {
  for (const ext of RAW_EXTS) {
    assert.equal(categoryForExt(ext), "image", `${ext} 应为 image 类`);
  }
  assert.equal(categoryForExt("raw"), "unknown", ".raw 未在白名单，应保持 unknown");
  // normalizeExt 不归一大小写；server 调用链 extFromName 已先 toLowerCase，这里按小写断言
  assert.equal(categoryForExt("cr2"), "image", "cr2 小写应归 image");
});

test("targetsForExt 对 RAW 输入暴露图片类目标（与普通图片一致）", () => {
  const noEngines = { ffmpeg: false, ocr: false, poppler: false, libreoffice: false };
  const targets = targetsForExt("nef", noEngines);
  for (const expected of ["png", "jpg", "webp", "gif", "avif", "tiff", "pdf"]) {
    assert.ok(targets.includes(expected), `nef 应可转 ${expected}`);
  }
  assert.ok(!targets.includes("zip"), "zip 压缩目标已于 2026-09-04 移除");
  assert.ok(!targets.includes("mp4"), "无 ffmpeg 时不应暴露视频目标");
  const withEngines = targetsForExt("cr2", { ffmpeg: true, ocr: true, poppler: false, libreoffice: false });
  assert.ok(withEngines.includes("mp4") && withEngines.includes("txt"), "有 ffmpeg/ocr 时应暴露视频与 OCR 目标");
});

test("静态：image.js dcraw 调用用 sRGB（-o 1）并输出 TIFF（-T）", () => {
  const source = require("fs").readFileSync(path.join(__dirname, "..", "image.js"), "utf8");
  assert.ok(source.includes('["-T", "-o", "1"'), "dcraw 参数应为 -T -o 1（TIFF + sRGB）");
  assert.ok(!source.includes('"-o", "6"'), "不得再使用 ACES 线性（-o 6）导致偏色");
  assert.ok(source.includes("RAW 解码引擎（dcraw）不可用"), "缺少 dcraw 时应报明确错误");
});

test("静态：config.js rawInput 与实验性标注存在", () => {
  const source = require("fs").readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.ok(source.includes("rawInput"), "config 应导出 rawInput");
  assert.ok(source.includes('raw: [...rawInput]'), "RAW 应标记为实验性输入");
});

test("静态：server.js capability 按 DCRAW_PATH 暴露 RAW 输入", () => {
  const source = require("fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(source.includes("DCRAW_PATH ? rawInput"), "capability 应在有 dcraw 时暴露 raw 输入");
});

test("运行时：伪 RAW 文件经 prepareImageInput 应报解码失败（有 dcraw 才跑）", { skip: !DCRAW_PATH }, async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "raw-input-test-"));
  const mkdtemp = fsp.mkdtemp.bind(fsp);
  let preparedDirectory;
  t.mock.method(fsp, "mkdtemp", async (...args) => {
    const directory = await mkdtemp(...args);
    if (String(args[0]).includes("flyingmouse-raw-input-")) preparedDirectory = directory;
    return directory;
  });
  try {
    const fakeRaw = path.join(scratch, "fake.cr2");
    await fsp.writeFile(fakeRaw, Buffer.from("not a real RAW file, just garbage bytes for decode failure", "utf8"));
    await assert.rejects(
      prepareImageInput(fakeRaw),
      /RAW 图片解码失败|RAW 解码引擎|Command failed|Cannot decode|Cannot open|Unsupported file format|Conversion process exited/i,
      "伪 RAW 文件应明确失败"
    );
    assert.ok(preparedDirectory, "actual RAW decoder attempt was reached");
    await assert.rejects(fsp.stat(preparedDirectory), { code: "ENOENT" });
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("real EOS M100 CR2 upload decodes full-resolution pixels without legacy access violation", {
  skip: !CR2_DECODER_PATH || !process.env.FLYINGMOUSE_CR2_FAILURE_FIXTURE
}, async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "raw-m100-test-"));
  let prepared;
  try {
    const upload = path.join(scratch, "no-extension");
    const dest = path.join(scratch, "result.jpg");
    await fsp.copyFile(process.env.FLYINGMOUSE_CR2_FAILURE_FIXTURE, upload);
    // Isolate the decoder regression from live OS admission budgets. The real
    // HTTP/package matrix separately exercises admission + conversion together.
    prepared = await prepareImageInput(upload, "EOS-M100.CR2");
    await sharp(prepared.inputPath, { limitInputPixels: 64_000_000 }).jpeg().toFile(dest);
    const metadata = await sharp(dest).metadata();
    assert.ok(metadata.width >= 6000 && metadata.height >= 4000, "must decode full RAW, not a small preview");
    await sharp(dest).raw().toBuffer();
  } finally {
    if (prepared?.tempDir) await fsp.rm(prepared.tempDir, { recursive: true, force: true });
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});

// Real color-chart fixture from raw.pixls.us #1182; caller provides the CR2 and
// its camera JPEG preview. Compare chroma on four neutral patches, not overall
// JPEG byte equality (camera tone curves/demosaicing differ from dcraw).
const colorFixture = process.env.FLYINGMOUSE_CR2_COLOR_FIXTURE;
const cameraPreview = process.env.FLYINGMOUSE_CR2_CAMERA_PREVIEW;
test("real CR2 upload preserves camera white balance on neutral chart patches", {
  skip: !DCRAW_PATH || !colorFixture || !cameraPreview
}, async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "raw-color-test-"));
  try {
    const upload = path.join(scratch, "extensionless-upload");
    const output = path.join(scratch, "result.jpg");
    await fsp.copyFile(colorFixture, upload);
    await convertImage(upload, output, "jpg", { inputName: "camera.CR2" });
    async function chroma(file, x) {
      const meta = await sharp(file).metadata();
      const stats = await sharp(file).extract({
        left: Math.round(meta.width * x), top: Math.round(meta.height * 0.75),
        width: Math.round(meta.width * 0.025), height: Math.round(meta.height * 0.04)
      }).stats();
      const [r, g, b] = stats.channels.map(c => c.mean);
      return [r / g, b / g];
    }
    let difference = 0;
    for (const x of [0.3, 0.43, 0.56, 0.68]) {
      const actual = await chroma(output, x);
      const expected = await chroma(cameraPreview, x);
      difference += Math.abs(actual[0] - expected[0]) + Math.abs(actual[1] - expected[1]);
    }
    const meanChromaDifference = difference / 8;
    console.log(`RAW neutral-patch chroma difference: ${meanChromaDifference}`);
    assert.ok(meanChromaDifference < 0.035, `Neutral chroma differs from camera preview: ${meanChromaDifference}`);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});
