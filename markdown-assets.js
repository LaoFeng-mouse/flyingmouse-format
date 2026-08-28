"use strict";

const path = require("node:path");

function sanitizeAssetDirectoryName(value) {
  const name = path.basename(String(value || ""));
  if (!name || name === ".assets" || !name.endsWith(".assets")) return "";
  return name;
}

function assetDirectoryNameForMarkdown(markdownPath) {
  const basename = path.basename(markdownPath, path.extname(markdownPath)) || "document";
  return `${basename}.assets`;
}

function rewriteMarkdownAssetReferences(markdown, sourceDirectoryName, targetDirectoryName) {
  const source = sanitizeAssetDirectoryName(sourceDirectoryName);
  const target = sanitizeAssetDirectoryName(targetDirectoryName);
  const text = String(markdown || "");
  if (!source || !target || source === target) return text;
  return text.split(`${source}/`).join(`${target}/`);
}

module.exports = {
  assetDirectoryNameForMarkdown,
  rewriteMarkdownAssetReferences,
  sanitizeAssetDirectoryName
};
