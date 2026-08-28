const ASF_HEADER = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");

function detectAudioFormat(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "unknown";

  let offset = 0;
  if (options.skipLeadingZeros) {
    while (offset < buffer.length && buffer[offset] === 0) offset += 1;
  }
  const data = buffer.subarray(offset);

  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (data.length >= 3 && data.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WAVE"
  ) return "wav";
  if (data.length >= 8 && data.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "MAC ") return "ape";
  if (data.length >= ASF_HEADER.length && data.subarray(0, ASF_HEADER.length).equals(ASF_HEADER)) return "wma";
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return "aac";
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

module.exports = { detectAudioFormat };
