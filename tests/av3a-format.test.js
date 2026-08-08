const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { detectAudioFormat } = require("../ncm-format");
const { inspectMp4Audio, extractAv3aTrack, decodeAv3aM4a, prepareDecryptedAudio } = require("../av3a-format");

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

function uint32(...values) {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => result.writeUInt32BE(value, index * 4));
  return result;
}

function makeMp4(codec = "av3a") {
  const ftyp = box("ftyp", Buffer.from("M4A \u0000\u0000\u0000\u0000M4A ", "latin1"));
  const sample = Buffer.from("fff22000544553542d41563341", "hex");
  const mdat = box("mdat", sample);
  const sampleEntry = box(codec, Buffer.alloc(28));
  const stsd = box("stsd", uint32(0, 1), sampleEntry);
  const stsz = box("stsz", uint32(0, 0, 1, sample.length));
  const stsc = box("stsc", uint32(0, 1, 1, 1, 1));
  const stco = box("stco", uint32(0, 1, ftyp.length + 8));
  const stbl = box("stbl", stsd, stsz, stsc, stco);
  const moov = box("moov", box("trak", box("mdia", box("minf", stbl))));
  return { data: Buffer.concat([ftyp, mdat, moov]), sample };
}

test("detects an ISO BMFF/M4A payload decrypted from NCM", () => {
  const payload = Buffer.alloc(32);
  payload.writeUInt32BE(24, 0);
  payload.write("ftyp", 4, "latin1");
  payload.write("M4A ", 8, "latin1");

  assert.equal(detectAudioFormat(payload), "m4a");
});

test("inspects and extracts an AV3A sample track from M4A", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-av3a-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const inputPath = path.join(scratch, "input.m4a");
  const outputPath = path.join(scratch, "audio.av3a");
  const fixture = makeMp4();
  await fsp.writeFile(inputPath, fixture.data);

  assert.deepEqual(inspectMp4Audio(fixture.data), { codec: "av3a" });
  const result = await extractAv3aTrack(inputPath, outputPath);

  assert.deepEqual(result, { samples: 1, bytes: fixture.sample.length });
  assert.deepEqual(fs.readFileSync(outputPath), fixture.sample);
});

test("does not mistake an AAC M4A track for AV3A", () => {
  assert.deepEqual(inspectMp4Audio(makeMp4("mp4a").data), { codec: "mp4a" });
});

test("runs the AV3A decoder beside model.bin and returns a WAV", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-av3a-decode-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const helperDir = path.join(scratch, "helper");
  const tempDir = path.join(scratch, "job");
  const decoderPath = path.join(helperDir, "avs3RM0Decoder.exe");
  const inputPath = path.join(scratch, "input.m4a");
  await fsp.mkdir(helperDir, { recursive: true });
  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.writeFile(decoderPath, "test helper");
  await fsp.writeFile(path.join(helperDir, "model.bin"), "test model");
  await fsp.writeFile(inputPath, makeMp4().data);
  let invocation;

  const wavPath = await decodeAv3aM4a(inputPath, tempDir, {
    decoderPath,
    runProcess: async (command, args, options) => {
      invocation = { command, args, options };
      await fsp.writeFile(args[3], "RIFFxxxxWAVE");
    }
  });

  assert.equal(wavPath, path.join(tempDir, "decoded.wav"));
  assert.equal(invocation.command, decoderPath);
  assert.deepEqual(invocation.args, ["-if", path.join(tempDir, "audio.av3a"), "-of", wavPath]);
  assert.equal(invocation.options.cwd, helperDir);
  assert.equal(fs.readFileSync(wavPath, "latin1").slice(0, 4), "RIFF");
});

test("routes only decrypted AV3A M4A audio through the helper", async (t) => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-av3a-route-test-"));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  const nativePath = path.join(scratch, "native.m4a");
  await fsp.writeFile(nativePath, makeMp4().data);
  let decodedInput;

  const result = await prepareDecryptedAudio({ nativePath, format: "m4a", tempDir: scratch }, {
    decode: async (inputPath) => {
      decodedInput = inputPath;
      return path.join(scratch, "decoded.wav");
    }
  });

  assert.equal(decodedInput, nativePath);
  assert.equal(result, path.join(scratch, "decoded.wav"));
  assert.equal(await prepareDecryptedAudio({ nativePath, format: "mp3", tempDir: scratch }), nativePath);
});
