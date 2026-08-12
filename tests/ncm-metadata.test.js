const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  normalizeNcmMetadata,
  buildNcmFfmpegOptions
} = require("../ncm-metadata");
const { detectCoverFormat } = require("../ncm-format");

test("normalizes common NCM metadata shapes", () => {
  assert.deepEqual(normalizeNcmMetadata({
    musicName: "Song",
    artist: [["Mouse", 1], ["Cat", 2]],
    album: "Album"
  }), {
    title: "Song",
    artist: "Mouse / Cat",
    album: "Album"
  });
});

test("builds safe FFmpeg metadata and cover options for MP3", () => {
  const options = buildNcmFfmpegOptions({
    metadata: { title: "Song", artist: "Mouse", album: "Album" },
    coverPath: "cover.png"
  }, "mp3");
  assert.deepEqual(options.extraInputs, ["cover.png"]);
  assert.deepEqual(options.metadata, { title: "Song", artist: "Mouse", album: "Album" });
  assert.deepEqual(options.coverArgs, [
    "-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg",
    "-id3v2_version", "4", "-disposition:v:0", "attached_pic"
  ]);
});

test("does not attach unsupported cover streams while keeping text metadata", () => {
  const options = buildNcmFfmpegOptions({
    metadata: { title: "Song" },
    coverPath: "cover.png"
  }, "ogg");
  assert.deepEqual(options.extraInputs, []);
  assert.deepEqual(options.coverArgs, []);
  assert.equal(options.metadata.title, "Song");
});

test("accepts only recognizable complete PNG and JPEG cover payloads", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).jpeg().toBuffer();
  assert.equal(detectCoverFormat(png), "png");
  assert.equal(detectCoverFormat(jpeg), "jpg");
  assert.equal(detectCoverFormat(Buffer.from("89504e470d0a1a0a00000000", "hex")), null);
  assert.equal(detectCoverFormat(Buffer.from("ffd8ffe00000ffd9", "hex")), null);
  assert.equal(detectCoverFormat(Buffer.from("not-an-image")), null);
});
