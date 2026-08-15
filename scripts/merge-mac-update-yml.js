"use strict";

// Merges the per-architecture electron-builder update metadata files
// (latest-mac-arm64.yml / latest-mac-x64.yml) produced by the separate
// macOS matrix jobs into the single latest-mac.yml that electron-updater
// fetches when a user checks for updates on macOS.
//
// Background: release.yml builds macOS DMGs in two parallel matrix jobs
// (`electron-builder --mac dmg --arm64/--x64 --publish never`).  Each job
// writes its own dist/latest-mac.yml that contains only one architecture
// entry.  Uploading either file alone makes update checks 404 for the other
// architecture, and uploading both under the same name makes one silently
// overwrite the other in the merged release assets directory.  This script
// joins the `files` blocks into one metadata file, mirroring what
// electron-builder itself emits for a single multi-architecture build.

const fs = require("node:fs");
const path = require("node:path");

const ARCHES = ["arm64", "x64"];

function inputFileName(arch) {
  return `latest-mac-${arch}.yml`;
}

// Splits electron-builder's update metadata into header, the indented
// `files` list block and the trailing top-level keys.  The YAML is emitted
// by js-yaml with a stable shape:
//
//   version: 0.6.1
//   files:
//     - url: ...
//       sha512: ...
//       size: ...
//   path: ...
//   sha512: ...
//   releaseDate: '...'
function splitParts(text) {
  const lines = text.split("\n");
  let filesStart = -1;
  let filesEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (filesStart === -1) {
      if (lines[i].startsWith("files:")) filesStart = i;
      continue;
    }
    const line = lines[i];
    if (line.trim() === "") continue; // trailing blank lines only
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      filesEnd = i;
      break;
    }
  }
  if (filesStart === -1) {
    throw new Error("cannot locate top-level `files` list in update metadata");
  }
  return {
    header: lines.slice(0, filesStart).join("\n"),
    filesBlock: lines.slice(filesStart + 1, filesEnd).join("\n"),
    tail: lines.slice(filesEnd).join("\n")
  };
}

// Builds the combined latest-mac.yml text from the per-architecture files.
// The first file's header/version and trailing path/sha512 are kept;
// electron-updater resolves artifacts through `files[*].url`.
function mergeUpdateMetadata(inputTexts) {
  const parts = inputTexts.map((text) => splitParts(text));
  const first = parts[0];
  const filesBlocks = parts.map((part) => part.filesBlock.trimEnd()).join("\n");
  const merged = [first.header, "files:", filesBlocks, first.tail].join("\n");
  return merged;
}

function collectArtifactUrls(text) {
  const urls = [];
  for (const match of text.matchAll(/^\s+- url: (.*)$/gm)) {
    urls.push(match[1]);
  }
  return urls;
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const dir = args.find((arg) => !arg.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/merge-mac-update-yml.js <assets-dir> [--check]");
    process.exit(2);
  }

  const present = ARCHES
    .map((arch) => ({ arch, file: path.join(dir, inputFileName(arch)) }))
    .filter((entry) => fs.existsSync(entry.file));

  if (present.length === 0) {
    console.error(`merge-mac-update-yml: no ${ARCHES.map(inputFileName).join(" / ")} found under ${dir}`);
    process.exit(1);
  }

  const outFile = path.join(dir, "latest-mac.yml");

  if (checkOnly) {
    if (!fs.existsSync(outFile)) {
      console.error(`merge-mac-update-yml: ${outFile} does not exist`);
      process.exit(1);
    }
    verify(outFile, present.map((entry) => entry.arch));
    console.log(`merge-mac-update-yml: ${outFile} verified`);
    return;
  }

  const inputTexts = present.map((entry) => fs.readFileSync(entry.file, "utf8"));
  fs.writeFileSync(outFile, mergeUpdateMetadata(inputTexts));
  verify(outFile, present.map((entry) => entry.arch));

  // Remove the staged per-architecture files so `gh release upload
  // release-assets/*` does not publish them as extra release assets.
  for (const entry of present) {
    fs.unlinkSync(entry.file);
  }

  const urls = collectArtifactUrls(fs.readFileSync(outFile, "utf8"));
  console.log(`merge-mac-update-yml: wrote ${outFile} with ${urls.length} artifact(s)`);
}

function verify(outFile, arches) {
  const text = fs.readFileSync(outFile, "utf8");
  const urls = collectArtifactUrls(text);
  for (const arch of arches) {
    if (!urls.some((url) => url.includes(`mac-${arch}.dmg`))) {
      console.error(`merge-mac-update-yml: ${outFile} is missing the ${arch} artifact`);
      process.exit(1);
    }
  }
}

module.exports = { main, mergeUpdateMetadata, splitParts, collectArtifactUrls };

if (require.main === module) {
  main();
}
