const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// LibreOffice creates many nested files below UserInstallation. Node accepting a
// long path is not evidence that LibreOffice's native components can use it.
const MAX_PROFILE_PATH_LENGTH = 160;

function createOfficeWorkspace(options = {}) {
  const io = options.fs || fs;
  const platform = options.platform || process.platform;
  const requireShortPaths = platform === "win32" || options.requireShortPaths === true;
  const fallback = options.profileFallbackRoot || (platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "FlyingMouseFormat", "o")
    : path.join(os.homedir(), ".cache", "flyingmouse-format", "office"));
  const candidates = [...new Set([options.runtimeDir, fallback].filter(Boolean).map(p => path.resolve(p)))];
  const failures = [];
  for (const base of candidates) {
    // Six random characters are appended by mkdtemp, and the profile is /p.
    if (requireShortPaths && path.join(base, "office-XXXXXX", "p").length > MAX_PROFILE_PATH_LENGTH) {
      failures.push({ code: "ENAMETOOLONG", length: base.length });
      continue;
    }
    let root;
    try {
      io.mkdirSync(base, { recursive: true, mode: 0o700 });
      if (!io.lstatSync(base).isDirectory() || io.lstatSync(base).isSymbolicLink()) {
        throw Object.assign(new Error("Office profile parent is not a regular directory"), { code: "EINVAL" });
      }
      // Exclusive creation prevents reuse/deletion of another job's profile.
      root = io.mkdtempSync(path.join(base, "office-"));
      const profileDir = path.join(root, "p");
      io.mkdirSync(profileDir, { mode: 0o700 });
      const probe = path.join(profileDir, ".write-probe");
      io.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
      io.unlinkSync(probe);
      return { root, profileDir, fallback: base === path.resolve(fallback) };
    } catch (error) {
      failures.push({ code: error?.code || "UNKNOWN", length: base.length });
      if (root) { try { io.rmSync(root, { recursive: true, force: true }); } catch { /* retain cleanup failure */ } }
    }
  }
  const error = new Error("No short writable isolated LibreOffice profile directory is available");
  error.code = failures.at(-1)?.code || "EACCES";
  error.profileFailures = failures;
  throw error;
}

module.exports = { createOfficeWorkspace, MAX_PROFILE_PATH_LENGTH };
