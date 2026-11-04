"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createOfficeWorkspace } = require("./office-runtime");
const { throwIfCanceled } = require("./conversion-cancellation");
const MAX_NATIVE_PATH_LENGTH = 200;

// Poppler's native file APIs can reject both an uploaded PDF and its raster
// destination even when Node accepts those paths. Reuse the bounded, exclusive
// workspace policy; callers retain their original names outside this workspace.
async function createPdfRenderWorkspace(inputPath, options = {}) {
  throwIfCanceled(options.signal);
  const { root } = createOfficeWorkspace({
    runtimeDir: options.nativeTempRoot || os.tmpdir(),
    profileFallbackRoot: options.nativeFallbackRoot,
    requireShortPaths: true
  });
  const identity = await fsp.lstat(root);
  const cleanup = async () => {
    const current = await fsp.lstat(root).catch(() => null);
    if (current?.isDirectory() && !current.isSymbolicLink()
      && current.dev === identity.dev && current.ino === identity.ino) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  };
  try {
    const original = path.resolve(inputPath);
    const ownsInput = original.length > MAX_NATIVE_PATH_LENGTH;
    const stagedInput = ownsInput ? path.join(root, "source.pdf") : original;
    if (ownsInput) await fsp.copyFile(original, stagedInput, fs.constants.COPYFILE_EXCL);
    throwIfCanceled(options.signal);
    return { tempDir: root, inputPath: stagedInput, ownsInput, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

module.exports = { createPdfRenderWorkspace, MAX_NATIVE_PATH_LENGTH };
