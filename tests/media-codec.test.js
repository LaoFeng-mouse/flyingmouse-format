const assert = require("node:assert/strict");
const { test } = require("node:test");

const { videoEncoderArgs, alphaCompositeArgs } = require("../media");
const { createMediaProgressObserver, convertMedia } = require("../media");

test("camera transport-stream extensions expose video targets only when FFmpeg is available", () => {
  const { categoryForExt, targetsForExt } = require("../utils");
  const { mediaTargets } = require("../config");
  for (const extension of ["mts", "m2ts", "ts", "mst"]) {
    assert.equal(categoryForExt(extension), "video", extension);
    assert.deepEqual(targetsForExt(extension, { ffmpeg: true }), mediaTargets, extension);
    assert.deepEqual(targetsForExt(extension, { ffmpeg: false }), [], extension);
  }
});

test("transport-stream packet gate rejects installer/text data and accepts 188/192/204-byte packets", () => {
  const { hasTransportStreamPackets } = require("../media");
  assert.equal(hasTransportStreamPackets(Buffer.from("export const video = false;")), false);
  assert.equal(hasTransportStreamPackets(Buffer.from("d0cf11e0a1b11ae1", "hex")), false);
  for (const packetSize of [188, 192, 204]) {
    const bytes = Buffer.alloc(packetSize * 6);
    const prefix = packetSize === 192 ? 4 : 0;
    for (let i = 0; i < 6; i++) { bytes[i * packetSize + prefix] = 0x47; bytes[i * packetSize + prefix + 3] = 0x10; }
    assert.equal(hasTransportStreamPackets(bytes), true, String(packetSize));
    bytes[packetSize * 2 + prefix] = 0;
    assert.equal(hasTransportStreamPackets(bytes), false, "damaged repeated sync is insufficient");
  }
});

test("media information probes honor cancellation before starting FFmpeg", async () => {
  const signal = AbortSignal.abort();
  const { probeAudioTrack, probeVideoInfo } = require("../media");
  await assert.rejects(probeAudioTrack("unused.mp4", { signal }), { code: "CONVERSION_CANCELED" });
  await assert.rejects(probeVideoInfo("unused.mp4", { signal }), { code: "CONVERSION_CANCELED" });
});

test("real camera streams convert with audio/silence and content-gate mislabeled MST files", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { FFMPEG_PATH } = require("../config");
  const { run, commandExists } = require("../utils");
  if (!(await commandExists(FFMPEG_PATH))) return t.skip("real FFmpeg is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-transport-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "相机 有声音.mts");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=12:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "ac3", "-ac", "6", "-f", "mpegts", "-mpegts_m2ts_mode", "1", source]);
  // Uploaded files have no extension; inputExt must reach the converter.
  const uploaded = path.join(root, "upload-without-extension");
  await fs.copyFile(source, uploaded);
  for (const inputExt of ["mts", "m2ts", "ts", "mst"]) {
    const output = path.join(root, `${inputExt}.mp4`);
    const result = await convertMedia(uploaded, output, "mp4", "video", { inputExt });
    await run(FFMPEG_PATH, ["-v", "error", "-xerror", "-err_detect", "explode", "-i", output, "-map", "0:v", "-map", "0:a", "-f", "null", "-"]);
    assert.equal(result.warnings.some(warning => warning.code === "MEDIA_MST_TRANSPORT_STREAM"), inputExt === "mst");
  }
  for (const target of ["webm", "ogg", "opus", "mp3", "wma"]) {
    const output = path.join(root, `surround.${target}`);
    const result = await convertMedia(source, output, target, "video");
    await run(FFMPEG_PATH, ["-v", "error", "-xerror", "-err_detect", "explode", "-i", output, "-map", "0", "-f", "null", "-"]);
    const code = ["mp3", "wma"].includes(target) ? "MEDIA_AUDIO_DOWNMIXED" : "MEDIA_SURROUND_LAYOUT_ADAPTED";
    assert.ok(result.warnings.some(warning => warning.code === code), target);
  }
  const silent = path.join(root, "silent.ts");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", source, "-an", "-c:v", "copy", "-f", "mpegts", silent]);
  await convertMedia(silent, path.join(root, "silent.webm"), "webm", "video");
  await assert.rejects(convertMedia(silent, path.join(root, "silent.mp3"), "mp3", "video"), { code: "MEDIA_NO_AUDIO_TRACK" });
  const fake = path.join(root, "installer.mst");
  await fs.writeFile(fake, Buffer.from("d0cf11e0a1b11ae1", "hex"));
  await assert.rejects(convertMedia(fake, path.join(root, "fake.mp4"), "mp4", "video"), { code: "MEDIA_MST_NOT_VIDEO" });
  const audio = path.join(root, "audio-only.mst");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", source, "-vn", "-c:a", "copy", "-f", "mpegts", audio]);
  await assert.rejects(convertMedia(audio, path.join(root, "audio.mp4"), "mp4", "video"), { code: "MEDIA_MST_NOT_VIDEO" });
  const disguised = path.join(root, "not-transport.mst");
  await fs.copyFile(path.join(root, "mts.mp4"), disguised);
  await assert.rejects(convertMedia(disguised, path.join(root, "not-transport.mp4"), "mp4", "video"), { code: "MEDIA_MST_NOT_VIDEO" });
  const multi = path.join(root, "two-audio.ts");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", source, "-map", "0:v", "-map", "0:a", "-map", "0:a",
    "-c:v", "copy", "-c:a", "ac3", "-ac:a:0", "2", "-ac:a:1", "6", "-f", "mpegts", multi]);
  for (const target of ["opus", "wma"]) {
    const output = path.join(root, `selected-first.${target}`);
    const result = await convertMedia(multi, output, target, "video");
    assert.equal(result.audioChannels, 2);
    assert.ok(result.warnings.some(warning => warning.code === "MEDIA_PRIMARY_STREAMS_SELECTED"));
    assert.ok(!result.warnings.some(warning => ["MEDIA_SURROUND_LAYOUT_ADAPTED", "MEDIA_AUDIO_DOWNMIXED"].includes(warning.code)));
    await run(FFMPEG_PATH, ["-v", "error", "-xerror", "-err_detect", "explode", "-i", output, "-f", "null", "-"]);
  }
  const anamorphic = path.join(root, "non-square-pixels.ts");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", source, "-vf", "setsar=4/3", "-an", "-c:v", "libx264", "-f", "mpegts", anamorphic]);
  const gif = path.join(root, "square-pixels.gif");
  await convertMedia(anamorphic, gif, "gif", "video");
  const info = await require("../media").probeVideoInfo(gif);
  assert.equal(info.width, 128);
  assert.equal(info.height, 64);
});

test("transparent video after an audio stream keeps the selected background and audio", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const sharp = require("sharp");
  const { FFMPEG_PATH } = require("../config");
  const { run, commandExists } = require("../utils");
  const { probeVideoInfo, probeAudioTrack } = require("../media");
  if (!(await commandExists(FFMPEG_PATH))) return t.skip("real FFmpeg is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-alpha-stream-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "音频在前的透明视频.mov");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=black@0:s=64x48:r=5:d=0.4,format=argb",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-map", "1:a", "-map", "0:v",
    "-c:v", "qtrle", "-c:a", "pcm_s16le", "-shortest", input]);
  assert.deepEqual(await probeVideoInfo(input), { hasAlpha: true, width: 64, height: 48, fps: 5 });
  for (const background of ["white", "black"]) {
    const output = path.join(root, `${background}.mp4`);
    await convertMedia(input, output, "mp4", "video", { alphaBackground: background });
    assert.equal(await probeAudioTrack(output), true, "transparent compositing must retain audio");
    await run(FFMPEG_PATH, ["-v", "error", "-xerror", "-err_detect", "explode", "-i", output, "-map", "0:v", "-map", "0:a", "-f", "null", "-"]);
    const frame = path.join(root, `${background}.png`);
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", output, "-frames:v", "1", frame]);
    const { data, info } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 64);
    assert.equal(info.height, 48);
    const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
    assert.ok(background === "white" ? mean > 245 : mean < 10, `${background}: actual RGB mean ${mean}`);
  }
});

test("ordinary surround media converts to Opus without losing channels or switching tracks", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const { FFMPEG_PATH } = require("../config");
  const { run, commandExists } = require("../utils");
  if (!(await commandExists(FFMPEG_PATH))) return t.skip("real FFmpeg is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-ordinary-surround-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "普通环绕声.mkv");
  const frequencies = [220, 330, 440, 55, 550, 660];
  const tones = frequencies.map(frequency => `0.2*sin(2*PI*${frequency}*t)`).join("|");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=red:s=64x48:r=5:d=0.4",
    "-f", "lavfi", "-i", `aevalsrc=${tones}:s=48000:d=0.4:c=5.1(side)`, "-t", "0.4", "-c:v", "libx264", "-c:a", "ac3", input]);
  for (const target of ["webm", "opus", "ogg"]) {
    const output = path.join(root, `six-channels.${target}`);
    const result = await convertMedia(input, output, target, "video");
    assert.ok(result.warnings.some(warning => warning.code === "MEDIA_SURROUND_LAYOUT_ADAPTED"), target);
    const decoded = await run(FFMPEG_PATH, ["-hide_banner", "-xerror", "-err_detect", "explode", "-i", output, "-map", "0", "-f", "null", "-"]);
    assert.match(decoded.stderr, /Audio: opus[^\r\n]*, 5\.1,/);
    // Each channel carries a distinct real tone. Checking decoded PCM catches
    // silent channels and accidental channel swaps that a layout label cannot.
    const pcm = spawnSync(FFMPEG_PATH, ["-v", "error", "-i", output, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(pcm.status, 0, pcm.stderr.toString());
    const frames = Math.floor(pcm.stdout.length / 12);
    const start = 2400, end = frames - 2400;
    assert.ok(end > start + 4800);
    for (let channel = 0; channel < 6; channel++) {
      let crossings = 0;
      for (let frame = start + 1; frame < end; frame++) {
        if (pcm.stdout.readInt16LE((frame - 1) * 12 + channel * 2) <= 0 && pcm.stdout.readInt16LE(frame * 12 + channel * 2) > 0) crossings++;
      }
      const actual = crossings * 48000 / (end - start);
      assert.ok(Math.abs(actual - frequencies[channel]) < 12, `${target}, channel ${channel}: expected ${frequencies[channel]} Hz, decoded ${actual} Hz`);
    }
  }
  const multi = path.join(root, "first-stereo-second-surround.mkv");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-i", input, "-map", "0:v", "-map", "0:a", "-map", "0:a",
    "-c:v", "copy", "-c:a", "ac3", "-ac:a:0", "2", "-ac:a:1", "6", multi]);
  const output = path.join(root, "selected-first.opus");
  const result = await convertMedia(multi, output, "opus", "video");
  assert.equal(result.audioChannels, 2);
  assert.ok(result.warnings.some(warning => warning.code === "MEDIA_PRIMARY_STREAMS_SELECTED"));
  assert.ok(!result.warnings.some(warning => warning.code === "MEDIA_SURROUND_LAYOUT_ADAPTED"));
  const decoded = await run(FFMPEG_PATH, ["-hide_banner", "-xerror", "-err_detect", "explode", "-i", output, "-f", "null", "-"]);
  assert.match(decoded.stderr, /Audio: opus[^\r\n]*, stereo,/);
});

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

test("FFmpeg progress parses chunked microseconds and actual input duration, never out_time_ms", () => {
  const events = [];
  const observer = createMediaProgressObserver(event => events.push(event));
  observer.onStderr(Buffer.from("Input #0, wav, from 'private.wav':\n  Dura"));
  observer.onStderr(Buffer.from("tion: 00:00:06.50, bitrate: 123 kb/s\n"));
  observer.onStdout(Buffer.from("out_time_ms=99000000\nout_ti"));
  observer.onStdout(Buffer.from("me_us=1500000\nprogress=continue\n"));
  assert.deepEqual(events.at(-1), { stage: "converting", completed: 1.5, total: 6.5, unit: "seconds" });
  const count = events.length;
  observer.onStdout(Buffer.from("out_time_us=-1\nout_time_us=500000\n"));
  assert.equal(events.length, count);
  observer.close();
  observer.onStdout(Buffer.from("out_time_us=3000000\n"));
  assert.equal(events.length, count, "closed observer cannot report late events");
});

test("unknown and multiple-input durations remain unknown while actual processed seconds advance", () => {
  for (const options of [{}, { allowDuration: false }]) {
    const events = [];
    const observer = createMediaProgressObserver(event => events.push(event), options);
    observer.onStderr(Buffer.from(options.allowDuration === false
      ? "Input #0, wav:\n Duration: 00:00:06.00, bitrate: 123\n"
      : "Input #0, wav:\n Duration: N/A, bitrate: 123\n"));
    observer.onStdout(Buffer.from("out_time_us=1200000\n"));
    assert.deepEqual(events.at(-1), { stage: "converting", completed: 1.2, total: null, unit: "seconds" });
    observer.close();
  }
});

test("real limited-rate FFmpeg reports intermediate seconds and ordinary media conversion keeps a valid MP3", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
  const { FFMPEG_PATH } = require("../config");
  const { run, commandExists } = require("../utils");
  if (!(await commandExists(FFMPEG_PATH))) return t.skip("real FFmpeg is unavailable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fm-progress-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mp4"), output = path.join(root, "output.mp3");
  await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=white:s=64x48:r=10:d=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-codec:v", "libx264", "-preset", "ultrafast", "-codec:a", "aac", input]);
  const events = [];
  let finished = false;
  const observer = createMediaProgressObserver(event => { assert.equal(finished, false); events.push(event); });
  try {
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-re", "-i", input, "-codec:a", "libmp3lame", "-progress", "pipe:1", "-nostats", output], {
      timeout: 15000, onStdout: observer.onStdout, onStderr: observer.onStderr
    });
  } finally { finished = true; observer.close(); }
  assert.ok(events.some(event => event.total === 6 && event.completed > 0 && event.completed < event.total), "at least one real intermediate report must arrive before process completion");
  t.diagnostic(JSON.stringify({ actualIntermediate: events.filter(event => event.total === 6 && event.completed > 0 && event.completed < event.total), finalNativeReport: events.at(-1) }));
  await convertMedia(input, path.join(root, "ordinary.mp3"), "mp3", "video");
  const decoded = await run(FFMPEG_PATH, ["-hide_banner", "-i", path.join(root, "ordinary.mp3"), "-f", "null", "-"]);
  assert.match(decoded.stderr, /Audio:/);
});
