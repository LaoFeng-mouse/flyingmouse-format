// Offline timed-text conversion. Unsupported events fail before any output is
// written; format-specific presentation losses are always reported to the user.
const fs = require("node:fs/promises");

const FORMATS = new Set(["srt", "vtt", "ass", "ssa"]);
const WARNINGS = {
  SUBTITLE_STYLE_LOSS: ["字幕样式、说话人或特效已转为纯文字，请核对显示效果。", "Subtitle styling, speaker annotations or effects were converted to plain text. Review the result."],
  SUBTITLE_POSITION_LOSS: ["字幕定位、边距或区域信息无法保留，请核对画面中的字幕位置。", "Subtitle positioning, margins or regions could not be preserved. Review on-screen placement."],
  SUBTITLE_METADATA_LOSS: ["字幕标识、备注或附加元数据未写入目标格式。", "Subtitle identifiers, comments or additional metadata were not carried into the output format."],
  SUBTITLE_TIME_PRECISION_LOSS: ["ASS/SSA 只保留百分之一秒，时间戳已四舍五入，请核对同步。", "ASS/SSA timestamps use centiseconds. Millisecond values were rounded; review synchronization."],
  SUBTITLE_TIMING_REMOVED: ["TXT 只保留字幕文字，时间轴信息已移除。", "TXT contains subtitle text only; timing information was removed."],
  SUBTITLE_INLINE_TIMING_LOSS: ["逐字高亮或行内时间戳已移除，整条字幕的起止时间仍保留。", "Word highlighting or inline timestamps were removed; each cue's start and end times remain."],
  SUBTITLE_LINE_WRAP_LOSS: ["ASS 软换行已转成普通换行，请核对分行。", "ASS soft line breaks were converted to regular line breaks. Review line wrapping."]
};

function failure(code, detail) {
  const descriptions = {
    SUBTITLE_PARSE_FAILED: ["字幕结构不完整或无法解析，已停止转换。", "The subtitle structure is incomplete or invalid. Conversion was stopped."],
    SUBTITLE_INVALID_TIMING: ["字幕时间戳无效，结束时间不能早于开始时间。", "Subtitle timestamps are invalid; end time must not precede start time."],
    SUBTITLE_UNSUPPORTED_CONTENT: ["字幕包含当前无法完整转换的绘图、事件或文字内容，已停止转换以避免丢失。", "The subtitle contains drawings, events or text that cannot be represented completely. Conversion was stopped to prevent loss."],
    SUBTITLE_ENCODING_UNSUPPORTED: ["字幕编码无法可靠识别，请先另存为 UTF-8 或带 BOM 的 UTF-16 后重试。", "The subtitle encoding could not be decoded reliably. Save it as UTF-8 or BOM-marked UTF-16 and retry."],
    SUBTITLE_UNSUPPORTED_FORMAT: ["不支持此字幕转换格式。", "This subtitle conversion format is unsupported."]
  };
  const [zhCN, enUS] = descriptions[code];
  return Object.assign(new Error(zhCN), { code, errorCode: code, messages: { zhCN, enUS }, details: { reason: detail } });
}

function decode(buffer) {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(buffer);
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(buffer);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw failure("SUBTITLE_ENCODING_UNSUPPORTED", "invalid Unicode byte sequence");
  }
}

function timestamp(value, format) {
  const regex = format === "srt" ? /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/
    : format === "vtt" ? /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/
      : /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/;
  const match = value.match(regex);
  if (!match) throw failure("SUBTITLE_INVALID_TIMING", `invalid ${format} timestamp`);
  const milliseconds = (((Number(match[1] || 0) * 60) + Number(match[2])) * 60 + Number(match[3])) * 1000
    + Number(match[4]) * (format === "ass" || format === "ssa" ? 10 : 1);
  if (!Number.isSafeInteger(milliseconds)) throw failure("SUBTITLE_INVALID_TIMING", "timestamp is outside the safe numeric range");
  return milliseconds;
}

function cue(start, end, text) {
  if (end < start) throw failure("SUBTITLE_INVALID_TIMING", "end precedes start");
  if (!text.trim()) throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "cue contains no convertible text");
  return { start, end, text };
}

function decodeEntities(value) {
  const names = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (whole, entity) => {
    if (entity[0] !== "#") return names[entity.toLowerCase()] ?? whole;
    const numeric = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return numeric > 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff) ? String.fromCodePoint(numeric) : whole;
  });
}

function plainTaggedText(value, warnings) {
  // Only known presentation tags are removed. Unknown tags stay literal, so
  // source text that happens to resemble markup cannot silently disappear.
  const text = value.replace(/<\/?(?:b|i|u|s|font|c(?:\.[\w-]+)*|v|lang|ruby|rt)(?:\s[^<>]*)?>/gi, () => {
    warnings.add("SUBTITLE_STYLE_LOSS");
    return "";
  }).replace(/<(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}>/g, () => {
    warnings.add("SUBTITLE_INLINE_TIMING_LOSS");
    return "";
  });
  return decodeEntities(text);
}

function parseBlocks(source, format, warnings) {
  let text = source.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  if (format === "vtt") {
    const headerEnd = text.indexOf("\n");
    const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
    if (!/^WEBVTT(?:[ \t].*)?$/.test(header)) throw failure("SUBTITLE_PARSE_FAILED", "missing WEBVTT header");
    text = headerEnd < 0 ? "" : text.slice(headerEnd + 1);
    if (text && !/^\s*\n/.test(text)) throw failure("SUBTITLE_PARSE_FAILED", "missing blank line after WEBVTT header");
    if (header !== "WEBVTT") warnings.add("SUBTITLE_METADATA_LOSS");
  }
  const blocks = text.trim().split(/\n[ \t]*\n+/).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (format === "vtt" && /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) {
      warnings.add(lines[0] === "STYLE" ? "SUBTITLE_STYLE_LOSS" : lines[0] === "REGION" ? "SUBTITLE_POSITION_LOSS" : "SUBTITLE_METADATA_LOSS");
      continue;
    }
    let timingIndex = lines[0].includes("-->") ? 0 : 1;
    if (timingIndex && (format === "srt" ? !/^\d+$/.test(lines[0]) : !lines[0].trim())) {
      throw failure("SUBTITLE_PARSE_FAILED", "invalid cue identifier");
    }
    const timing = (lines[timingIndex] || "").match(/^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/);
    if (!timing || lines.length <= timingIndex + 1) throw failure("SUBTITLE_PARSE_FAILED", "cue timing or payload is missing");
    if (timing[3].trim()) warnings.add("SUBTITLE_POSITION_LOSS");
    if (format === "vtt" && timingIndex) warnings.add("SUBTITLE_METADATA_LOSS");
    const payload = lines.slice(timingIndex + 1).join("\n");
    // A timestamp row inside a cue commonly means a missing blank separator.
    // Refuse it instead of treating an entire subsequent subtitle as dialogue.
    if (/^\S+[ \t]+-->[ \t]+\S+/m.test(payload)) throw failure("SUBTITLE_PARSE_FAILED", "missing cue separator");
    cues.push(cue(timestamp(timing[1], format), timestamp(timing[2], format), plainTaggedText(payload, warnings)));
  }
  return cues;
}

function plainAssText(value, warnings) {
  let drawingMode = 0;
  const output = value.replace(/\{([^}]*)\}|([^{}]+)/g, (whole, override, visible) => {
    if (override !== undefined) {
      if (!override.includes("\\")) throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "ASS brace text cannot be interpreted safely");
      const drawings = [...override.matchAll(/\\p(\d+)(?!\d)/g)];
      if (drawings.length) drawingMode = Number(drawings.at(-1)[1]);
      if (drawings.some(match => Number(match[1]) > 0)) throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "ASS vector drawing");
      if (/\\(?:pos|move|org|an|a\d|clip|iclip|fr|fsc)/.test(override)) warnings.add("SUBTITLE_POSITION_LOSS");
      if (/\\[kK](?:f|o)?\d/.test(override)) warnings.add("SUBTITLE_INLINE_TIMING_LOSS");
      warnings.add("SUBTITLE_STYLE_LOSS");
      return "";
    }
    if (drawingMode) throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "ASS drawing payload");
    return visible;
  });
  // Unbalanced braces are not silently eaten by the override parser.
  if (value.replace(/\{[^}]*\}/g, "").match(/[{}]/)) throw failure("SUBTITLE_PARSE_FAILED", "unbalanced ASS override braces");
  if (output.includes("\\n")) warnings.add("SUBTITLE_LINE_WRAP_LOSS");
  return output.replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, "\u00a0");
}

function splitEvent(value, count) {
  const fields = [];
  let position = 0;
  while (fields.length < count - 1) {
    const comma = value.indexOf(",", position);
    if (comma < 0) throw failure("SUBTITLE_PARSE_FAILED", "incomplete ASS/SSA event");
    fields.push(value.slice(position, comma).trim());
    position = comma + 1;
  }
  fields.push(value.slice(position));
  return fields;
}

function parseAss(source, format, warnings) {
  let section = "";
  let fields = null;
  const cues = [];
  // 与 parseBlocks 一致：带 UTF-8 BOM 的 ASS/SSA 首行会被当成章节外的内容而报错。
  for (const raw of source.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      section = heading[1].toLowerCase();
      if (!["script info", "v4 styles", "v4+ styles", "events", "fonts", "graphics", "aegisub project garbage", "aegisub extradata"].includes(section)) {
        throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "unknown ASS/SSA section");
      }
      if (section.includes("styles")) warnings.add("SUBTITLE_STYLE_LOSS");
      if (["fonts", "graphics"].includes(section)) warnings.add("SUBTITLE_STYLE_LOSS");
      continue;
    }
    if (!section) throw failure("SUBTITLE_PARSE_FAILED", "content before an ASS/SSA section");
    if (section !== "events") {
      warnings.add("SUBTITLE_METADATA_LOSS");
      continue;
    }
    const entry = line.match(/^([^:]+):[ \t]?(.*)$/);
    if (!entry) throw failure("SUBTITLE_PARSE_FAILED", "malformed ASS/SSA event line");
    const type = entry[1].toLowerCase();
    if (type === "format") {
      fields = entry[2].split(",").map(value => value.trim().toLowerCase());
      if (fields.at(-1) !== "text" || !fields.includes("start") || !fields.includes("end") || new Set(fields).size !== fields.length) {
        throw failure("SUBTITLE_PARSE_FAILED", "ASS/SSA event format must include start/end and end with text");
      }
      continue;
    }
    if (type === "comment") { warnings.add("SUBTITLE_METADATA_LOSS"); continue; }
    if (type !== "dialogue") throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "unknown ASS/SSA event type");
    if (!fields) throw failure("SUBTITLE_PARSE_FAILED", "ASS/SSA event Format is missing");
    const values = splitEvent(entry[2], fields.length);
    const event = Object.fromEntries(fields.map((field, index) => [field, values[index]]));
    if (["marginl", "marginr", "marginv", "layer"].some(field => Number(event[field] || 0))) warnings.add("SUBTITLE_POSITION_LOSS");
    if (event.style || event.name || event.effect) warnings.add("SUBTITLE_STYLE_LOSS");
    if (Object.keys(event).some(field => !["layer", "marked", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"].includes(field))) warnings.add("SUBTITLE_METADATA_LOSS");
    cues.push(cue(timestamp(event.start, format), timestamp(event.end, format), plainAssText(event.text, warnings)));
  }
  return cues;
}

function formatTime(milliseconds, format) {
  const value = format === "ass" || format === "ssa" ? Math.round(milliseconds / 10) * 10 : milliseconds;
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value / 60000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  if (format === "ass" || format === "ssa") return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad((value % 1000) / 10)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${format === "srt" ? "," : "."}${pad(value % 1000, 3)}`;
}

function encodeTaggedText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(cues, target, warnings) {
  if (target === "txt") {
    warnings.add("SUBTITLE_TIMING_REMOVED");
    return `${cues.map(item => item.text).join("\n\n")}\n`;
  }
  if (target === "srt" || target === "vtt") return (target === "vtt" ? "WEBVTT\n\n" : "")
    + cues.map((item, index) => `${target === "srt" ? `${index + 1}\n` : ""}${formatTime(item.start, target)} --> ${formatTime(item.end, target)}\n${encodeTaggedText(item.text)}\n`).join("\n");
  const ass = target === "ass";
  const header = ass
    ? "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    : "[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,Arial,24,16777215,255,0,0,0,0,1,2,0,2,10,10,10,0,1\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  return header + cues.map(item => {
    if (/[{}]|\\[Nnh]/.test(item.text)) throw failure("SUBTITLE_UNSUPPORTED_CONTENT", "literal ASS control syntax in plain text");
    if (item.start % 10 || item.end % 10) warnings.add("SUBTITLE_TIME_PRECISION_LOSS");
    const text = item.text.replace(/\n/g, "\\N").replace(/\u00a0/g, "\\h");
    return `Dialogue: ${ass ? "0" : "Marked=0"},${formatTime(item.start, target)},${formatTime(item.end, target)},Default,,0,0,0,,${text}\n`;
  }).join("");
}

async function convertSubtitle(inputPath, outputPath, inputExt, target) {
  const sourceFormat = String(inputExt).replace(/^\./, "").toLowerCase();
  const targetFormat = String(target).replace(/^\./, "").toLowerCase();
  if (!FORMATS.has(sourceFormat) || (!FORMATS.has(targetFormat) && targetFormat !== "txt")) throw failure("SUBTITLE_UNSUPPORTED_FORMAT", "unsupported source or target");
  const source = decode(await fs.readFile(inputPath));
  if (source.includes("\0")) throw failure("SUBTITLE_ENCODING_UNSUPPORTED", "NUL bytes in timed text");
  const warningCodes = new Set();
  const cues = sourceFormat === "ass" || sourceFormat === "ssa" ? parseAss(source, sourceFormat, warningCodes) : parseBlocks(source, sourceFormat, warningCodes);
  if (!cues.length) throw failure("SUBTITLE_PARSE_FAILED", "no subtitle cues");
  // A validated same-format export can retain every source presentation detail.
  const output = sourceFormat === targetFormat ? source : serialize(cues, targetFormat, warningCodes);
  await fs.writeFile(outputPath, output, "utf8");
  return { warnings: sourceFormat === targetFormat ? [] : [...warningCodes].map(code => ({ code, messages: { zhCN: WARNINGS[code][0], enUS: WARNINGS[code][1] } })) };
}

module.exports = { convertSubtitle };
