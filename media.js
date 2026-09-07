// media.js — 飞鼠格式媒体转换：音视频 → 目标格式（ffmpeg 封装）。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { FFMPEG_PATH } = require("./config");
const { run } = require("./utils");

async function probeAudioTrack(inputPath) {
  try {
    const { stderr } = await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000 });
    return /Stream #\d+:\d+.*Audio/i.test(stderr);
  } catch (error) {
    return /Stream #\d+:\d+.*Audio/i.test(String(error.message || ""));
  }
}

// 检测源是否内嵌 attached_pic 封面附件（如 m4a/mp3 的 ID3/ilist 封面）。
// mp4 的“封面”通常是普通视频流（首帧渲染），不算 attached_pic，此处返回 false，
// 由调用方回退到“抽首帧”逻辑。
async function probeCoverAttachment(inputPath) {
  try {
    const { stderr } = await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000 });
    return /attached_pic/i.test(stderr);
  } catch (error) {
    return /attached_pic/i.test(String(error.message || ""));
  }
}

// 为 mp3 目标准备封面：优先透传源已存在的 attached_pic 封面附件；
// 若没有，则从视频源抽第一帧作为封面。返回 { path } 或 null（无封面可用）。
async function prepareCoverForMp3(inputPath) {
  const outBase = path.join(os.tmpdir(), `fm-cover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    // 1) 优先：源已有 attached_pic 封面附件，提取出来复用
    if (await probeCoverAttachment(inputPath)) {
      const attached = `${outBase}-attached.png`;
      try {
        await run(FFMPEG_PATH, ["-y", "-i", inputPath, "-map", "0:v:0?", "-c:v", "png", attached], { timeout: 30000 });
        if (fs.existsSync(attached) && fs.statSync(attached).size > 0) return { path: attached };
      } catch (_) {
        try { fs.unlinkSync(attached); } catch (_) {}
      }
    }
    // 2) 回退：从视频源抽第一帧（mp4 的封面即首帧渲染）
    const frame = `${outBase}-frame.png`;
    await run(FFMPEG_PATH, ["-y", "-ss", "0", "-i", inputPath, "-frames:v", "1", "-f", "image2", frame], { timeout: 30000 });
    if (fs.existsSync(frame) && fs.statSync(frame).size > 0) return { path: frame };
    try { fs.unlinkSync(frame); } catch (_) {}
  } catch (_) {
    /* 抽帧失败则放弃封面，不影响音频转换 */
  }
  return null;
}

// 把封面以 ID3 APIC 写入已生成的 mp3（音频流原样 copy，仅补元数据）。
async function muxCoverIntoMp3(audioPath, coverPath) {
  const tagged = `${audioPath}.covered.mp3`;
  try {
    await run(FFMPEG_PATH, [
      "-y", "-i", audioPath, "-i", coverPath,
      "-map", "0:a:0", "-map", "1",
      "-c", "copy", "-id3v2_version", "3", "-write_id3v1", "1",
      tagged,
    ], { timeout: 60000 });
    if (fs.existsSync(tagged) && fs.statSync(tagged).size > 0) {
      fs.renameSync(tagged, audioPath);
      return true;
    }
  } catch (_) {
    /* 封面写入失败不阻断音频结果 */
  } finally {
    try { fs.unlinkSync(tagged); } catch (_) {}
  }
  return false;
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

  // mp3 目标准备封面：视频源优先透传 attached_pic 封面附件，否则抽首帧。主转换后回写。
  let coverInfo = null;

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
      if (!(await probeAudioTrack(inputPath))) {
        const error = new Error("该视频没有音频轨道，无法转换为音频格式。");
        error.code = "MEDIA_NO_AUDIO_TRACK";
        error.messages = {
          zhCN: "该视频没有音频轨道，无法转换为音频格式。",
          enUS: "This video has no audio track, so it cannot be converted to an audio format."
        };
        throw error;
      }
    }
    if (target === "mp3") {
      args.push("-codec:a", "libmp3lame", "-q:a", "2");
      // 视频源且无外部 extraInputs：准备封面（优先 attached_pic，否则抽首帧），主转换后回写
      if (category === "video" && !(options.extraInputs || []).length) {
        coverInfo = await prepareCoverForMp3(inputPath);
      }
    }
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

  // 封面回写：把准备好的封面以 APIC 写入刚生成的 mp3（音频流不改码，仅补元数据）。
  // 失败不阻断结果——保留无封面的 mp3。临时封面文件始终清理。
  if (coverInfo && coverInfo.path) {
    try {
      await muxCoverIntoMp3(outputPath, coverInfo.path);
    } finally {
      try { fs.unlinkSync(coverInfo.path); } catch (_) {}
    }
  }
}

module.exports = {
  probeAudioTrack,
  probeVideoInfo,
  videoEncoderArgs,
  alphaCompositeArgs,
  convertMedia
};
