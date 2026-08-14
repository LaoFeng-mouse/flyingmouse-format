const assert = require("node:assert/strict");
const { test } = require("node:test");

const { videoEncoderArgs } = require("../media");

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
