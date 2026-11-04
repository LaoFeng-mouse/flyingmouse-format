// media.js — 飞鼠格式媒体转换：音视频 → 目标格式（ffmpeg 封装）。
// 第一批抽取自 server.js（零逻辑改动，纯搬移）。

const { FFMPEG_PATH } = require("./config");
const fs = require("node:fs/promises");
const path = require("node:path");
const { run } = require("./utils");
const { reportConversionProgress, captureConversionProgressReporter } = require("./conversion-progress");

const transportStreamExtensions = new Set(["mts", "m2ts", "ts", "mst"]);

// TS packets contain a sync byte every 188 bytes; AVCHD/M2TS prefixes each
// packet with a four-byte timestamp. Also accept 204-byte FEC TS packets.
// This bounded content check excludes installer transforms and text source .ts.
function hasTransportStreamPackets(buffer) {
  for (const packetSize of [188, 192, 204]) {
    for (let offset = 0; offset < packetSize && offset + packetSize * 4 + 4 <= buffer.length; offset++) {
      let valid = true;
      for (let packet = 0; packet < 5; packet++) {
        const position = offset + packet * packetSize;
        if (buffer[position] !== 0x47 || (buffer[position + 3] & 0x30) === 0) { valid = false; break; }
      }
      if (valid) return true;
    }
  }
  return false;
}

function invalidTransportStream(extension) {
  const isMst = extension === "mst";
  const zhCN = isMst
    ? "这个 MST 文件不是可识别的 MPEG-TS 视频。MST 也可能是 Windows 安装配置文件，不能转换为 MP4；请使用相机原始 MTS/M2TS 视频。"
    : "文件内容不是带视频轨道的 MPEG-TS 视频，或文件已损坏。请使用完整的 MTS、M2TS 或 TS 视频；修改扩展名不能转换文件。";
  return Object.assign(new Error(zhCN), {
    code: isMst ? "MEDIA_MST_NOT_VIDEO" : "MEDIA_INVALID_TRANSPORT_STREAM",
    messages: { zhCN, enUS: isMst
      ? "This MST file is not a recognizable MPEG-TS video. MST may be a Windows Installer transform, which cannot be converted to MP4. Use the original camera MTS/M2TS video."
      : "The file is not an MPEG transport stream with a video track, or it is damaged. Use a complete MTS, M2TS, or TS video; changing its extension does not convert it." }
  });
}

async function inspectTransportStream(inputPath, extension, { signal } = {}) {
  const handle = await fs.open(inputPath, "r");
  let buffer;
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    buffer = head.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (!hasTransportStreamPackets(buffer)) throw invalidTransportStream(extension);
  const stderr = await probeMediaDescription(inputPath, { signal });
  if (!/^Input #0, mpegts,/m.test(stderr) || !/^\s*Stream #0:\d+[^\r\n]*: Video:/m.test(stderr)) {
    throw invalidTransportStream(extension);
  }
  const inspection = inspectMediaDescription(stderr);
  if (extension === "mst") inspection.warnings.push({ code: "MEDIA_MST_TRANSPORT_STREAM",
    messages: {
      zhCN: "已按文件内容识别为 MPEG-TS 视频并转换；原文件名的 MST 扩展名保持不变。",
      enUS: "The file content was verified as MPEG-TS video and converted. The original MST filename was not changed."
    } });
  return inspection;
}

async function probeMediaDescription(inputPath, { signal } = {}) {
  try {
    return (await run(FFMPEG_PATH, ["-hide_banner", "-i", inputPath], { timeout: 30000, signal })).stderr || "";
  } catch (error) {
    // FFmpeg's information-only invocation exits 1 because no output was given.
    // Launch failures, cancellation, and timeouts retain their original meaning.
    if (typeof error.code !== "number") throw error;
    return error.stderr || "";
  }
}

function inspectMediaDescription(stderr) {
  // Probe and map the same primary streams. An audio track may precede video,
  // and attached cover art must not replace an actual video stream.
  const videoLines = [...stderr.matchAll(/^\s*Stream #0:(\d+)[^\r\n]*: Video:[^\r\n]*/gm)]
    .filter(match => !/\(attached pic\)/i.test(match[0]));
  const audioLines = [...stderr.matchAll(/^\s*Stream #0:(\d+)[^\r\n]*: Audio:[^\r\n]*/gm)];
  const videoLine = videoLines[0]?.[0] || "";
  const interlaced = /\b(?:top|bottom) first\b/.test(videoLine);
  const audioLine = audioLines[0]?.[0] || "";
  const audioLayout = audioLine.match(/,\s*(mono|stereo|\d+(?:\.\d+)?(?:\([^)]*\))?)\s*,/)?.[1] || "";
  const audioChannels = audioLayout === "mono" ? 1 : audioLayout === "stereo" ? 2
    : audioLayout.split("(")[0].split(".").reduce((total, value) => total + (Number(value) || 0), 0);
  const videoTracks = new Set(videoLines.map(match => match[1])).size;
  const audioTracks = new Set(audioLines.map(match => match[1])).size;
  return { warnings: [], interlaced, audioLayout, audioChannels, videoTracks, audioTracks,
    videoIndex: videoLines[0]?.[1], audioIndex: audioLines[0]?.[1], video: videoInfoFromLine(videoLine) };
}

function createMediaProgressObserver(report = captureConversionProgressReporter(), { allowDuration = true } = {}) {
  let closed = false, duration = null, seconds = 0, input = null;
  const pending = { stdout: "", stderr: "" };
  const emit = () => {
    if (!closed) report({ stage: "converting", completed: duration === null ? seconds : Math.min(seconds, duration), total: duration, unit: "seconds" });
  };
  function accept(stream, chunk) {
    if (closed) return;
    // Native progress keys are ASCII. Never retain an unbounded stderr line or
    // expose filenames/native diagnostics as progress text.
    pending[stream] += chunk.toString("utf8");
    let end;
    while ((end = pending[stream].indexOf("\n")) !== -1) {
      const line = pending[stream].slice(0, end).trim();
      pending[stream] = pending[stream].slice(end + 1);
      if (stream === "stderr") {
        const header = /^Input #(\d+),/.exec(line);
        if (header) input = Number(header[1]);
        const match = input === 0 && allowDuration && duration === null
          ? /^Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?),/.exec(line) : null;
        if (match) {
          const value = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          if (Number.isFinite(value) && value > 0) { duration = value; emit(); }
        }
      } else {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) {
          const value = Number(match[1]) / 1000000;
          if (Number.isFinite(value) && value >= seconds) { seconds = value; emit(); }
        }
      }
    }
    if (pending[stream].length > 16384) pending[stream] = "";
  }
  return { onStdout: chunk => accept("stdout", chunk), onStderr: chunk => accept("stderr", chunk),
    close() { closed = true; pending.stdout = pending.stderr = ""; } };
}

async function probeAudioTrack(inputPath, { signal } = {}) {
  return inspectMediaDescription(await probeMediaDescription(inputPath, { signal })).audioTracks > 0;
}

// 探测视频流信息：是否带 alpha 透明通道 + 宽高 + 帧率。
// DXV3=rgba、RLE/qtrle=argb 都带 alpha；转 yuv（h264/h265/av1）会丢弃 alpha，
// 透明像素 RGB 本身是 0（黑），直接转会导致透明区变黑，需合成白底。
async function probeVideoInfo(inputPath, { signal } = {}) {
  return inspectMediaDescription(await probeMediaDescription(inputPath, { signal })).video;
}

function videoInfoFromLine(description) {
  const line = description.match(/: Video:([^\r\n]+)/);
  if (!line) return { hasAlpha: false, width: 0, height: 0, fps: 0 };
  const desc = line[1];
  const pixelFormat = desc.match(/,\s*([a-z0-9_]+)(?:\(|,)/i)?.[1] || "";
  const hasAlpha = /^(rgba|argb|bgra|abgr|yuva|yuv[0-9]+a)/i.test(pixelFormat);
  // 像素尺寸形如 ", 1466x1080,"（前面是逗号+空格，排除 codec hex 标识 0x20656C72）。
  const size = desc.match(/,\s*(\d{1,6})x(\d{1,6})\b/);
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
  reportConversionProgress({ stage: "converting", completed: 0, total: null, unit: "seconds" });
  const extension = String(options.inputExt || path.extname(inputPath).slice(1)).toLowerCase();
  const transportStream = category === "video" && transportStreamExtensions.has(extension);
  const inspection = transportStream ? await inspectTransportStream(inputPath, extension, options)
    : inspectMediaDescription(await probeMediaDescription(inputPath, options));
  const args = ["-hide_banner", "-y"];
  // Do not silently report success after dropping corrupt transport-stream data.
  if (transportStream) args.push("-xerror", "-err_detect", "explode");
  args.push("-i", inputPath);
  for (const extraInput of options.extraInputs || []) args.push("-i", extraInput);
  const audioTarget = ["mp3", "wav", "flac", "m4a", "ogg", "aac", "opus", "wma"].includes(target);
  if (!(options.extraInputs || []).length) {
    if ((!audioTarget && inspection.videoTracks > 1) || (target !== "gif" && inspection.audioTracks > 1)) {
      inspection.warnings.push({ code: "MEDIA_PRIMARY_STREAMS_SELECTED", messages: {
        zhCN: "源文件包含多条媒体轨道，本次仅转换第一条视频轨道和第一条音频轨道（按目标格式保留）。",
        enUS: "The source has multiple media tracks. Only the first video and first audio tracks are converted, where supported by the output format."
      } });
    }
  }

  if (["webm", "ogg", "opus"].includes(target) && inspection.audioLayout === "5.1(side)") {
    // Opus's Vorbis surround mapping accepts 5.1(back), not FFmpeg's 5.1(side).
    // Map all six channels explicitly rather than silently dropping surround audio.
    args.push("-af", "pan=5.1|FL=FL|FR=FR|FC=FC|LFE=LFE|BL=SL|BR=SR", "-mapping_family", "1");
    inspection.warnings.push({ code: "MEDIA_SURROUND_LAYOUT_ADAPTED", messages: {
      zhCN: "已保留六声道音频，并将侧环绕映射为目标编码支持的 5.1 环绕布局。",
      enUS: "All six audio channels were retained; side surrounds were mapped to the 5.1 surround layout supported by the output codec."
    } });
  }
  if (["mp3", "wma"].includes(target) && inspection.audioChannels > 2) {
    args.push("-ac", "2");
    inspection.warnings.push({ code: "MEDIA_AUDIO_DOWNMIXED", messages: {
      zhCN: "目标音频格式仅支持最多两个声道，已将多声道音频混合为立体声。",
      enUS: "This output audio format supports at most two channels; multichannel audio was mixed down to stereo."
    } });
  }

  // 视频目标（mp4/mov/mkv/webm）输出 yuv 编码，带 alpha 的源（DXV3 rgba/RLE argb）
  // 透明区会变黑——先探测，命中则合成白底（filter_complex + 额外 color 输入）。
  let alphaComposite = null;
  if (target === "mp4" || target === "mov" || target === "mkv" || target === "webm") {
    alphaComposite = alphaCompositeArgs(inspection.video, options.alphaBackground);
    if (alphaComposite) {
      // Extra cover inputs, when supplied, precede the generated background.
      const backgroundIndex = 1 + (options.extraInputs || []).length;
      alphaComposite.filterComplex = `[${backgroundIndex}:v][0:${inspection.videoIndex}]overlay=shortest=1[alphaout]`;
      args.push(...alphaComposite.inputs);
    }
  }

  // Camera AVCHD commonly contains interlaced frames. Encoding them as ordinary
  // progressive video leaves visible combing. Process only frames marked as
  // interlaced and retain both temporal fields; progressive TS frames are unchanged.
  const deinterlace = transportStream && inspection.interlaced ? "bwdif=mode=send_field:parity=auto:deint=interlaced" : "";
  if (deinterlace && ["mp4", "mov", "mkv", "webm"].includes(target)) args.push("-vf", deinterlace);
  if (deinterlace && inspection.interlaced && ["mp4", "mov", "mkv", "webm", "gif"].includes(target)) {
    inspection.warnings.push({ code: "MEDIA_TRANSPORT_DEINTERLACED", messages: {
      zhCN: "已将相机隔行画面转换为逐行画面，减少运动边缘的横纹。",
      enUS: "Interlaced camera frames were deinterlaced to reduce combing on moving edges."
    } });
  }

  if (audioTarget) {
    if (!(options.extraInputs || []).length) {
      args.push("-vn");
      if (!inspection.audioTracks) {
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
    args.push(...videoEncoderArgs(options.videoCodec), "-codec:a", "aac", "-movflags", "+faststart");
  } else if (target === "webm") {
    args.push("-codec:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-codec:a", "libopus");
  } else if (target === "mkv") {
    args.push(...videoEncoderArgs(options.videoCodec), "-codec:a", "aac");
  } else if (target === "gif") {
    // 输出质量：宽度上限 480→720（保留更多细节）、fps 10→12（更流畅）、
    // palettegen stats_mode=diff（按帧差异生成调色板，减少闪烁）+ sierra2_4a 抖动（更平滑，减少色带）
    args.push(
      "-vf", `${deinterlace ? `${deinterlace},` : ""}fps=12,${transportStream ? "scale=w='min(720,iw*sar)':h='max(1,round(ow/dar))':flags=lanczos,setsar=1" : "scale='min(720,iw)':-2:flags=lanczos"},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`,
      "-loop", "0"
    );
  }

  if (alphaComposite) {
    args.push("-filter_complex", alphaComposite.filterComplex, "-map", `[${alphaComposite.videoLabel}]`);
    if (inspection.audioIndex != null) args.push("-map", `0:${inspection.audioIndex}`);
  } else if (!(options.extraInputs || []).length) {
    if (!audioTarget) args.push("-map", inspection.videoIndex != null ? `0:${inspection.videoIndex}` : "0:v:0");
    if (target !== "gif" && inspection.audioIndex != null) args.push("-map", `0:${inspection.audioIndex}`);
  }

  for (const [key, value] of Object.entries(options.metadata || {})) {
    if (value) args.push("-metadata", `${key}=${value}`);
  }
  args.push(...(options.coverArgs || []));

  args.push("-progress", "pipe:1", "-nostats", outputPath);
  // With extra inputs the output timeline need not equal input #0's duration.
  const progress = createMediaProgressObserver(undefined, { allowDuration: !(options.extraInputs || []).length });
  try {
    await run(FFMPEG_PATH, args, { timeout: 1000 * 60 * 30, signal: options.signal,
      onStdout: progress.onStdout, onStderr: progress.onStderr });
    reportConversionProgress({ stage: "validating" });
  } finally { progress.close(); }
  return inspection;
}

module.exports = {
  probeAudioTrack,
  probeVideoInfo,
  videoEncoderArgs,
  alphaCompositeArgs,
  convertMedia,
  hasTransportStreamPackets,
  inspectTransportStream,
  createMediaProgressObserver
};
