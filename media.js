// media.js — 飞鼠格式媒体转换：音视频 → 目标格式（ffmpeg 封装）。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

const { FFMPEG_PATH } = require("./config");
const { run } = require("./utils");

// ffmpeg 探测失败的输入类错误特征：文件打不开/损坏/容器无效。
// 命中说明「探测不到音轨」不是因为真没音轨，而是文件本身读不了。
const FFMPEG_INPUT_ERROR_RE = /Invalid data found|Error opening input|No such file|demux|Format .* detected only with low score|moov atom not found|End of file/i;

async function probeAudioTrack(inputPath) {
  let stderr = "";
  try {
    const result = await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000 });
    stderr = result.stderr || "";
  } catch (error) {
    // ffmpeg -i 无输出参数必然退出非 0；utils.run 把完整 stderr 塞进 error.message。
    stderr = String(error.message || "");
  }
  return /Stream #\d+:\d+.*Audio/i.test(stderr);
}

// 区分「文件损坏/无法读取」与「真的没有音频轨道」：
// 先探测输入是否可解析（ffmpeg stderr 无 Input/Stream 行且带输入错误特征 = 文件读不了），
// 读不了的抛 MEDIA_INPUT_UNREADABLE；能读但无 Audio 流才是 MEDIA_NO_AUDIO_TRACK。
async function assertConvertibleToAudio(inputPath) {
  let stderr = "";
  try {
    const result = await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000 });
    stderr = result.stderr || "";
  } catch (error) {
    stderr = String(error.message || "");
  }
  const hasInputStreams = /Stream #\d+:\d+/.test(stderr);
  if (!hasInputStreams && FFMPEG_INPUT_ERROR_RE.test(stderr)) {
    const error = new Error("音视频文件无法读取，可能已损坏或格式不受支持。");
    error.code = "MEDIA_INPUT_UNREADABLE";
    error.messages = {
      zhCN: "音视频文件无法读取，可能已损坏或格式不受支持。",
      enUS: "The media file could not be read. It may be corrupted or in an unsupported format."
    };
    throw error;
  }
  if (!/Stream #\d+:\d+.*Audio/i.test(stderr)) {
    const error = new Error("该视频没有音频轨道，无法转换为音频格式。");
    error.code = "MEDIA_NO_AUDIO_TRACK";
    error.messages = {
      zhCN: "该视频没有音频轨道，无法转换为音频格式。",
      enUS: "This video has no audio track, so it cannot be converted to an audio format."
    };
    throw error;
  }
}

// 探测视频流信息：是否带 alpha 透明通道 + 宽高 + 帧率。
// DXV3=rgba、RLE/qtrle=argb 都带 alpha；转 yuv（h264/h265/av1）会丢弃 alpha，
// 透明像素 RGB 本身是 0（黑），直接转会导致透明区变黑，需合成白底。
async function probeVideoInfo(inputPath) {
  let stderr = "";
  try {
    const result = await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000 });
    stderr = result.stderr || "";
  } catch (error) {
    stderr = String(error.message || "");
  }
  const line = stderr.match(/Stream #0:0.*?Video:([^\n]+)/);
  if (!line) return { hasAlpha: false, width: 0, height: 0, fps: 0 };
  const desc = line[1];
  const pixelFormat = desc.match(/,\s*([a-z0-9_]+)\(/i)?.[1] || "";
  const hasAlpha = /^(rgba|argb|bgra|abgr|yuva|yuv[0-9]+a)/i.test(pixelFormat);
  // 像素尺寸形如 ", 1466x1080,"（前面是逗号+空格，排除 codec hex 标识 0x20656C72）。
  const size = desc.match(/,\s*(\d{2,6})x(\d{2,6})\b/);
  const fpsMatch = desc.match(/([\d.]+)\s*fps/);
  return {
    hasAlpha,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    fps: fpsMatch ? Number(fpsMatch[1]) : 0
  };
}

// 生成「把带 alpha 的视频合成到背景色」的额外输入与 filter_complex 片段。
// 返回 { inputs, filterComplex }；无 alpha 返回 null。backgroundColor 支持：
//   "white"（默认）/"black"/十六进制色值（如 "0xff0000" 或 "red" 等 ffmpeg 认的颜色名）。
function alphaCompositeArgs(info, backgroundColor = "white") {
  if (!info || !info.hasAlpha) return null;
  const w = info.width > 0 ? info.width : 1280;
  const h = info.height > 0 ? info.height : 720;
  const r = info.fps > 0 ? info.fps : 30;
  // 只放行安全颜色值（纯字母/井号+hex/0x hex），防止注入 ffmpeg 滤镜参数。
  const color = /^[A-Za-z]+$|^0x[0-9A-Fa-f]{6,8}$|^#[0-9A-Fa-f]{6,8}$/.test(String(backgroundColor || "").trim())
    ? String(backgroundColor).trim()
    : "white";
  return {
    inputs: ["-f", "lavfi", "-i", `color=${color}:s=${w}x${h}:r=${r}`],
    filterComplex: "[1:v][0:v]overlay=shortest=1[alphaout]",
    videoLabel: "alphaout"
  };
}

function videoEncoderArgs(codec) {
  // 视频输出编码选择：默认 h264，可选 h265 / av1。
  if (codec === "h265" || codec === "hevc") {
    return ["-codec:v", "libx265", "-preset", "medium", "-crf", "28"];
  }
  if (codec === "av1") {
    return ["-codec:v", "libsvtav1", "-preset", "8", "-crf", "32"];
  }
  return ["-codec:v", "libx264", "-preset", "medium", "-crf", "23"];
}

async function convertMedia(inputPath, outputPath, target, category, options = {}) {
  const args = ["-hide_banner", "-y", "-i", inputPath];
  for (const extraInput of options.extraInputs || []) args.push("-i", extraInput);

  // 视频目标（mp4/mov/mkv/webm）输出 yuv 编码，带 alpha 的源（DXV3 rgba/RLE argb）
  // 透明区会变黑——先探测，命中则合成白底（filter_complex + 额外 color 输入）。
  let alphaComposite = null;
  if (target === "mp4" || target === "mov" || target === "mkv" || target === "webm") {
    const info = await probeVideoInfo(inputPath);
    alphaComposite = alphaCompositeArgs(info, options.alphaBackground);
    if (alphaComposite) args.push(...alphaComposite.inputs);
  }

  if (["mp3", "wav", "flac", "m4a", "ogg", "aac", "opus", "wma"].includes(target)) {
    if (!(options.extraInputs || []).length) {
      args.push("-vn");
      // 前置校验：区分「文件损坏读不了」与「真没音轨」，避免损坏文件被误报为无音轨。
      await assertConvertibleToAudio(inputPath);
    }
    if (target === "mp3") args.push("-codec:a", "libmp3lame", "-q:a", "2");
    if (target === "m4a") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "ogg") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "aac") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "opus") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "wma") args.push("-codec:a", "wmav2", "-b:a", "192k");
  } else if (category === "audio") {
    throw new Error("音频文件不能直接转换为视频容器。请选择音频目标格式。");
  } else if (target === "mp4" || target === "mov") {
    args.push(...videoEncoderArgs(options.videoCodec), "-codec:a", "aac", "-movflags", "+faststart");
  } else if (target === "webm") {
    args.push("-codec:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-codec:a", "libopus");
  } else if (target === "mkv") {
    args.push(...videoEncoderArgs(options.videoCodec), "-codec:a", "aac");
  } else if (target === "gif") {
    // 输出质量：宽度上限 480→720（保留更多细节）、fps 10→12（更流畅）、
    // palettegen stats_mode=diff（按帧差异生成调色板，减少闪烁）+ sierra2_4a 抖动（更平滑，减少色带）
    args.push(
      "-vf", "fps=12,scale='min(720,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a",
      "-loop", "0"
    );
  }

  if (alphaComposite) {
    args.push("-filter_complex", alphaComposite.filterComplex, "-map", `[${alphaComposite.videoLabel}]`, "-map", "0:a?");
  }

  for (const [key, value] of Object.entries(options.metadata || {})) {
    if (value) args.push("-metadata", `${key}=${value}`);
  }
  args.push(...(options.coverArgs || []));

  args.push(outputPath);
  await run(FFMPEG_PATH, args, { timeout: 1000 * 60 * 30 });
}

module.exports = {
  probeAudioTrack,
  assertConvertibleToAudio,
  probeVideoInfo,
  videoEncoderArgs,
  alphaCompositeArgs,
  convertMedia
};
