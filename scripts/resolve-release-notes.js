"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveReleaseNotes(tag, repositoryRoot) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }

  const compactVersion = tag.slice(1).replaceAll(".", "");
  const versionedNotes = `docs/release-notes-${compactVersion}.md`;
  return fs.existsSync(path.join(repositoryRoot, versionedNotes))
    ? versionedNotes
    : "docs/RELEASE.md";
}

const tag = process.argv[2];
const repositoryRoot = path.resolve(process.argv[3] || process.cwd());
process.stdout.write(`${resolveReleaseNotes(tag, repositoryRoot)}\n`);
