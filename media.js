// media.js — 飞鼠格式媒体转换：音视频 → 目标格式（ffmpeg 封装）。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

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

async function convertMedia(inputPath, outputPath, target, category, options = {}) {
  const args = ["-hide_banner", "-y", "-i", inputPath];
  for (const extraInput of options.extraInputs || []) args.push("-i", extraInput);

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
    if (target === "mp3") args.push("-codec:a", "libmp3lame", "-q:a", "2");
    if (target === "m4a") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "ogg") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "aac") args.push("-codec:a", "aac", "-b:a", "192k");
    if (target === "opus") args.push("-codec:a", "libopus", "-b:a", "160k");
    if (target === "wma") args.push("-codec:a", "wmav2", "-b:a", "192k");
  } else if (category === "audio") {
    throw new Error("音频文件不能直接转换为视频容器。请选择音频目标格式。");
  } else if (target === "mp4" || target === "mov") {
    args.push("-codec:v", "libx264", "-preset", "medium", "-crf", "23", "-codec:a", "aac", "-movflags", "+faststart");
  } else if (target === "webm") {
    args.push("-codec:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-codec:a", "libopus");
  } else if (target === "mkv") {
    args.push("-codec:v", "libx264", "-preset", "medium", "-crf", "23", "-codec:a", "aac");
  } else if (target === "gif") {
    // 输出质量：宽度上限 480→720（保留更多细节）、fps 10→12（更流畅）、
    // palettegen stats_mode=diff（按帧差异生成调色板，减少闪烁）+ sierra2_4a 抖动（更平滑，减少色带）
    args.push(
      "-vf", "fps=12,scale='min(720,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a",
      "-loop", "0"
    );
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
  convertMedia
};
