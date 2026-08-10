const path = require("node:path");

function override(env, name, fallback) {
  const value = String(env?.[name] || "").trim();
  return value || fallback;
}

function resolveRuntimePaths(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || "");
  const env = options.env || process.env;

  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`Unsupported Windows architecture: ${arch}`);
    return {
      ffmpeg: override(env, "FLYINGMOUSE_FFMPEG_PATH", path.join(resourcesPath, "ffmpeg", "ffmpeg.exe")),
      avs3Decoder: override(env, "FLYINGMOUSE_AVS3_DECODER_PATH", path.join(resourcesPath, "avs3", "avs3RM0Decoder.exe")),
      libreoffice: override(env, "FLYINGMOUSE_LIBREOFFICE_PATH", path.join(resourcesPath, "libreoffice", "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com")),
      pdftoppm: override(env, "FLYINGMOUSE_PDFTOPPM_PATH", path.join(resourcesPath, "poppler", "Library", "bin", "pdftoppm.exe")),
      tessdata: override(env, "FLYINGMOUSE_TESSDATA_PATH", path.join(resourcesPath, "tessdata"))
    };
  }

  if (platform === "darwin") {
    if (!new Set(["arm64", "x64"]).has(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
    const engineRoot = path.join(resourcesPath, "engines", `darwin-${arch}`);
    return {
      ffmpeg: override(env, "FLYINGMOUSE_FFMPEG_PATH", path.join(engineRoot, "runtime", "bin", "ffmpeg")),
      avs3Decoder: null,
      libreoffice: override(env, "FLYINGMOUSE_LIBREOFFICE_PATH", path.join(engineRoot, "libreoffice", "LibreOffice.app", "Contents", "MacOS", "soffice")),
      pdftoppm: override(env, "FLYINGMOUSE_PDFTOPPM_PATH", path.join(engineRoot, "runtime", "bin", "pdftoppm")),
      tessdata: override(env, "FLYINGMOUSE_TESSDATA_PATH", path.join(engineRoot, "tessdata"))
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

module.exports = { resolveRuntimePaths };
