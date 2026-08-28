const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function parseBoxes(data, start, end) {
  const result = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error(`Invalid extended MP4 box: ${type}`);
      size = Number(data.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
      throw new Error(`Invalid MP4 box: ${type}`);
    }
    result.push({ type, start: offset, body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return result;
}

function findChild(data, parent, type) {
  return parseBoxes(data, parent.body, parent.end).find((item) => item.type === type) || null;
}

function findPath(data, parent, types) {
  let current = parent;
  for (const type of types) {
    current = findChild(data, current, type);
    if (!current) return null;
  }
  return current;
}

function readTrackCodec(data, stbl) {
  const stsd = findChild(data, stbl, "stsd");
  if (!stsd || stsd.body + 8 > stsd.end) return null;
  const count = data.readUInt32BE(stsd.body + 4);
  const entries = parseBoxes(data, stsd.body + 8, stsd.end);
  return count > 0 && entries.length > 0 ? entries[0].type : null;
}

function findAudioTrack(data) {
  const moov = parseBoxes(data, 0, data.length).find((item) => item.type === "moov");
  if (!moov) throw new Error("M4A 文件缺少 moov 容器。");
  for (const trak of parseBoxes(data, moov.body, moov.end).filter((item) => item.type === "trak")) {
    const stbl = findPath(data, trak, ["mdia", "minf", "stbl"]);
    if (!stbl) continue;
    const codec = readTrackCodec(data, stbl);
    if (codec) return { codec, stbl };
  }
  throw new Error("M4A 文件中没有可识别的音频轨道。");
}

function inspectMp4Audio(data) {
  return { codec: findAudioTrack(data).codec };
}

function parseSampleSizes(data, stsz) {
  if (stsz.body + 12 > stsz.end) throw new Error("AV3A 样本大小表不完整。");
  const fixedSize = data.readUInt32BE(stsz.body + 4);
  const count = data.readUInt32BE(stsz.body + 8);
  if (fixedSize) return new Array(count).fill(fixedSize);
  if (stsz.body + 12 + count * 4 > stsz.end) throw new Error("AV3A 样本大小表越界。");
  return Array.from({ length: count }, (_, index) => data.readUInt32BE(stsz.body + 12 + index * 4));
}

function parseChunkOffsets(data, chunkBox) {
  const count = data.readUInt32BE(chunkBox.body + 4);
  const width = chunkBox.type === "co64" ? 8 : 4;
  if (chunkBox.body + 8 + count * width > chunkBox.end) throw new Error("AV3A 分块偏移表越界。");
  return Array.from({ length: count }, (_, index) => {
    const at = chunkBox.body + 8 + index * width;
    return width === 8 ? Number(data.readBigUInt64BE(at)) : data.readUInt32BE(at);
  });
}

function parseSampleToChunk(data, stsc) {
  const count = data.readUInt32BE(stsc.body + 4);
  if (stsc.body + 8 + count * 12 > stsc.end) throw new Error("AV3A 样本分块表越界。");
  return Array.from({ length: count }, (_, index) => {
    const at = stsc.body + 8 + index * 12;
    return { firstChunk: data.readUInt32BE(at), samplesPerChunk: data.readUInt32BE(at + 4) };
  });
}

async function extractAv3aTrack(inputPath, outputPath) {
  const data = await fs.readFile(inputPath);
  const track = findAudioTrack(data);
  if (track.codec !== "av3a") throw new Error(`M4A 音频编码不是 AV3A（检测到 ${track.codec}）。`);
  const stsz = findChild(data, track.stbl, "stsz");
  const stsc = findChild(data, track.stbl, "stsc");
  const chunkBox = findChild(data, track.stbl, "stco") || findChild(data, track.stbl, "co64");
  if (!stsz || !stsc || !chunkBox) throw new Error("AV3A 音频轨道的 MP4 样本表不完整。");

  const sizes = parseSampleSizes(data, stsz);
  const offsets = parseChunkOffsets(data, chunkBox);
  const mappings = parseSampleToChunk(data, stsc);
  if (mappings.length === 0) throw new Error("AV3A 样本分块表为空。");

  const samples = [];
  let sampleIndex = 0;
  let mappingIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= offsets.length; chunkIndex += 1) {
    if (mappingIndex + 1 < mappings.length && chunkIndex >= mappings[mappingIndex + 1].firstChunk) mappingIndex += 1;
    let offset = offsets[chunkIndex - 1];
    for (let index = 0; index < mappings[mappingIndex].samplesPerChunk; index += 1) {
      const size = sizes[sampleIndex];
      if (!Number.isInteger(size) || size < 0 || offset + size > data.length) throw new Error("AV3A 样本表包含无效偏移。");
      samples.push(data.subarray(offset, offset + size));
      sampleIndex += 1;
      offset += size;
    }
  }
  if (sampleIndex !== sizes.length) throw new Error(`AV3A 样本数不一致：${sampleIndex}/${sizes.length}。`);
  const output = Buffer.concat(samples);
  await fs.writeFile(outputPath, output);
  return { samples: sampleIndex, bytes: output.length };
}

function candidateDecoderPaths() {
  const candidates = [];
  if (process.env.FLYINGMOUSE_AVS3_DECODER_PATH) candidates.push(process.env.FLYINGMOUSE_AVS3_DECODER_PATH);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "avs3", "avs3RM0Decoder.exe"));
  candidates.push(path.join(__dirname, "bin", "avs3", "avs3RM0Decoder.exe"));
  return [...new Set(candidates)];
}

async function resolveDecoderPath(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : candidateDecoderPaths();
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const decoderDir = path.dirname(candidate);
      for (const modelDir of [decoderDir, path.dirname(decoderDir)]) {
        try {
          await fs.access(path.join(modelDir, "model.bin"));
          return candidate;
        } catch {
          // Try the source-build layout, where Release/ sits below model.bin.
        }
      }
    } catch {
      // Try the next bundled/development location.
    }
  }
  throw new Error("缺少 AV3A 解码组件（avs3RM0Decoder.exe 或 model.bin）。请重新安装完整版本的 Mahiro Format。");
}

async function decoderWorkingDirectory(decoderPath) {
  const decoderDir = path.dirname(decoderPath);
  for (const modelDir of [decoderDir, path.dirname(decoderDir)]) {
    try {
      await fs.access(path.join(modelDir, "model.bin"));
      return modelDir;
    } catch {
      // Continue.
    }
  }
  throw new Error("AV3A 解码组件缺少 model.bin。");
}

async function defaultRunProcess(command, args, options) {
  await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
}

async function decodeAv3aM4a(inputPath, tempDir, options = {}) {
  const decoderPath = await resolveDecoderPath(options.decoderPath);
  const workingDirectory = await decoderWorkingDirectory(decoderPath);
  const bitstreamPath = path.join(tempDir, "audio.av3a");
  const wavPath = path.join(tempDir, "decoded.wav");
  await extractAv3aTrack(inputPath, bitstreamPath);
  const runProcess = options.runProcess || defaultRunProcess;
  await runProcess(decoderPath, ["-if", bitstreamPath, "-of", wavPath], {
    cwd: workingDirectory,
    timeout: 30 * 60 * 1000
  });
  const header = Buffer.alloc(12);
  const handle = await fs.open(wavPath, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (header.toString("latin1", 0, 4) !== "RIFF" || header.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("AV3A 解码器没有生成有效的 WAV 文件。");
  }
  return wavPath;
}

async function prepareDecryptedAudio(decrypted, options = {}) {
  if (!decrypted || decrypted.format !== "m4a") return decrypted.nativePath;
  const data = await fs.readFile(decrypted.nativePath);
  if (inspectMp4Audio(data).codec !== "av3a") return decrypted.nativePath;
  if ((options.platform || process.platform) !== "win32") {
    const error = new Error("Audio Vivid AV3A NCM currently requires Windows.");
    error.code = "AV3A_UNSUPPORTED_PLATFORM";
    error.messages = {
      zhCN: "此 NCM 使用 Audio Vivid AV3A 音轨，目前仅支持 Windows；macOS 仍可转换标准 NCM。",
      enUS: "This NCM uses an Audio Vivid AV3A track, which currently requires Windows. Standard NCM remains supported on macOS."
    };
    throw error;
  }
  const decode = options.decode || decodeAv3aM4a;
  return decode(decrypted.nativePath, decrypted.tempDir, options);
}

module.exports = {
  inspectMp4Audio,
  extractAv3aTrack,
  decodeAv3aM4a,
  prepareDecryptedAudio,
  resolveDecoderPath
};
