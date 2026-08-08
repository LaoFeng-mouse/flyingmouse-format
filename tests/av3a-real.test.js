const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { convertNcm } = require("../ncm-format");
const { prepareDecryptedAudio } = require("../av3a-format");

const execFileAsync = promisify(execFile);

test("converts real AV3A NCM samples to fully decodable MP3", async (t) => {
  const fixtures = (process.env.FLYINGMOUSE_AV3A_NCM_FIXTURES || "")
    .split(path.delimiter)
    .filter(Boolean);
  const ffmpegPath = process.env.FLYINGMOUSE_FFMPEG_PATH;
  if (fixtures.length === 0 || !ffmpegPath || !process.env.FLYINGMOUSE_AVS3_DECODER_PATH) {
    t.skip("Set FLYINGMOUSE_AV3A_NCM_FIXTURES, FLYINGMOUSE_FFMPEG_PATH and FLYINGMOUSE_AVS3_DECODER_PATH.");
    return;
  }

  for (const fixture of fixtures) {
    const decrypted = await convertNcm(fixture);
    const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "flyingmouse-av3a-real-"));
    const outputPath = path.join(outputDir, `${path.parse(fixture).name}.mp3`);
    try {
      const conversionInput = await prepareDecryptedAudio(decrypted);
      await execFileAsync(ffmpegPath, [
        "-hide_banner", "-y", "-i", conversionInput,
        "-vn", "-codec:a", "libmp3lame", "-q:a", "2", outputPath
      ], { timeout: 30 * 60 * 1000, windowsHide: true });
      await execFileAsync(ffmpegPath, ["-v", "error", "-i", outputPath, "-f", "null", "-"], {
        timeout: 30 * 60 * 1000,
        windowsHide: true
      });
      const stat = await fsp.stat(outputPath);
      assert.ok(stat.size > 100_000, `${path.basename(fixture)} output is unexpectedly small`);
    } finally {
      await fsp.rm(decrypted.tempDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});
