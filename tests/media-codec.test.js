const assert = require("node:assert/strict");
const { test } = require("node:test");

const { videoEncoderArgs, alphaCompositeArgs } = require("../media");

test("videoEncoderArgs 默认与 h264 → libx264 crf23", () => {
  const expected = ["-codec:v", "libx264", "-preset", "medium", "-crf", "23"];
  assert.deepEqual(videoEncoderArgs(undefined), expected);
  assert.deepEqual(videoEncoderArgs("h264"), expected);
});

test("videoEncoderArgs h265/hevc → libx265 crf28", () => {
  const expected = ["-codec:v", "libx265", "-preset", "medium", "-crf", "28"];
  assert.deepEqual(videoEncoderArgs("h265"), expected);
  assert.deepEqual(videoEncoderArgs("hevc"), expected);
});

test("videoEncoderArgs av1 → libsvtav1 preset8 crf32", () => {
  assert.deepEqual(videoEncoderArgs("av1"), ["-codec:v", "libsvtav1", "-preset", "8", "-crf", "32"]);
});

test("videoEncoderArgs 未知编码回退 h264", () => {
  const expected = ["-codec:v", "libx264", "-preset", "medium", "-crf", "23"];
  assert.deepEqual(videoEncoderArgs("vp9"), expected);
  assert.deepEqual(videoEncoderArgs(""), expected);
});

test("alphaCompositeArgs 对无 alpha 视频返回 null", () => {
  assert.equal(alphaCompositeArgs(null), null);
  assert.equal(alphaCompositeArgs({ hasAlpha: false, width: 640, height: 480, fps: 30 }), null);
});

test("alphaCompositeArgs 对带 alpha 视频生成白底合成参数", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 1466, height: 1080, fps: 30 });
  assert.ok(result);
  assert.deepEqual(result.inputs, ["-f", "lavfi", "-i", "color=white:s=1466x1080:r=30"]);
  assert.match(result.filterComplex, /overlay=shortest=1/);
  assert.match(result.filterComplex, /\[1:v\]\[0:v\]/);
  assert.equal(result.videoLabel, "alphaout");
});

test("alphaCompositeArgs 对未知宽高用兜底尺寸", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 0, height: 0, fps: 0 });
  assert.ok(result);
  assert.match(result.inputs[3], /s=1280x720:r=30/);
});

test("alphaCompositeArgs 支持自定义背景色（black/hex/颜色名）", () => {
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "black").inputs[3], /color=black:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "0x00ff00").inputs[3], /color=0x00ff00:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "#ff00ff").inputs[3], /color=#ff00ff:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "red").inputs[3], /color=red:/);
});

test("alphaCompositeArgs 对非法背景色回退 white（防注入）", () => {
  const result = alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "white:s=1;evil");
  assert.match(result.inputs[3], /color=white:/);
  assert.match(alphaCompositeArgs({ hasAlpha: true, width: 64, height: 32, fps: 25 }, "").inputs[3], /color=white:/);
});
