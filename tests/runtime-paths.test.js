const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { resolveRuntimePaths } = require("../runtime-paths");

test("Windows runtime paths preserve the packaged x64 engine layout", () => {
  const resourcesPath = "C:\\Program Files\\FlyingMouse Format\\resources";
  const paths = resolveRuntimePaths({ platform: "win32", arch: "x64", resourcesPath });
  assert.equal(paths.ffmpeg, path.join(resourcesPath, "ffmpeg", "ffmpeg.exe"));
  assert.equal(paths.avs3Decoder, path.join(resourcesPath, "avs3", "avs3RM0Decoder.exe"));
  assert.match(paths.libreoffice, /soffice\.com$/);
  assert.match(paths.pdftoppm, /pdftoppm\.exe$/);
  assert.equal(paths.tessdata, path.join(resourcesPath, "tessdata"));
});

for (const arch of ["arm64", "x64"]) {
  test(`macOS ${arch} runtime paths select only the matching native bundle`, () => {
    const resourcesPath = "/Applications/FlyingMouse Format.app/Contents/Resources";
    const paths = resolveRuntimePaths({ platform: "darwin", arch, resourcesPath });
    const engineRoot = path.join(resourcesPath, "engines", `darwin-${arch}`);
    assert.equal(paths.ffmpeg, path.join(engineRoot, "runtime", "bin", "ffmpeg"));
    assert.equal(paths.libreoffice, path.join(engineRoot, "libreoffice", "LibreOffice.app", "Contents", "MacOS", "soffice"));
    assert.equal(paths.pdftoppm, path.join(engineRoot, "runtime", "bin", "pdftoppm"));
    assert.equal(paths.tessdata, path.join(engineRoot, "tessdata"));
    assert.equal(paths.avs3Decoder, null);
    assert.doesNotMatch(Object.values(paths).filter(Boolean).join("\n"), /\.exe|soffice\.com|avs3/i);
  });
}

test("runtime path selection fails closed for unsupported platforms and architectures", () => {
  assert.throws(() => resolveRuntimePaths({ platform: "darwin", arch: "ia32", resourcesPath: "/tmp/resources" }), /Unsupported macOS architecture/);
  assert.throws(() => resolveRuntimePaths({ platform: "linux", arch: "x64", resourcesPath: "/tmp/resources" }), /Unsupported platform/);
});

test("explicit environment overrides win without enabling AV3A on macOS", () => {
  const paths = resolveRuntimePaths({
    platform: "darwin",
    arch: "arm64",
    resourcesPath: "/resources",
    env: {
      FLYINGMOUSE_FFMPEG_PATH: "/custom/ffmpeg",
      FLYINGMOUSE_LIBREOFFICE_PATH: "/custom/soffice",
      FLYINGMOUSE_PDFTOPPM_PATH: "/custom/pdftoppm",
      FLYINGMOUSE_TESSDATA_PATH: "/custom/tessdata",
      FLYINGMOUSE_AVS3_DECODER_PATH: "/malicious/windows-decoder.exe"
    }
  });
  assert.equal(paths.ffmpeg, "/custom/ffmpeg");
  assert.equal(paths.libreoffice, "/custom/soffice");
  assert.equal(paths.pdftoppm, "/custom/pdftoppm");
  assert.equal(paths.tessdata, "/custom/tessdata");
  assert.equal(paths.avs3Decoder, null);
});
