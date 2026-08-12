function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeArtists(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((artist) => {
    if (Array.isArray(artist)) return cleanText(artist[0]);
    if (artist && typeof artist === "object") return cleanText(artist.name || artist.artistName);
    return cleanText(artist);
  }).filter(Boolean).join(" / ");
}

function normalizeNcmMetadata(meta) {
  const source = meta && typeof meta === "object" ? meta : {};
  const metadata = {
    title: cleanText(source.musicName || source.title || source.name),
    artist: normalizeArtists(source.artist || source.artists || source.artistName),
    album: cleanText(source.album || source.albumName)
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value));
}

function buildNcmFfmpegOptions(decrypted, target) {
  const metadata = normalizeNcmMetadata(decrypted?.metadata || decrypted?.meta);
  const canAttachCover = Boolean(decrypted?.coverPath) && ["mp3", "m4a"].includes(target);
  const coverArgs = [];
  if (canAttachCover) {
    coverArgs.push("-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg");
    if (target === "mp3") {
      // 与全局音频转 mp3 对齐用 ID3v2.4（UTF-8 标签）：v2.3 强制 UTF-16，
      // 部分播放器读日文等非 ASCII 标签显示乱码（v0.3.5 审计后修复）。
      coverArgs.push("-id3v2_version", "4");
    }
    coverArgs.push("-disposition:v:0", "attached_pic");
  }
  return {
    extraInputs: canAttachCover ? [decrypted.coverPath] : [],
    metadata,
    coverArgs
  };
}

module.exports = { normalizeNcmMetadata, buildNcmFfmpegOptions };
